import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregate, rangeWindow } from '../lib/aggregate.js'
import { cacheHitPercent, formatDate, formatDateRange, formatDuration, formatTokens, renderReport, renderBars } from '../lib/render.js'

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
})

test('the report renders header, totals, models, and bars', () => {
  const records = [
    record({}),
    record({ step: 2, model: 'deepseek-chat', tin: 100, cr: 0, cw: 0, out: 40, decTk: 40 }),
  ]
  const report = renderReport('week', aggregate(records, rangeWindow('week', NOW)))
  const lines = report.split('\n')
  assert.ok(lines[0].startsWith('LLM stats · last 7 days (Aug 26 – Sep 1)'), lines[0])
  assert.ok(report.includes('Sessions 1 · Turns 1 · Requests 2 · Steps 2'), report)
  assert.ok(report.includes('in 9.3K'), report)
  assert.ok(report.includes('cache hit 86%'), report)
  assert.ok(report.includes('out 540'), report)
  assert.ok(report.includes('total 9.8K'), report)
  assert.ok(report.includes('model 2m10s'), report)
  assert.ok(report.includes('tools 3m0s'), report)
  assert.ok(report.includes('avg TTFT 1.2s'), report)
  assert.ok(report.includes('5.4 tok/s'), report)
  assert.ok(report.includes('By model'), report)
  assert.ok(report.includes('glm-4.6'), report)
  assert.ok(report.includes('Sep 1 ▇'), report)
})

test('an empty window renders the no-activity line', () => {
  const report = renderReport('day', aggregate([], rangeWindow('day', NOW)))
  assert.match(report, /no activity recorded/)
})

test('bars scale to the max bucket and label weekly folds', () => {
  const bars = [
    { t: NOW, end: NOW + 86_400_000, tokens: 100 },
    { t: NOW - 86_400_000, end: NOW, tokens: 50 },
    { t: NOW - 2 * 86_400_000, end: NOW - 86_400_000, tokens: 0 },
  ]
  const lines = renderBars(bars)
  assert.equal(lines.length, 3)
  assert.ok(lines[1].includes('▇▇▇▇▇▇▇▇▇▇▇▇'), lines[1])
  assert.ok(lines[2].endsWith('0'), lines[2])
  const weekly = renderBars([
    { t: NOW, end: NOW + 7 * 86_400_000, tokens: 100 },
    { t: NOW - 7 * 86_400_000, end: NOW, tokens: 60 },
  ])
  assert.ok(weekly[1].includes('–'), weekly[1])
})
