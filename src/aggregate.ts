/**
 * Ledger → range-filtered aggregates: dedupe, calendar-day buckets, per-model
 * rows, and the per-bar series behind `/llm-stats`.
 *
 * Range windows are rolling and calendar-day aligned (user decision
 * 2026-09-01): `week` covers the last 7 local calendar days including today,
 * so a window always starts at a local midnight and the rendered date range
 * matches what a reader would call "the last 7 days".
 *
 * @module @aiwayds/dsh-llm-stats/aggregate
 */

import { RANGES, type RangeKey, type StepRecord } from './types.ts'

/** Window bounds in epoch ms: `[start, end)`. */
export interface RangeWindow {
  start: number
  end: number
}

/**
 * Compute the window for a range key.
 * @param key - the display range.
 * @param now - wall clock (epoch ms).
 * @returns half-open window bounds.
 */
export function rangeWindow(key: RangeKey, now: number): RangeWindow {
  const days = RANGES[key].days
  return { start: localMidnight(now) - (days - 1) * DAY_MS, end: now + 1 }
}

/** Local midnight of the day containing `time`, epoch ms. */
function localMidnight(time: number): number {
  const d = new Date(time)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const DAY_MS = 86_400_000

/** Totals over a set of records — every displayed figure derives from these. */
export interface Totals {
  /** Distinct sessions with at least one in-window record. */
  sessions: number
  /** Distinct (session, turn) pairs with at least one in-window record. */
  turns: number
  /** Records carrying provider usage — the billed LLM calls. */
  requests: number
  /** All in-window records (closed steps, billed or not). */
  steps: number
  /** Uncached prompt input tokens. */
  tin: number
  /** Cache-read tokens. */
  cr: number
  /** Cache-write tokens. */
  cw: number
  /** Output tokens. */
  out: number
  /** Summed model wall time, ms (null-records contribute nothing). */
  llmMs: number
  /** Summed resolved tool wall time, ms. */
  toolMs: number
  /** Summed first-token latency over `ttftSamples`. */
  ttftMs: number
  /** Steps carrying a first-token reading. */
  ttftSamples: number
  /** Summed decode wall time over steps with timing and output tokens. */
  decMs: number
  /** Output tokens over the same decode-timed steps. */
  decTk: number
  /** Resolved tool calls. */
  tools: number
}

/** Empty totals. */
export function emptyTotals(): Totals {
  return {
    sessions: 0, turns: 0, requests: 0, steps: 0,
    tin: 0, cr: 0, cw: 0, out: 0,
    llmMs: 0, toolMs: 0, ttftMs: 0, ttftSamples: 0, decMs: 0, decTk: 0, tools: 0,
  }
}

/** One per-model row of the report. */
export interface ModelRow extends Totals {
  /** Model id (route attribution follows each step's latest `request/context`). */
  model: string
}

/** One bar of the per-day/per-week series. */
export interface BarRow {
  /** Bucket start, epoch ms (local midnight, or a Monday for weekly folds). */
  t: number
  /** Bucket end, epoch ms (exclusive for weekly folds). */
  end: number
  /** Total billed tokens in the bucket (input + output). */
  tokens: number
}

/** Full aggregate for one range window. */
export interface RangeAggregate {
  /** Window the aggregate covers. */
  window: RangeWindow
  /** Whole-window totals. */
  totals: Totals
  /** Per-model rows, sorted by total billed tokens descending. */
  byModel: ModelRow[]
  /** Per-day series (local-midnight aligned). */
  byDay: BarRow[]
}

/** Last-wins dedupe over (sid, turn, step) — live and backfilled overlap-safe. */
export function dedupe(records: readonly StepRecord[]): StepRecord[] {
  const byKey = new Map<string, StepRecord>()
  for (const record of records) {
    byKey.set(`${record.sid}\u0000${record.turn}\u0000${record.step}`, record)
  }
  return [...byKey.values()]
}

/**
 * Aggregate records over a range window.
 * @param records - raw ledger records (any order; deduped here).
 * @param window - half-open window bounds.
 * @returns totals, per-model rows, and the per-day series.
 */
export function aggregate(records: readonly StepRecord[], window: RangeWindow): RangeAggregate {
  const unique = dedupe(records).filter(r => r.t >= window.start && r.t < window.end)
  const totals = emptyTotals()
  const sessions = new Set<string>()
  const turns = new Set<string>()
  const models = new Map<string, Totals & { model: string }>()
  const byDayMap = new Map<number, number>()
  for (const r of unique) {
    sessions.add(r.sid)
    turns.add(`${r.sid}\u0000${r.turn}`)
    totals.steps += 1
    totals.toolMs += r.toolMs
    totals.tools += r.tools
    if (r.llmMs !== null) totals.llmMs += r.llmMs
    if (r.ttftMs !== null) {
      totals.ttftMs += r.ttftMs
      totals.ttftSamples += 1
    }
    const billed = r.tin !== null || r.cr !== null || r.cw !== null || r.out !== null
    if (billed) totals.requests += 1
    totals.tin += r.tin ?? 0
    totals.cr += r.cr ?? 0
    totals.cw += r.cw ?? 0
    totals.out += r.out ?? 0
    if (r.decMs !== null && r.decTk !== null) {
      totals.decMs += r.decMs
      totals.decTk += r.decTk
    }
    let model = models.get(r.model)
    if (model === undefined) {
      model = { model: r.model, ...emptyTotals() }
      models.set(r.model, model)
    }
    model.steps += 1
    model.toolMs += r.toolMs
    model.tools += r.tools
    if (r.llmMs !== null) model.llmMs += r.llmMs
    if (billed) model.requests += 1
    model.tin += r.tin ?? 0
    model.cr += r.cr ?? 0
    model.cw += r.cw ?? 0
    model.out += r.out ?? 0
    const day = localMidnight(r.t)
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + (r.tin ?? 0) + (r.out ?? 0))
  }
  totals.sessions = sessions.size
  totals.turns = turns.size
  const byModel = [...models.values()].map(row => ({ ...row, sessions: 0, turns: 0 }))
  byModel.sort((a, b) => (b.tin + b.out) - (a.tin + a.out))
  const byDay: BarRow[] = [...byDayMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, tokens]) => ({ t, end: t + DAY_MS, tokens }))
  return { window, totals, byModel, byDay }
}

/**
 * Fold daily bars into Monday-aligned weekly bars (long ranges only).
 * @param byDay - the per-day series.
 * @returns one bar per ISO week (Monday local midnight).
 */
export function foldWeekly(byDay: readonly BarRow[]): BarRow[] {
  const weeks = new Map<number, BarRow>()
  for (const bar of byDay) {
    const date = new Date(bar.t)
    const shift = (date.getDay() + 6) % 7 // days since Monday
    const monday = bar.t - shift * DAY_MS
    const week = weeks.get(monday)
    if (week === undefined) {
      weeks.set(monday, { t: monday, end: monday + 7 * DAY_MS, tokens: bar.tokens })
    } else {
      week.tokens += bar.tokens
    }
  }
  return [...weeks.values()].sort((a, b) => a.t - b.t)
}
