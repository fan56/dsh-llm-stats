/**
 * Aggregate → markdown renderer for `/llm-stats`. The single presentation
 * surface of the plugin; UI copy is English-only (npm packaging convention).
 * GFM tables + emoji icons: the TUI command echo detects the `| --- |`
 * separator rows and renders the report through its markdown component;
 * surfaces without that detection show the raw markdown, still readable.
 * Help, backfill, and error output stay plain text with no table separators,
 * so only reports take the markdown path downstream.
 *
 * Shape (from the approved plan):
 *
 *   ## 📊 LLM stats · last 7 days (Aug 26 – Sep 1)
 *
 *   | ⚡ Sessions | 💬 Turns | 📡 Requests | 👣 Steps |
 *   | --- | --- | --- | --- |
 *   | 23 | 156 | 412 | 430 |
 *
 *   | 📥 In | 🔥 Cache hit | 📤 Out | 🧮 Total |
 *   | --- | --- | --- | --- |
 *   | 12.4M | 85% | 890K | 13.3M |
 *
 *   ⏱ Model 3h12m · 🔧 Tools 47m · 🚀 TTFT 1.2s · ⚡ 42.3 tok/s
 *
 *   ## 🤖 By model
 *
 *   | Model | 📥 In | 📤 Out | 🔥 Cache | 📡 Req |
 *   | --- | --- | --- | --- | --- |
 *   | deepseek-chat | 9.1M | 640K | 88% | 320 |
 *
 *   ## 📈 Activity
 *
 *   | 📅 Date | 📊 Tokens | 📈 |
 *   | --- | --- | --- |
 *   | Aug 26 | 2.1M | ▇▇▇▇▇▇▇ |
 *
 * @module @aiwayds/dsh-llm-stats/render
 */

import { foldWeekly, type BarRow, type RangeAggregate } from './aggregate.ts'
import { DAILY_BAR_MAX_DAYS, RANGES, type RangeKey, type ResolvedConfig } from './types.ts'

/** Compact token count: 517 / 12.2K / 999.5K / 1M / 1.2M (one decimal under 100). */
export function formatTokens(n: number): string {
  const scaled = (v: number): string => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1_000) return String(n)
  // 999_500 rounds to 1000.0K at one decimal — carry into megabytes instead
  // of ever printing a "1000K" row.
  if (n >= 999_500) return `${scaled(n / 1_000_000)}M`
  return `${scaled(n / 1_000)}K`
}

/** Compact duration: 45.2s under a minute, 2m42s to an hour, 3h12m from there. */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  if (whole < 3_600) return `${Math.floor(whole / 60)}m${whole % 60}s`
  return `${Math.floor(whole / 3_600)}h${Math.floor((whole % 3_600) / 60)}m`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** Short local date label: `Aug 26`. */
export function formatDate(t: number): string {
  const d = new Date(t)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** Inclusive local date range label; the year appears when the ends differ: `Aug 26 – Sep 1`, `Sep 2, 2025 – Sep 1, 2026`. */
export function formatDateRange(start: number, end: number): string {
  const from = formatDate(start)
  const to = formatDate(end - 1)
  if (from === to) return from
  const fromYear = new Date(start).getFullYear()
  const toYear = new Date(end - 1).getFullYear()
  return fromYear === toYear ? `${from} – ${to}` : `${from}, ${fromYear} – ${to}, ${toYear}`
}

/**
 * Cache-hit share of billed prompt-side input (the TUI footer's CH
 * convention): Σ cacheRead ÷ (Σ uncached + Σ read + Σ write).
 * @returns rounded integer percent, or null when nothing was billed.
 */
export function cacheHitPercent(totals: { cr: number; tin: number; cw: number }): number | null {
  const billed = totals.tin + totals.cr + totals.cw
  return billed === 0 ? null : Math.round(totals.cr / billed * 100)
}

/** Ledger coverage facts shown on the help screen. */
export interface LedgerSummary {
  /** Total records in the ledger (all time). */
  steps: number
  /** Earliest record time, epoch ms; null on an empty ledger. */
  earliest: number | null
}

/**
 * Help screen — what a bare `/llm-stats` shows (user decision 2026-09-01,
 * replacing the default-range render). Carries the usage grammar, the active
 * configuration, and whether the ledger has started recording at all.
 */
export function renderHelp(config: ResolvedConfig, ledger: LedgerSummary): string {
  const lines: string[] = []
  lines.push('LLM stats — records this machine\'s LLM usage and reports it as text.')
  lines.push('')
  lines.push('  Usage:')
  lines.push('    /llm-stats            show this help')
  for (const range of Object.values(RANGES)) {
    lines.push(`    /llm-stats ${range.key.padEnd(10)}${range.label}`)
  }
  lines.push('    /llm-stats d|w|m     shorthand for day / week / month')
  lines.push('    /llm-stats backfill  import past usage from the session logs')
  lines.push('')
  const configLine = `mode ${config.mode} · retention ${config.retentionDays} days`
  let ledgerLine: string
  if (ledger.steps === 0) {
    ledgerLine = 'ledger empty — stats appear after your first completed turn'
  } else {
    ledgerLine = `${ledger.steps.toLocaleString('en-US')} step${ledger.steps === 1 ? '' : 's'} recorded since ${formatDate(ledger.earliest ?? 0)}`
  }
  lines.push(`  ${configLine}`)
  lines.push(`  ${ledgerLine}`)
  return lines.join('\n')
}

/** Summary line for a finished backfill pass. */
export function renderBackfillSummary(outcome: {
  scanned: number
  backfilled: number
  known: number
  empty: number
  records: number
  aborted: boolean
}): string {
  const lines = [
    'Backfill complete',
    `  Sessions scanned ${outcome.scanned} · backfilled ${outcome.backfilled} · already known ${outcome.known} · without qualifying steps ${outcome.empty}`,
    `  Records added ${outcome.records.toLocaleString('en-US')}`,
  ]
  if (outcome.aborted) lines.push('  Aborted before every session was visited — run /llm-stats backfill again to resume.')
  return lines.join('\n')
}

/** One markdown report, ready for `{ kind: 'success', text }`. */
export function renderReport(key: RangeKey, aggregate: RangeAggregate): string {
  const { totals, window } = aggregate
  const label = RANGES[key].label
  if (totals.steps === 0) {
    return `📭 LLM stats · ${label} (${formatDateRange(window.start, window.end)}): no activity recorded.`
  }
  const lines: string[] = []
  lines.push(`## 📊 LLM stats · ${label} (${formatDateRange(window.start, window.end)})`)
  lines.push('')
  lines.push('| ⚡ Sessions | 💬 Turns | 📡 Requests | 👣 Steps |')
  lines.push('| --- | --- | --- | --- |')
  lines.push(`| ${totals.sessions} | ${totals.turns} | ${totals.requests} | ${totals.steps} |`)
  lines.push('')
  // Displayed "in" is billed prompt-side input (uncached + cache read + cache
  // write); "total" is billed input + output. Cache hit stays an empty cell
  // (column retained) when nothing was billed.
  const billedIn = totals.tin + totals.cr + totals.cw
  lines.push('| 📥 In | 🔥 Cache hit | 📤 Out | 🧮 Total |')
  lines.push('| --- | --- | --- | --- |')
  lines.push(`| ${formatTokens(billedIn)} | ${hitCell(cacheHitPercent(totals))} | ${formatTokens(totals.out)} | ${formatTokens(billedIn + totals.out)} |`)
  const timeParts: string[] = []
  if (totals.llmMs > 0) timeParts.push(`⏱ Model ${formatDuration(totals.llmMs)}`)
  if (totals.toolMs > 0) timeParts.push(`🔧 Tools ${formatDuration(totals.toolMs)}`)
  if (totals.ttftSamples > 0) timeParts.push(`🚀 TTFT ${formatDuration(totals.ttftMs / totals.ttftSamples)}`)
  if (totals.decMs > 0) timeParts.push(`⚡ ${(totals.decTk / (totals.decMs / 1_000)).toFixed(1)} tok/s`)
  if (timeParts.length > 0) {
    lines.push('')
    lines.push(timeParts.join(' · '))
  }
  // Model rows that carried no usage at all render as empty table clutter —
  // drop them — and the table caps at eight rows with a count note.
  const models = aggregate.byModel.filter(row => row.requests > 0 || row.tin + row.cr + row.cw + row.out > 0)
  if (models.length > 0) {
    lines.push('')
    lines.push('## 🤖 By model')
    lines.push('')
    lines.push('| Model | 📥 In | 📤 Out | 🔥 Cache | 📡 Req |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const row of models.slice(0, 8)) {
      lines.push(`| ${row.model} | ${formatTokens(row.tin + row.cr + row.cw)} | ${formatTokens(row.out)} | ${hitCell(cacheHitPercent(row))} | ${row.requests} |`)
    }
    if (models.length > 8) lines.push('', `+${models.length - 8} more models`)
  }
  const bars = RANGES[key].days > DAILY_BAR_MAX_DAYS ? foldWeekly(aggregate.byDay) : aggregate.byDay
  const rows = renderBars(bars)
  if (rows.length > 0) {
    lines.push('')
    lines.push('## 📈 Activity')
    lines.push('')
    lines.push('| 📅 Date | 📊 Tokens | 📈 |')
    lines.push('| --- | --- | --- |')
    for (const row of rows) lines.push(`| ${row.date} | ${formatTokens(row.tokens)} | ${row.bar} |`)
  }
  return lines.join('\n')
}

/** Cache-hit table cell: `NN%`, or empty when nothing was billed. */
function hitCell(hit: number | null): string {
  return hit === null ? '' : `${hit}%`
}

/** One activity-table row of the report. */
export interface BarLine {
  /** Date label: `Sep 1`, or `Aug 26–Sep 1` for weekly folds. */
  date: string
  /** Total billed tokens in the bucket. */
  tokens: number
  /** Bar scaled to the max bucket; empty for a zero-token bucket. */
  bar: string
}

/** One bar spans a day; anything longer is a weekly fold. */
const DAY_MS = 86_400_000

/** Render bar rows as activity-table cells, scaled to the max bucket (24 cells). */
export function renderBars(bars: readonly BarRow[]): BarLine[] {
  if (bars.length === 0) return []
  const max = Math.max(...bars.map(b => b.tokens))
  if (max <= 0) return []
  const weekly = bars.length > 1 && bars[1].end - bars[1].t > DAY_MS
  const rows: BarLine[] = []
  for (const bar of bars) {
    const filled = bar.tokens > 0 ? Math.max(1, Math.round(bar.tokens / max * 24)) : 0
    const date = weekly
      ? `${formatDate(bar.t)}–${formatDate(bar.end - 1)}`
      : formatDate(bar.t)
    rows.push({ date, tokens: bar.tokens, bar: '▇'.repeat(filled) })
  }
  return rows
}
