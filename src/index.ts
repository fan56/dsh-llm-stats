/**
 * dsh-llm-stats — persistent whole-machine LLM usage ledger with a pure-text
 * `/llm-stats` command.
 *
 * The plugin subscribes to host-level `session/event` streams and folds every
 * closed step into one durable StepRecord line (see dsh-fold), appended to a
 * process-private shard under `$DSH_HOME/llm-stats/` (see dsh-store). All
 * dsh processes on the machine that mount this plugin feed the same ledger;
 * aggregation dedupes on (sid, turn, step), so live recording and a future
 * backfill from session logs can overlap without double counting.
 *
 * `/llm-stats` renders the ledger over rolling calendar-day windows — day,
 * week, month, 3m, 6m, 12m — as plain text on every surface. Retention
 * (default one year, configurable) is enforced by a locked compaction that
 * merges dead shards into `baseline.jsonl`.
 *
 * @module @aiwayds/dsh-llm-stats
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionFold, type StepRoute } from './fold.ts'
import { StatsStore, resolveStoreDir } from './store.ts'
import { aggregate, rangeWindow } from './aggregate.ts'
import { renderReport } from './render.ts'
import { isRangeKey, RANGES, type RangeKey, type ResolvedConfig } from './types.ts'

export { SessionFold } from './fold.ts'
export { StatsStore, parseRecords, dedupeRecords, resolveStoreDir, STORE_DIR_NAME } from './store.ts'
export { aggregate, rangeWindow } from './aggregate.ts'
export { renderReport, formatTokens, formatDuration, cacheHitPercent } from './render.ts'
export * from './types.ts'

export const name = 'dsh-llm-stats'
export const inject = ['commands']

/** Plugin configuration (the `Config` schema's resolved shape). */
export interface Config {
  /** `'off'` stops recording; `/llm-stats` and retention cleanup keep working. */
  mode?: 'on' | 'off'
  /** Records older than this many days are dropped at compaction (default 365, min 7). */
  retentionDays?: number
  /** Range shown by a bare `/llm-stats` (default `week`). */
  defaultRange?: RangeKey
}

const DEFAULT_RETENTION_DAYS = 365
const MIN_RETENTION_DAYS = 7
/** First compaction after boot; the session-event path must never wait on it. */
const FIRST_COMPACT_DELAY_MS = 60_000
/** Cadence for later rounds. */
const COMPACT_INTERVAL_MS = 24 * 3_600_000

/** Runtime schema for the plugin {@link Config} (loader-facing `Config` export). */
export const Config = z.object({
  mode: z.union([z.const('on'), z.const('off')]).default('on'),
  retentionDays: z.number().step(1).min(MIN_RETENTION_DAYS).default(DEFAULT_RETENTION_DAYS),
  defaultRange: z.union([
    z.const('day'), z.const('week'), z.const('month'),
    z.const('3m'), z.const('6m'), z.const('12m'),
  ]).default('week'),
}) as unknown as z<Config>

const CONFIG_KEYS: ReadonlySet<string> = new Set(['mode', 'retentionDays', 'defaultRange'])

/**
 * Validate, default, and freeze the plugin configuration.
 * @param config - optional plugin configuration; omission selects defaults.
 * @returns an immutable resolved configuration.
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-llm-stats: config: unknown key "${key}"`)
    }
  }
  const mode = config?.mode ?? 'on'
  if (mode !== 'on' && mode !== 'off') {
    throw new Error('dsh-llm-stats: mode must be "on" or "off"')
  }
  const retentionDays = config?.retentionDays ?? DEFAULT_RETENTION_DAYS
  if (!Number.isSafeInteger(retentionDays) || retentionDays < MIN_RETENTION_DAYS) {
    throw new Error(`dsh-llm-stats: retentionDays must be an integer >= ${MIN_RETENTION_DAYS}`)
  }
  const defaultRange = config?.defaultRange ?? 'week'
  if (!isRangeKey(defaultRange)) {
    throw new Error(`dsh-llm-stats: defaultRange must be one of ${Object.keys(RANGES).join(', ')}`)
  }
  return Object.freeze({ mode, retentionDays, defaultRange })
}

/** Non-serializable seams for deterministic tests. */
export interface Internals {
  /** Wall-clock override (epoch ms). */
  now?: () => number
  /** Store factory override. */
  createStore?: (dir: string) => StatsStore
}

/**
 * Install the ledger recorder and the `/llm-stats` command.
 * @param ctx - plugin context (needs the `commands` service).
 * @param config - plugin configuration; omission selects defaults.
 * @param internals - test seams.
 */
export function apply(ctx: Context, config: Config = {}, internals: Internals = {}): void {
  const policy = resolveConfig(config)
  const now = internals.now ?? Date.now
  const store = internals.createStore?.(resolveStoreDir()) ?? new StatsStore(resolveStoreDir(), { now })
  const fold = new SessionFold()

  // Recorder: one committed event in, maybe one record out. Billing must
  // never break a session — fold and append failures are swallowed. The
  // session's own route read seeds attribution across /reload, mid-session
  // mounts, and fold-state eviction (request/context logs only on change).
  if (policy.mode === 'on') {
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      try {
        let route: StepRoute | undefined
        try {
          const rc = session.requestContext()
          if (rc !== undefined) route = { provider: rc.provider, model: rc.model }
        } catch {
          // Event-driven attribution alone still works without the accessor.
        }
        const record = fold.fold(session.id, event, route)
        if (record !== null) store.append(record)
      } catch {
        // Never take the session down over statistics.
      }
    })
  }

  // Retention + dead-shard compaction: off the hot path, silent on failure.
  const compactor = setInterval(() => {
    try {
      store.compact(policy.retentionDays)
    } catch {
      // The next round retries.
    }
  }, COMPACT_INTERVAL_MS)
  const firstCompact = setTimeout(() => {
    try {
      store.compact(policy.retentionDays)
    } catch {
      // The next round retries.
    }
  }, FIRST_COMPACT_DELAY_MS)
  compactor.unref?.()
  firstCompact.unref?.()

  ctx.effect(() => ctx.commands.register({
    name: 'llm-stats',
    description: 'Show LLM usage statistics (tokens, cache hit, time) over a rolling window',
    input: { hint: '[day|week|month|3m|6m|12m]' },
    handler: (invocation): CommandResult => {
      const raw = invocation.rawInput.trim().toLowerCase()
      let key: RangeKey
      if (raw === '') {
        key = policy.defaultRange
      } else if (isRangeKey(raw)) {
        key = raw
      } else {
        return {
          kind: 'error',
          text: `Unknown range "${raw}". Usage: /llm-stats [${Object.keys(RANGES).join('|')}]`,
        }
      }
      const window = rangeWindow(key, now())
      const report = renderReport(key, aggregate(store.readAll(), window))
      return { kind: 'success', text: report }
    },
  }), 'dsh-llm-stats: /llm-stats command')

  ctx.effect(() => () => {
    clearInterval(compactor)
    clearTimeout(firstCompact)
    store.close()
  }, 'dsh-llm-stats: stop compaction timers and close the ledger')
}
