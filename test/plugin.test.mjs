import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatsStore } from '../lib/store.js'
import { apply, resolveConfig } from '../lib/index.js'

let seq = 0

function event(type, time, data) {
  seq += 1
  return { type, seq, time, data }
}

const SID = '11111111-1111-1111-1111-111111111111'
const NOW = new Date('2026-09-01T12:00:00').getTime()

/** Wire the plugin against a stub cordis context with a private ledger dir. */
function harness(config = {}, now = () => new Date('2026-09-01T12:00:00').getTime()) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-llm-stats-plugin-'))
  const listeners = {}
  const commands = []
  const effects = []
  const ctx = {
    on(name, fn) {
      listeners[name] = fn
      return () => delete listeners[name]
    },
    commands: {
      register(def) {
        commands.push(def)
        return () => {}
      },
    },
    effect(fn) {
      effects.push(fn)
    },
  }
  apply(ctx, config, { now, createStore: () => makeStore(dir, now) })
  effects[0]()
  const cleanup = () => {
    effects[1]?.()
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, listeners, commands, handler: commands[0].handler, effects, cleanup }
}

function makeStore(dir, now) {
  return new StatsStore(dir, { now })
}

test('resolveConfig defaults and rejects', () => {
  assert.deepEqual(resolveConfig(undefined), { mode: 'on', retentionDays: 365 })
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown key/)
  assert.throws(() => resolveConfig({ retentionDays: 3 }), /retentionDays/)
  assert.throws(() => resolveConfig({ defaultRange: 'week' }), /unknown key/)
  assert.throws(() => resolveConfig({ mode: 'maybe' }), /mode/)
})

test('the plugin registers the command and records step records', async () => {
  const h = harness()
  try {
    assert.equal(h.commands.length, 1)
    assert.equal(h.commands[0].name, 'llm-stats')
    const listener = h.listeners['session/event']
    assert.equal(typeof listener, 'function')
    listener({ id: SID }, event('request/context', NOW - 600, { provider: 'zai', model: 'glm-4.6' }))
    listener({ id: SID }, event('step/start', NOW - 500, { turn: 1, step: 1 }))
    listener({ id: SID }, event('assistant/message', NOW - 100, { turn: 1, step: 1, message: {}, usage: { inputTokens: 100, outputTokens: 20 } }))
    listener({ id: SID }, event('step/end', NOW - 50, { turn: 1, step: 1 }))
    const result = await h.handler({ rawInput: 'day', signal: new AbortController().signal })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /\| 1 \| 1 \| 1 \| 1 \|/)
    assert.match(result.text, /glm-4\.6/)
  } finally {
    h.cleanup()
  }
})

test('a bare invocation renders help with config and ledger coverage', async () => {
  const h = harness()
  try {
    const result = await h.handler({ rawInput: '', signal: new AbortController().signal })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Usage:/)
    assert.match(result.text, /\/llm-stats week/)
    assert.match(result.text, /mode on · retention 365 days/)
    assert.match(result.text, /ledger empty/)
    // Record one step, and the help no longer claims an empty ledger.
    const listener = h.listeners['session/event']
    const NOW = new Date('2026-09-01T12:00:00').getTime()
    listener({ id: 'sid-1', requestContext: () => undefined }, event('request/context', NOW - 600, { provider: 'zai', model: 'glm-4.6' }))
    listener({ id: 'sid-1', requestContext: () => undefined }, event('step/start', NOW - 500, { turn: 1, step: 1 }))
    listener({ id: 'sid-1', requestContext: () => undefined }, event('step/end', NOW - 100, { turn: 1, step: 1 }))
    const after = await h.handler({ rawInput: '', signal: new AbortController().signal })
    assert.match(after.text, /1 step recorded since/)
  } finally {
    h.cleanup()
  }
})

test('d/w/m resolve as short aliases for day/week/month', async () => {
  const h = harness()
  try {
    const NOW = new Date('2026-09-01T12:00:00').getTime()
    const listener = h.listeners['session/event']
    listener({ id: 'sid-1', requestContext: () => undefined }, event('request/context', NOW - 600, { provider: 'zai', model: 'glm-4.6' }))
    listener({ id: 'sid-1', requestContext: () => undefined }, event('step/start', NOW - 500, { turn: 1, step: 1 }))
    listener({ id: 'sid-1', requestContext: () => undefined }, event('assistant/message', NOW - 300, { turn: 1, step: 1, message: {}, usage: { inputTokens: 10, outputTokens: 4 } }))
    listener({ id: 'sid-1', requestContext: () => undefined }, event('step/end', NOW - 100, { turn: 1, step: 1 }))
    const day = await h.handler({ rawInput: 'd', signal: new AbortController().signal })
    assert.match(day.text, /today/)
    assert.match(day.text, /\| 1 \| 1 \| 1 \| 1 \|/)
    const week = await h.handler({ rawInput: 'w', signal: new AbortController().signal })
    assert.match(week.text, /last 7 days/)
    const month = await h.handler({ rawInput: 'm', signal: new AbortController().signal })
    assert.match(month.text, /last 30 days/)
  } finally {
    h.cleanup()
  }
})

test('an unknown range answers with usage, not a throw', async () => {
  const h = harness()
  try {
    const result = await h.handler({ rawInput: 'fortnight', signal: new AbortController().signal })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /Unknown range/)
  } finally {
    h.cleanup()
  }
})

test('mode off stops recording but keeps the command', async () => {
  const h = harness({ mode: 'off' })
  try {
    assert.equal(h.listeners['session/event'], undefined)
    const result = await h.handler({ rawInput: 'week', signal: new AbortController().signal })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /no activity recorded/)
  } finally {
    h.cleanup()
  }
})

test('fold failures never reach the session', () => {
  const h = harness()
  try {
    const listener = h.listeners['session/event']
    assert.doesNotThrow(() => {
      listener({ id: '' }, event('step/start', 1, { turn: 1, step: 1 }))
      listener(undefined, event('step/end', 2, { turn: 1, step: 1 }))
    })
  } finally {
    h.cleanup()
  }
})
