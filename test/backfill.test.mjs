import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames, decodeLogLines, toFoldEvent, foldSessionLog, discoverSessionLogs, runBackfill } from '../lib/backfill.js'
import { StatsStore } from '../lib/store.js'

const NOW = new Date('2026-09-01T12:00:00').getTime()

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-llm-stats-backfill-'))
}

function tempHome() {
  const home = tempDir()
  mkdirSync(join(home, 'sessions', 'proj-a'), { recursive: true })
  return home
}

/** A real zstd container: two frames (header batch + event batch). */
function makeLog(home, id, eventRows, { compress = true, seedLength } = {}) {
  const header = { type: 'session', version: 0, id, createdAt: NOW, cwd: '/tmp/p', ...(seedLength !== undefined ? { seedLength } : {}) }
  const jsonl = [JSON.stringify(header), ...eventRows.map(r => JSON.stringify(r))].join('\n') + '\n'
  const dir = join(home, 'sessions', 'proj-a', id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, compress ? 'session.jsonl.zstd' : 'session.jsonl')
  // Two batches → two frames in one container.
  writeFileSync(path, compress ? Buffer.concat([zstdCompressSync(jsonl.slice(0, 40)), zstdCompressSync(jsonl.slice(40))]) : jsonl)
  return path
}

let seq = 0
function row(type, time, data, extra = {}) {
  seq += 1
  return { type, seq, time, data, ...extra }
}

const RC = { provider: 'zai', model: 'glm-4.6' }

test('scanZstdFrames finds both frames of a concatenated container', () => {
  const a = zstdCompressSync(Buffer.from('A'.repeat(5000)))
  const b = zstdCompressSync(Buffer.from('B'.repeat(5000)))
  const frames = scanZstdFrames(Buffer.concat([a, b]))
  assert.equal(frames.length, 2)
  const first = zstdDecompressSync(Buffer.concat([a, b]).subarray(...frames[0])).toString()
  assert.equal(first, 'A'.repeat(5000))
})

test('decodeLogLines returns every line and ignores a torn tail', () => {
  const text = '{"a":1}\n{"b":2}\n'
  // A genuinely torn tail: frame magic + a truncated frame header.
  const container = Buffer.concat([zstdCompressSync(text), Buffer.from([0x28, 0xB5, 0x2F, 0xFD, 0x00, 0x00])])
  const lines = decodeLogLines(container)
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
})

test('toFoldEvent passes envelopes and synthesizes first-token chunks from packed rows', () => {
  const pass = toFoldEvent(row('step/end', 5, { turn: 1, step: 1 }))
  assert.equal(pass.type, 'step/end')
  const packed = toFoldEvent({ type: 'text-chunks', seq0: 10, time0: 1234, data: { turn: 1, step: 1, texts: ['hello'] } })
  assert.equal(packed.type, 'assistant/chunk')
  assert.equal(packed.time, 1234)
  assert.equal(isTokenDeltaLike(packed.data.chunk), true)
  const toolRun = toFoldEvent({ type: 'tool-call-chunks', seq0: 11, time0: 1300, data: { turn: 1, step: 1 } })
  assert.equal(isTokenDeltaLike(toolRun.data.chunk), true)
  assert.equal(toFoldEvent({ type: 'session', id: 'x' }), null)
  assert.equal(toFoldEvent({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }), null)
})

function isTokenDeltaLike(chunk) {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== ''
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta !== '' || chunk.name !== undefined
  return false
}

function fullSessionRows() {
  return [
    row('request/context', 1000, RC),
    row('step/start', 1100, { turn: 1, step: 1 }),
    { type: 'text-chunks', seq0: 100, time0: 1250, data: { turn: 1, step: 1, texts: ['hi'] } },
    row('tool/call', 1300, { turn: 1, step: 1, callId: 'c1', name: 'fs.read', arguments: '{}' }),
    { type: 'tool-call-chunks', seq0: 130, time0: 1310, data: { turn: 1, step: 1 } },
    row('tool/result', 1400, { turn: 1, step: 1, callId: 'c1', message: { role: 'tool', content: [], source: { callId: 'c1' } } }),
    row('assistant/message', 1500, { turn: 1, step: 1, message: {}, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 } }),
    row('step/end', 1600, { turn: 1, step: 1 }),
  ]
}

test('foldSessionLog folds a full session with packed chunks', () => {
  const sid = '11111111-1111-1111-1111-111111111111'
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id: sid, createdAt: 900 }),
    ...fullSessionRows().map(r => JSON.stringify(r)),
  ]
  const records = foldSessionLog(sid, lines)
  assert.equal(records.length, 1)
  assert.equal(records[0].sid, sid)
  assert.equal(records[0].model, 'glm-4.6')
  assert.equal(records[0].tin, 100)
  assert.equal(records[0].out, 50)
  assert.equal(records[0].ttftMs, 150)
  assert.equal(records[0].tools, 1)
  assert.equal(records[0].toolMs, 100)
})

test('seed history is skipped via the header seedLength, resume markers ignored', () => {
  const sid = '22222222-2222-2222-2222-222222222222'
  // Parent history replayed into a child log: seed rows at seq 0..1,
  // header seedLength 2, then the child's own live rows at seq 10+.
  // A later resume appended a fresh end-seed marker (seq 50) which must NOT
  // raise the boundary — the pre-resume rows are the session's own work.
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id: sid, createdAt: 900, seedLength: 2 }),
    JSON.stringify({ type: 'step/start', seq: 0, time: 100, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'step/end', seq: 1, time: 200, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'session/end-seed', seq: 50, time: 900, data: {} }),
    JSON.stringify(row('step/start', 1100, { turn: 2, step: 1 }, { seq: 60 })),
    JSON.stringify(row('assistant/message', 1200, { turn: 2, step: 1, message: {}, usage: { inputTokens: 5, outputTokens: 5 } }, { seq: 61 })),
    JSON.stringify(row('step/end', 1300, { turn: 2, step: 1 }, { seq: 62 })),
  ]
  const records = foldSessionLog(sid, lines)
  assert.equal(records.length, 1)
  assert.equal(records[0].turn, 2)
})

test('runBackfill appends qualifying records and marks the done-ledger', async () => {
  const home = tempHome()
  const dir = join(home, 'llm-stats')
  try {
    const sid1 = '33333333-3333-3333-3333-333333333331'
    const sid2 = '33333333-3333-3333-3333-333333333332'
    makeLog(home, sid1, fullSessionRows().map((r, i) => ({ ...r, time: r.time === undefined ? r.time : NOW - 86_400_000 + i })))
    makeLog(home, sid2, [])
    const store = new StatsStore(dir, { now: () => NOW })
    const outcome = await runBackfill({ store, retentionDays: 365, dshHome: home, now: () => NOW })
    assert.equal(outcome.scanned, 2)
    assert.equal(outcome.backfilled, 1)
    assert.equal(outcome.empty, 1)
    assert.equal(outcome.records, 1)
    // Second pass: everything already known.
    const again = await runBackfill({ store, retentionDays: 365, dshHome: home, now: () => NOW })
    assert.equal(again.known, 2)
    assert.equal(again.records, 0)
    // The backfill shard is visible to the reader.
    assert.equal(store.readAll().length, 1)
    store.close()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('runBackfill skips sessions written before the retention cutoff', async () => {
  const home = tempHome()
  const dir = join(home, 'llm-stats')
  try {
    const path = makeLog(home, '44444444-4444-4444-4444-444444444444', fullSessionRows())
    utimesSync(path, new Date(NOW - 400 * 86_400_000), new Date(NOW - 400 * 86_400_000))
    const store = new StatsStore(dir, { now: () => NOW })
    const outcome = await runBackfill({ store, retentionDays: 365, dshHome: home, now: () => NOW })
    assert.equal(outcome.scanned, 0)
    assert.equal(outcome.records, 0)
    store.close()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('real-log smoke: the largest live sessions yield records', () => {
  let files = []
  try {
    files = execSync('ls -S ~/.dsh/sessions/*/*/session.jsonl.zstd 2>/dev/null | head -5').toString().trim().split('\n').filter(Boolean)
  } catch {
    files = []
  }
  if (files.length === 0) return // no live home on this machine (CI)
  let total = 0
  for (const file of files) {
    const sid = file.split('/').slice(-2)[0]
    total += foldSessionLog(sid, decodeLogLines(readFileSync(file))).length
  }
  assert.ok(total > 0, 'the largest real sessions should yield records overall')
})
