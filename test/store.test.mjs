import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BASELINE_NAME,
  LOCK_NAME,
  StatsStore,
  dedupeRecords,
  parseRecords,
  resolveStoreDir,
} from '../lib/store.js'

const NOW = new Date('2026-09-01T12:00:00').getTime()

function record(overrides) {
  return {
    v: 1, sid: 's1', turn: 1, step: 1, t: NOW,
    prov: 'p', model: 'm',
    tin: 1, cr: 2, cw: 0, out: 3,
    llmMs: 10, ttftMs: 5, decMs: 8, decTk: 3,
    tools: 0, toolMs: 0,
    ...overrides,
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-llm-stats-test-'))
}

/** Basename of a shard path (shardName is absolute). */
function shardBase(store) {
  return store.shardPath.split('/').pop()
}

test('resolveStoreDir follows the harness home precedence', () => {
  const previous = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.equal(resolveStoreDir('/tmp/h1'), '/tmp/h1/llm-stats')
    assert.ok(resolveStoreDir().endsWith('/.dsh/llm-stats'))
    process.env.DSH_HOME = ''
    assert.ok(resolveStoreDir().endsWith('/.dsh/llm-stats'))
    process.env.DSH_HOME = '~/mydsh'
    assert.ok(resolveStoreDir().endsWith('/mydsh/llm-stats'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('parseRecords skips torn and foreign lines', () => {
  const records = parseRecords([
    JSON.stringify(record({})),
    '{torn',
    JSON.stringify({ v: 2, sid: 'future' }),
    '',
    JSON.stringify(record({ sid: 's2', turn: 2 })),
  ].join('\n'))
  assert.equal(records.length, 2)
  assert.equal(records[1].sid, 's2')
})

test('append + readAll round-trips across processes', () => {
  const dir = tempDir()
  try {
    const writer = new StatsStore(dir, { now: () => NOW })
    writer.append(record({}))
    writer.append(record({ step: 2 }))
    writer.close()
    const reader = new StatsStore(dir, { now: () => NOW })
    assert.equal(reader.readAll().length, 2)
    reader.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dedupeRecords is last-wins on (sid, turn, step)', () => {
  const kept = dedupeRecords([record({ out: 1 }), record({ out: 2 }), record({ turn: 2, out: 9 })])
  assert.equal(kept.length, 2)
  assert.equal(kept.find(r => r.turn === 1).out, 2)
})

test('compaction merges dead shards into a sorted baseline and deletes them', () => {
  const dir = tempDir()
  try {
    const dead = new StatsStore(dir, { now: () => NOW, pid: 999_999 })
    dead.append(record({ step: 1 }))
    dead.append(record({ step: 2, t: NOW - 100 }))
    dead.close()
    // Make the dead shard old enough for the idle wall to fire first.
    utimesSync(dead.shardPath, new Date(NOW - 100_000), new Date(NOW - 100_000))
    const live = new StatsStore(dir, { now: () => NOW })
    live.append(record({ step: 3 }))
    const written = live.compact(null)
    assert.equal(written, 2)
    const names = readdirNames(dir)
    assert.ok(names.includes(BASELINE_NAME), names)
    assert.ok(!names.includes(shardBase(dead)), 'dead shard should be deleted')
    assert.ok(names.includes(shardBase(live)), 'live shard must survive')
    const reader = new StatsStore(dir, { now: () => NOW })
    assert.equal(reader.readAll().length, 3)
    reader.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retention drops records older than the cutoff at compaction', () => {
  const dir = tempDir()
  try {
    const store = new StatsStore(dir, { now: () => NOW })
    store.append(record({ t: NOW - 400 * 86_400_000 }))
    store.append(record({ t: NOW - 100 * 86_400_000 }))
    store.close()
    // Backdate the shard: dead-shard detection compares mtime against the
    // fake clock, and a fresh real mtime can sit on either side of it.
    utimesSync(store.shardPath, new Date(NOW - 60_000), new Date(NOW - 60_000))
    const next = new StatsStore(dir, { now: () => NOW, shardDeadMs: 0 })
    next.compact(365)
    const kept = next.readAll()
    assert.equal(kept.length, 1)
    assert.equal(kept[0].t, NOW - 100 * 86_400_000)
    next.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAll and aggregate-scale reads survive a 160K-record shard', () => {
  const dir = tempDir()
  try {
    const store = new StatsStore(dir, { now: () => NOW })
    const lines = []
    for (let i = 0; i < 160_000; i += 1) {
      lines.push(JSON.stringify(record({ turn: Math.floor(i / 100), step: i % 100 })))
    }
    writeFileSync(join(dir, 'records.bulk.jsonl'), `${lines.join('\n')}\n`)
    store.close()
    const reader = new StatsStore(dir, { now: () => NOW })
    const all = reader.readAll()
    assert.equal(all.length, 160_000)
    reader.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a healthy lock held elsewhere skips the compaction round', () => {
  const dir = tempDir()
  try {
    const store = new StatsStore(dir, { now: () => NOW })
    store.append(record({}))
    store.close()
    mkdirSync(join(dir, LOCK_NAME))
    // Fresh relative to the fake clock (real mtime would look hours stale).
    utimesSync(join(dir, LOCK_NAME), new Date(NOW), new Date(NOW))
    const next = new StatsStore(dir, { now: () => NOW, shardDeadMs: 0 })
    assert.equal(next.compact(null), 0)
    next.close()
    assert.ok(readdirNames(dir).includes(LOCK_NAME), 'foreign lock must stay')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale lock is taken over', () => {
  const dir = tempDir()
  try {
    const lock = join(dir, LOCK_NAME)
    mkdirSync(lock)
    utimesSync(lock, new Date(NOW - 20 * 60_000), new Date(NOW - 20 * 60_000))
    const store = new StatsStore(dir, { now: () => NOW })
    store.append(record({}))
    store.close()
    utimesSync(store.shardPath, new Date(NOW - 60_000), new Date(NOW - 60_000))
    const next = new StatsStore(dir, { now: () => NOW, shardDeadMs: 0 })
    assert.equal(next.compact(null), 1)
    next.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function readdirNames(dir) {
  return readdirSync(dir)
}
