import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregate, dedupe, foldWeekly, rangeWindow } from '../lib/aggregate.js'

/** Local midnight of the day containing `t`. */
function midnight(t) {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const DAY = 86_400_000
const NOW = new Date('2026-09-01T12:00:00').getTime()

function record(overrides) {
  return {
    v: 1, sid: 's1', turn: 1, step: 1, t: NOW,
    prov: 'p', model: 'm',
    tin: 10, cr: 20, cw: 0, out: 5,
    llmMs: 100, ttftMs: 50, decMs: 80, decTk: 5,
    tools: 1, toolMs: 30,
    ...overrides,
  }
}

test('range windows are rolling and calendar-day aligned, today included', () => {
  const week = rangeWindow('week', NOW)
  assert.equal(week.start, midnight(NOW) - 6 * DAY)
  assert.equal(week.end, NOW + 1)
  const day = rangeWindow('day', NOW)
  assert.equal(day.start, midnight(NOW))
  const year = rangeWindow('12m', NOW)
  assert.equal(year.start, midnight(NOW) - 364 * DAY)
})

test('dedupe keeps the last record per (sid, turn, step)', () => {
  const deduped = dedupe([
    record({ t: 100, out: 1 }),
    record({ sid: 's2', t: 100 }),
    record({ t: 200, out: 2 }),
  ])
  assert.equal(deduped.length, 2)
  assert.equal(deduped.find(r => r.sid === 's1').out, 2)
})

test('aggregate computes totals, sessions, turns, and requests', () => {
  const records = [
    record({}),                                                    // s1 t1 step1 billed
    record({ step: 2, tin: null, cr: null, cw: null, out: null, llmMs: null, ttftMs: null, decMs: null, decTk: null }), // same turn, unbilled
    record({ sid: 's2', turn: 1, step: 1 }),                       // second session, same turn number
    record({ step: 9, t: NOW - 40 * DAY }),                        // outside a week window
  ]
  const agg = aggregate(records, rangeWindow('week', NOW))
  assert.equal(agg.totals.steps, 3)
  assert.equal(agg.totals.sessions, 2)
  assert.equal(agg.totals.turns, 2)
  assert.equal(agg.totals.requests, 2)
  assert.equal(agg.totals.tin, 20)
  assert.equal(agg.totals.out, 10)
  assert.equal(agg.totals.cr, 40)
  assert.equal(agg.totals.llmMs, 200)
  assert.equal(agg.totals.ttftSamples, 2)
  assert.equal(agg.totals.decTk, 10)
})

test('byModel sorts by billed tokens descending and merges per model', () => {
  const records = [
    record({ step: 1, model: 'small', tin: 1, out: 1 }),
    record({ step: 2, model: 'big', tin: 1000, out: 500 }),
    record({ step: 3, model: 'big', tin: 10, out: 10 }),
  ]
  const agg = aggregate(records, rangeWindow('day', NOW))
  assert.deepEqual(agg.byModel.map(r => r.model), ['big', 'small'])
  assert.equal(agg.byModel[0].requests, 2)
})

test('byDay buckets billed tokens per local day, in order', () => {
  const records = [
    record({ t: NOW }),
    record({ step: 2, t: midnight(NOW) - DAY, out: 7 }),
  ]
  const agg = aggregate(records, rangeWindow('week', NOW))
  assert.equal(agg.byDay.length, 2)
  assert.equal(agg.byDay[1].t, midnight(NOW))
  assert.equal(agg.byDay[1].tokens, 15)
  assert.equal(agg.byDay[0].tokens, 17)
})

test('foldWeekly collapses daily bars into Monday-aligned weeks', () => {
  const monday = midnight(NOW) - ((new Date(NOW).getDay() + 6) % 7) * DAY
  const byDay = [
    { t: monday, end: monday + DAY, tokens: 10 },
    { t: monday + DAY, end: monday + 2 * DAY, tokens: 5 },
    { t: monday + 8 * DAY, end: monday + 9 * DAY, tokens: 7 },
  ]
  const weeks = foldWeekly(byDay)
  assert.equal(weeks.length, 2)
  assert.equal(weeks[0].t, monday)
  assert.equal(weeks[0].tokens, 15)
  assert.equal(weeks[1].tokens, 7)
})
