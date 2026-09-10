import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionFold } from '../lib/fold.js'

let seq = 0

/** Build a SessionEvent-shaped plain object (tests need no dsh runtime). */
function event(type, time, data) {
  seq += 1
  return { type, seq, time, data }
}

const SID = 's-1'

function startedFold() {
  const fold = new SessionFold()
  fold.fold(SID, event('session/end-seed', 1000, {}))
  fold.fold(SID, event('request/context', 1010, { provider: 'zai', model: 'glm-4.6', contextWindow: 200_000 }))
  fold.fold(SID, event('step/start', 1100, { turn: 1, step: 1 }))
  return fold
}

test('a fully billed step folds into a complete record', () => {
  const fold = startedFold()
  fold.fold(SID, event('assistant/chunk', 1250, { chunk: { type: 'text-delta', text: 'he' } }))
  fold.fold(SID, event('assistant/chunk', 1251, { chunk: { type: 'text-delta', text: 'llo' } }))
  fold.fold(SID, event('tool/call', 1300, { turn: 1, step: 1, callId: 'c1', name: 'fs.read', arguments: '{}' }))
  // The host puts the correlation id on message.source.callId (upstream shape).
  fold.fold(SID, event('tool/result', 1400, { turn: 1, step: 1, callId: 'c1', message: { role: 'tool', content: [], source: { callId: 'c1' } } }))
  fold.fold(SID, event('assistant/message', 1500, {
    turn: 1, step: 1, message: {},
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 10 },
  }))
  const record = fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
  assert.deepEqual(record, {
    v: 1, sid: SID, turn: 1, step: 1, t: 1600,
    prov: 'zai', model: 'glm-4.6',
    tin: 100, cr: 900, cw: 10, out: 50,
    llmMs: 400, ttftMs: 150, decMs: 250, decTk: 50,
    tools: 1, toolMs: 100,
  })
})

test('the authoritative session route seeds attribution without request/context', () => {
  const fold = new SessionFold()
  fold.fold(SID, event('step/start', 1100, { turn: 1, step: 1 }), { provider: 'seeded', model: 'route-1' })
  fold.fold(SID, event('assistant/message', 1200, { turn: 1, step: 1, message: {}, usage: { inputTokens: 5, outputTokens: 5 } }))
  const record = fold.fold(SID, event('step/end', 1300, { turn: 1, step: 1 }))
  assert.equal(record.prov, 'seeded')
  assert.equal(record.model, 'route-1')
})

test('usage fields are guarded against NaN and negatives', () => {
  const fold = startedFold()
  fold.fold(SID, event('assistant/message', 1500, {
    turn: 1, step: 1, message: {},
    usage: { inputTokens: Number.NaN, outputTokens: -5, cacheReadTokens: 900 },
  }))
  const record = fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
  assert.equal(record.tin, 0)
  assert.equal(record.out, 0)
  assert.equal(record.cr, 900)
})

test('an empty delta chunk does not start the TTFT window; a retry never resets it', () => {
  const fold = startedFold()
  fold.fold(SID, event('assistant/chunk', 1150, { chunk: { type: 'text-delta', text: '' } }))
  fold.fold(SID, event('llm/retry', 1200, { turn: 1, step: 1 }))
  fold.fold(SID, event('assistant/chunk', 1300, { chunk: { type: 'reasoning-delta', text: 'think' } }))
  fold.fold(SID, event('assistant/message', 1500, { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 2 } }))
  const record = fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
  assert.equal(record.ttftMs, 200)
  assert.equal(record.decMs, 200)
})

test('a tool-call delta starts the TTFT window', () => {
  const fold = startedFold()
  fold.fold(SID, event('assistant/chunk', 1200, { chunk: { type: 'tool-call-delta', name: 'fs', argumentsDelta: '' } }))
  fold.fold(SID, event('assistant/message', 1500, { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 2 } }))
  const record = fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
  assert.equal(record.ttftMs, 100)
})

test('V3 settlements carry the TTFT in their embedded stream; a failed attempt counts', () => {
  const fold = startedFold()
  // A settled attempt that produced no surface message (retried away) whose
  // stream already produced a token at t=1200 — the old live-chunk semantics
  // kept that token, and the embedded stream preserves it.
  fold.fold(SID, event('assistant/attempt', 1450, {
    turn: 1, step: 1,
    stream: [{ type: 'text-chunks', time0: 1200, index: 0, dt: [0, 30], texts: ['he', 'llo'] }],
  }))
  fold.fold(SID, event('assistant/message', 1500, {
    turn: 1, step: 1, message: {},
    stream: [{ type: 'text-chunks', time0: 1460, index: 1, dt: [0], texts: ['!'] }],
    usage: { inputTokens: 100, outputTokens: 50 },
  }))
  const record = fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
  assert.equal(record.ttftMs, 100) // the attempt stream wins: 1200 - 1100
  assert.equal(record.tin, 100)
})

test('a stream-less message leaves TTFT null and never throws', () => {
  const fold = startedFold()
  fold.fold(SID, event('assistant/message', 1500, { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 2 } }))
  const record = fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
  assert.equal(record.ttftMs, null)
  assert.equal(record.tin, 1)
})

test('a failed step records null tokens and timings but still lands a line', () => {
  const fold = startedFold()
  const record = fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
  assert.equal(record.tin, null)
  assert.equal(record.out, null)
  assert.equal(record.llmMs, null)
  assert.equal(record.ttftMs, null)
  assert.equal(record.decMs, null)
  assert.equal(record.decTk, null)
  assert.equal(record.tools, 0)
})

test('a usage-less message yields null token buckets but model time', () => {
  const fold = startedFold()
  fold.fold(SID, event('assistant/chunk', 1200, { chunk: { type: 'text-delta', text: 'x' } }))
  fold.fold(SID, event('assistant/message', 1500, { turn: 1, step: 1, message: {} }))
  const record = fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
  assert.equal(record.tin, null)
  assert.equal(record.llmMs, 400)
  assert.equal(record.decMs, null)
})

test('unresolved tool calls are dropped; a top-level callId on tool/result does not pair', () => {
  const fold = startedFold()
  fold.fold(SID, event('tool/call', 1200, { turn: 1, step: 1, callId: 'lost', name: 'x', arguments: '' }))
  // A result whose message carries a different source id never pairs.
  fold.fold(SID, event('tool/result', 1300, { turn: 1, step: 1, callId: 'lost', message: { role: 'tool', content: [], source: { callId: 'other' } } }))
  fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
})

test('steps before any request/context attribute to unknown', () => {
  const fold = new SessionFold()
  fold.fold(SID, event('step/start', 1100, { turn: 1, step: 1 }))
  fold.fold(SID, event('assistant/message', 1200, { turn: 1, step: 1, message: {}, usage: { inputTokens: 5, outputTokens: 5 } }))
  const record = fold.fold(SID, event('step/end', 1300, { turn: 1, step: 1 }))
  assert.equal(record.prov, 'unknown')
  assert.equal(record.model, 'unknown')
})

test('a route change mid-session applies to later steps only', () => {
  const fold = startedFold()
  fold.fold(SID, event('assistant/message', 1500, { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 1 } }))
  const first = fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
  fold.fold(SID, event('request/context', 2000, { provider: 'other', model: 'm2' }))
  fold.fold(SID, event('step/start', 2100, { turn: 2, step: 1 }))
  fold.fold(SID, event('assistant/message', 2200, { turn: 2, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 1 } }))
  const second = fold.fold(SID, event('step/end', 2300, { turn: 2, step: 1 }))
  assert.equal(first.model, 'glm-4.6')
  assert.equal(second.model, 'm2')
})

test('a step/end without a seen step/start emits nothing', () => {
  const fold = new SessionFold()
  assert.equal(fold.fold(SID, event('step/end', 1600, { turn: 9, step: 9 })), null)
})

test('alpha.3 request/header events (reason series, startsSeries) fold as no-ops', () => {
  // dsh 0.1.2-alpha.3 extended `request/header` with reason 'series' and the
  // optional startsSeries marker (packages/core/session types). The fold must
  // treat the whole log-only header vocabulary as irrelevant: no throw, no
  // record, and no disturbance of the open step or its attribution.
  const fold = startedFold()
  assert.equal(fold.fold(SID, event('request/header', 1150, {
    header: { provider: 'zai', model: 'glm-4.6' },
    reason: 'series',
    startsSeries: true,
  })), null)
  assert.equal(fold.fold(SID, event('request/header', 1151, {
    header: { provider: 'zai', model: 'glm-4.6' },
    reason: 'change',
  })), null)
  fold.fold(SID, event('assistant/chunk', 1250, { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'ok' } }))
  fold.fold(SID, event('assistant/message', 1500, { turn: 1, step: 1, message: {}, usage: { inputTokens: 10, outputTokens: 4 } }))
  const record = fold.fold(SID, event('step/end', 1600, { turn: 1, step: 1 }))
  assert.equal(record.prov, 'zai')
  assert.equal(record.model, 'glm-4.6')
  assert.equal(record.ttftMs, 150) // the 1250 chunk is still the first token (1250 - step/start 1100)
  assert.equal(record.tin, 10)
})

test('malformed shapes never throw and never emit', () => {
  const fold = new SessionFold()
  assert.equal(fold.fold('', event('step/start', 1, { turn: 1, step: 1 })), null)
  assert.equal(fold.fold(SID, null), null)
  assert.equal(fold.fold(SID, { type: 'step/start', seq: 1, time: 1 }), null)
  assert.equal(fold.fold(SID, { type: 'step/start', seq: 2, time: 2, data: { turn: 'x', step: 1 } }), null)
})

test('sessions are tracked independently and eviction stays bounded', () => {
  const fold = new SessionFold()
  fold.fold('a', event('request/context', 1000, { provider: 'p', model: 'm' }))
  fold.fold('b', event('step/start', 1000, { turn: 1, step: 1 }))
  fold.fold('b', event('step/end', 1100, { turn: 1, step: 1 }))
  const fromA = new SessionFold()
  assert.equal(fold.fold('a', event('step/start', 1000, { turn: 1, step: 1 })), null)
  for (let i = 0; i < 300; i += 1) {
    const sid = `burst-${i}`
    fold.fold(sid, event('step/start', 1000, { turn: 1, step: 1 }))
    assert.notEqual(fold.fold(sid, event('step/end', 1100, { turn: 1, step: 1 })), null)
  }
})
