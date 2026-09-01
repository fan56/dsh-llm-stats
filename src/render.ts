/**
 * Aggregate → pure-text renderer for `/llm-stats`. The single presentation
 * surface of the plugin; UI copy is English-only (npm packaging convention).
 *
 * Shape (from the approved plan):
 *
 *   LLM stats · last 7 days (Aug 26 – Sep 1)
 *     Sessions 23 · Turns 156 · Requests 412
 *     Tokens in 12.4M (cache hit 85%) · out 890K · total 13.3M
 *     Model time 3h12m · tools 47m · avg TTFT 1.2s · 42.3 tok/s
 *     By model
 *       deepseek-chat  in 9.1M  out 640K  cache 88%  req 320
 *     Aug 26 ▇▇▇▇▇▇▇ 2.1M
 *
 * @module @aiwayds/dsh-llm-stats/render
 */

import { foldWeekly, type BarRow, type ModelRow, type RangeAggregate } from './aggregate.ts'
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

/** Inclusive local date range label: `Aug 26 – Sep 1`. */
export function formatDateRange(start: number, end: number): string {
  const from = formatDate(start)
  const to = formatDate(end - 1)
  return from === to ? from : `${from} – ${to}`
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

/** One text report, ready for `{ kind: 'success', text }`. */
export function renderReport(key: RangeKey, aggregate: RangeAggregate): string {
  const { totals, window } = aggregate
  const label = RANGES[key].label
  if (totals.steps === 0) {
    return `LLM stats · ${label} (${formatDateRange(window.start, window.end)}): no activity recorded.`
  }
  const lines: string[] = []
  lines.push(`LLM stats · ${label} (${formatDateRange(window.start, window.end)})`)
  lines.push('')
  lines.push(`  Sessions ${totals.sessions} · Turns ${totals.turns} · Requests ${totals.requests} · Steps ${totals.steps}`)
  // Displayed "in" is billed prompt-side input (uncached + cache read + cache
  // write); "total" is billed input + output.
  const billedIn = totals.tin + totals.cr + totals.cw
  const tokenParts = [`in ${formatTokens(billedIn)}`]
  const hit = cacheHitPercent(totals)
  if (hit !== null) tokenParts.push(`cache hit ${hit}%`)
  tokenParts.push(`out ${formatTokens(totals.out)}`)
  tokenParts.push(`total ${formatTokens(billedIn + totals.out)}`)
  lines.push(`  Tokens ${tokenParts.join(' · ')}`)
  const timeParts: string[] = []
  if (totals.llmMs > 0) timeParts.push(`model ${formatDuration(totals.llmMs)}`)
  if (totals.toolMs > 0) timeParts.push(`tools ${formatDuration(totals.toolMs)}`)
  if (totals.ttftSamples > 0) timeParts.push(`avg TTFT ${formatDuration(totals.ttftMs / totals.ttftSamples)}`)
  if (totals.decMs > 0) timeParts.push(`${(totals.decTk / (totals.decMs / 1_000)).toFixed(1)} tok/s`)
  if (timeParts.length > 0) lines.push(`  Time ${timeParts.join(' · ')}`)
  if (aggregate.byModel.length > 0) {
    lines.push('')
    lines.push('  By model')
    const rows = aggregate.byModel
    const width = Math.max(...rows.map(r => r.model.length))
    for (const row of rows.slice(0, 8)) {
      lines.push(`    ${row.model.padEnd(width)}  ${modelSummary(row)}`)
    }
    if (rows.length > 8) lines.push(`    +${rows.length - 8} more models`)
  }
  const bars = RANGES[key].days > DAILY_BAR_MAX_DAYS ? foldWeekly(aggregate.byDay) : aggregate.byDay
  const barLines = renderBars(bars)
  if (barLines.length > 0) {
    lines.push('')
    lines.push(...barLines)
  }
  return lines.join('\n')
}

/** One aligned `in X out Y cache Z% req N` summary (totals row includes counts). */
function modelSummary(row: ModelRow): string {
  const parts = [`in ${formatTokens(row.tin + row.cr + row.cw)}`, `out ${formatTokens(row.out)}`]
  const hit = cacheHitPercent(row)
  if (hit !== null) parts.push(`cache ${hit}%`)
  parts.push(`req ${row.requests}`)
  return parts.join('  ')
}

/** One bar spans a day; anything longer is a weekly fold. */
const DAY_MS = 86_400_000

/** Render bar rows as `Aug 26 ▇▇▇▇ 2.1M` lines, scaled to the max bucket. */
export function renderBars(bars: readonly BarRow[]): string[] {
  if (bars.length === 0) return []
  const max = Math.max(...bars.map(b => b.tokens))
  if (max <= 0) return []
  const weekly = bars.length > 1 && bars[1].end - bars[1].t > DAY_MS
  const lines: string[] = []
  for (const bar of bars) {
    const filled = bar.tokens > 0 ? Math.max(1, Math.round(bar.tokens / max * 24)) : 0
    const label = weekly
      ? `${formatDate(bar.t)}–${formatDate(bar.end - 1)}`
      : formatDate(bar.t)
    lines.push(`  ${label} ${'▇'.repeat(filled)} ${formatTokens(bar.tokens)}`)
  }
  return lines
}
