/**
 * Shared vocabulary of the usage ledger: one step's durable record, the
 * display ranges, and the resolved plugin configuration.
 *
 * @module @aiwayds/dsh-llm-stats
 */

/** On-disk record schema version; bumped only for breaking line-format changes. */
export const RECORD_VERSION = 1

/**
 * One closed step's usage facts — the smallest durable ledger unit.
 *
 * Written on every `step/end` (the step lifecycle authority): completed,
 * failed, cancelled, and max-tokens steps all land one line, per the upstream
 * session-stats convention that steps count attempts, not visible output.
 * Token fields are `null` when the step assembled no provider-reported
 * usage; timing fields are `null` when the step never reached the part of
 * its lifecycle that produces them.
 */
export interface StepRecord {
  /** On-disk schema version. */
  v: typeof RECORD_VERSION
  /** Owning session id. */
  sid: string
  /** Turn number (host-assigned, monotonic per session). */
  turn: number
  /** Step number within the turn. */
  step: number
  /** `step/end` wall-clock time, epoch ms — the record's aggregation timestamp. */
  t: number
  /** Provider route serving the step, from the latest `request/context`. */
  prov: string
  /** Model id serving the step, from the latest `request/context`. */
  model: string
  /** Uncached prompt input tokens. */
  tin: number | null
  /** Provider-reported cache-read tokens. */
  cr: number | null
  /** Provider-reported cache-write tokens. */
  cw: number | null
  /** Completion output tokens. */
  out: number | null
  /** Model wall time (`step/start` → `assistant/message`); null when no message assembled. */
  llmMs: number | null
  /** First-token latency (`step/start` → first non-empty delta); null when no token streamed. */
  ttftMs: number | null
  /** Decode wall time (first token → message); null without both timing and output tokens. */
  decMs: number | null
  /** Output tokens over the decoded span; null alongside `decMs`. */
  decTk: number | null
  /** Resolved tool call→result pairs in the step; unresolved calls are dropped. */
  tools: number
  /** Summed matched tool wall time, ms. */
  toolMs: number
}

/** Display range presets — rolling windows ending now (user decision 2026-09-01). */
export type RangeKey = 'day' | 'week' | 'month' | '3m' | '6m' | '12m'

/** Immutable range metadata. */
export interface RangeDef {
  /** Command-facing key. */
  key: RangeKey
  /** Human label used in the rendered header. */
  label: string
  /** Window length in whole local calendar days, today included. */
  days: number
}

/** The six shipped ranges, ordered short → long. */
export const RANGES: Readonly<Record<RangeKey, RangeDef>> = Object.freeze({
  day: { key: 'day', label: 'today', days: 1 },
  week: { key: 'week', label: 'last 7 days', days: 7 },
  month: { key: 'month', label: 'last 30 days', days: 30 },
  '3m': { key: '3m', label: 'last 3 months', days: 90 },
  '6m': { key: '6m', label: 'last 6 months', days: 180 },
  '12m': { key: '12m', label: 'last 12 months', days: 365 },
} satisfies Record<RangeKey, RangeDef>)

/** Ranges whose per-bar detail stays daily; longer ranges fold to weeks. */
export const DAILY_BAR_MAX_DAYS = 92

/** Fully validated configuration captured at apply time. */
export interface ResolvedConfig {
  readonly mode: 'on' | 'off'
  readonly retentionDays: number
  readonly defaultRange: RangeKey
}

/** Guard a value as one of the shipped range keys. */
export function isRangeKey(value: string): value is RangeKey {
  return value in RANGES
}
