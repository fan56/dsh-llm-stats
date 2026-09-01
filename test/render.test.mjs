import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregate, rangeWindow } from '../lib/aggregate.js'
import { cacheHitPercent, formatDate, formatDateRange, formatDuration, formatTokens, renderHelp, renderReport, renderBars } from '../lib/render.js'

const NOW = new Date('2026-09-01T12:00:00').getTime()

function record(overrides) {
  return {
    v: 1, sid: 's1', turn: 1, step: 1, t: NOW,
    prov: 'p', model: 'glm-4.6',
    tin: 1000, cr: 8000, cw: 200, out: 500,
    llmMs: 65_000, ttftMs: 1200, decMs: 50_000, decTk: 500,
    tools: 2, toolMs: 90_000,
    ...overrides,
  }
}

test('formatTokens compacts like the web stats strip', () => {
  assert.equal(formatTokens(517), '517')
  assert.equal(formatTokens(12_200), '12.2K')
  assert.equal(formatTokens(517_000), '517K')
  assert.equal(formatTokens(999_950), '1M')
  assert.equal(formatTokens(1_200_000), '1.2M')
})

test('formatDuration walks seconds → minutes → hours', () => {
  assert.equal(formatDuration(45_200), '45.2s')
  assert.equal(formatDuration(162_000), '2m42s')
  assert.equal(formatDuration(11_520_000), '3h12m')
})

test('cacheHitPercent follows the CH convention', () => {
  assert.equal(cacheHitPercent({ cr: 8000, tin: 1000, cw: 200 }), 87)
  assert.equal(cacheHitPercent({ cr: 0, tin: 0, cw: 0 }), null)
})

test('formatDateRange labels the inclusive window', () => {
  const start = new Date('2026-08-26T00:00:00').getTime()
  assert.equal(formatDateRange(start, NOW + 1), 'Aug 26 – Sep 1')
  assert.equal(formatDate(NOW), 'Sep 1')
  const yearAgo = new Date('2025-09-02T00:00:00').getTime()
  assert.equal(formatDateRange(yearAgo, NOW + 1), 'Sep 2, 2025 – Sep 1, 2026')
})

test('the report renders header, totals, models, and bars', () => {
  const records = [
    record({}),
    record({ step: 2, model: 'deepseek-chat', tin: 100, cr: 0, cw: 0, out: 40, decTk: 40 }),
  ]
  const report = renderReport('week', aggregate(records, rangeWindow('week', NOW)))
  assert.ok(report.startsWith('## 📊 LLM stats · last 7 days (Aug 26 – Sep 1)'), report)
  assert.ok(report.includes('| ⚡ Sessions | 💬 Turns | 📡 Requests | 👣 Steps |'), report)
  assert.ok(report.includes('| 1 | 1 | 2 | 2 |'), report)
  assert.ok(report.includes('| 📥 In | 🔥 Cache hit | 📤 Out | 🧮 Total |'), report)
  assert.ok(report.includes('| 9.3K | 86% | 540 | 9.8K |'), report)
  assert.ok(report.includes('⏱ Model 2m10s · 🔧 Tools 3m0s · 🚀 TTFT 1.2s · ⚡ 5.4 tok/s'), report)
  assert.ok(report.includes('## 🤖 By model'), report)
  assert.ok(report.includes('| Model | 📥 In | 📤 Out | 🔥 Cache | 📡 Req |'), report)
  assert.ok(report.includes('| glm-4.6 | 9.2K | 500 | 87% | 1 |'), report)
  assert.ok(report.includes('| deepseek-chat | 100 | 40 | 0% | 1 |'), report)
  assert.ok(report.includes('## 📈 Activity'), report)
  assert.ok(report.includes(`| Sep 1 | 1.6K | ${'▇'.repeat(24)} |`), report)
})

test('by-model drops no-usage rows and notes models beyond eight', () => {
  const records = [record({})]
  for (let m = 0; m < 9; m += 1) {
    records.push(record({ step: m + 2, model: `m-${m}`, tin: 100 + m, cr: 0, cw: 0, out: 10, decTk: 10 }))
  }
  records.push(record({ step: 100, model: 'no-usage', tin: null, cr: null, cw: null, out: null, llmMs: null, ttftMs: null, decMs: null, decTk: null }))
  const report = renderReport('day', aggregate(records, rangeWindow('day', NOW)))
  assert.ok(!report.includes('no-usage'), report)
  assert.ok(report.includes('+2 more models'), report)
})

test('by-model section is omitted when every model row is zero-usage noise', () => {
  // aggregate.ts bills a request only when at least one token bucket is
  // non-null — all-null records keep steps/turns but leave requests at 0,
  // so every model row here is pure noise and the section must vanish.
  const records = [
    record({ tin: null, cr: null, cw: null, out: null, llmMs: null, ttftMs: null, decMs: null, decTk: null }),
    record({ sid: 's2', model: 'deepseek-chat', tin: null, cr: null, cw: null, out: null, llmMs: null, ttftMs: null, decMs: null, decTk: null }),
  ]
  const report = renderReport('day', aggregate(records, rangeWindow('day', NOW)))
  assert.ok(!report.includes('By model'), report)
  assert.ok(report.includes('| ⚡ Sessions | 💬 Turns | 📡 Requests | 👣 Steps |'), report)
  assert.ok(report.includes('| 2 | 2 | 0 | 2 |'), report)
})

test('the help screen shows usage, config, and ledger coverage', () => {
  const empty = renderHelp({ mode: 'on', retentionDays: 365 }, { steps: 0, earliest: null })
  assert.match(empty, /Usage:/)
  assert.ok(!empty.includes('| ---'), 'help must never carry a markdown table separator')
  assert.match(empty, /\/llm-stats 12m\s+last 12 months/)
  assert.match(empty, /mode on · retention 365 days/)
  assert.match(empty, /ledger empty/)
  const started = renderHelp({ mode: 'off', retentionDays: 30 }, { steps: 1234, earliest: new Date('2026-08-14T00:00:00').getTime() })
  assert.match(started, /mode off · retention 30 days/)
  assert.match(started, /1,234 steps recorded since Aug 14/)
})

test('an empty window renders the no-activity line', () => {
  const report = renderReport('day', aggregate([], rangeWindow('day', NOW)))
  assert.equal(report, '📭 LLM stats · today (Sep 1): no activity recorded.')
})

test('bars become table rows scaled to the max bucket, weekly folds labeled', () => {
  const bars = [
    { t: NOW, end: NOW + 86_400_000, tokens: 100 },
    { t: NOW - 86_400_000, end: NOW, tokens: 50 },
    { t: NOW - 2 * 86_400_000, end: NOW - 86_400_000, tokens: 0 },
  ]
  const rows = renderBars(bars)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].date, 'Sep 1')
  assert.equal(rows[0].tokens, 100)
  assert.equal(rows[0].bar, '▇'.repeat(24))
  assert.equal(rows[1].bar, '▇'.repeat(12))
  assert.equal(rows[2].bar, '')
  const weekly = renderBars([
    { t: NOW, end: NOW + 7 * 86_400_000, tokens: 100 },
    { t: NOW - 7 * 86_400_000, end: NOW, tokens: 60 },
  ])
  assert.ok(weekly[1].date.includes('–'), weekly[1].date)
  assert.equal(weekly[1].tokens, 60)
})
