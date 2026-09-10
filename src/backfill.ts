/**
 * Ledger backfill from the durable session logs.
 *
 * `/llm-stats backfill` walks `$DSH_HOME/sessions/<project>/<id>/` over the
 * session artifacts (`session.v3.jsonl[.zstd]` for the V3 format, legacy
 * `session.jsonl[.zstd]` below it),
 * decodes each container (the backend appends one zstd frame per batch, so
 * Node's one-shot decoder only ever sees the first frame — a structural
 * frame skip-scan over magic + frame header + block headers is implemented
 * here), folds every committed step with the same SessionFold the live
 * recorder uses, and appends the resulting records to a dedicated
 * `records.backfill.jsonl` shard.
 *
 * Correctness guards:
 * - **Seed history is skipped.** A forked or subagent session's log starts
 *   with its parent's events; the header's `seedLength` counts exactly how
 *   many leading events were inherited, so rows below that seq are parent
 *   history and would double count against the parent's own records.
 *   Resume-time `session/end-seed` markers are deliberately NOT used as a
 *   boundary: every /resume re-appends one, and everything before it is the
 *   session's own recorded work.
 * - **Overlap is safe.** Aggregation dedupes on (sid, turn, step), so a
 *   session recorded live AND backfilled cannot double count; a done-ledger
 *   (`backfill.json`) merely skips known-work to keep repeat runs fast.
 * - **Retention holds.** Records older than `retentionDays` are not added;
 *   sessions whose file was last written before the cutoff are skipped
 *   whole (nothing inside could qualify).
 *
 * @module @aiwayds/dsh-llm-stats/backfill
 */

import {
  appendFileSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionFold } from './fold.ts'
import type { StepRecord } from './types.ts'

/** One discovered session log on disk. */
export interface SessionLog {
  /** Session id (the directory basename; the decoded header is authoritative for records). */
  id: string
  /** Absolute path of the log file. */
  path: string
  /** File mtime, epoch ms. */
  mtime: number
}

/**
 * Scan a concatenated-frame zstd container into complete frame ranges
 * without decompressing: skip magic, frame header (descriptor, window
 * descriptor, dictionary id, frame content size), then block-by-block via
 * each 3-byte block header until the last-block flag, then the optional
 * content checksum. A torn final frame is simply not reported.
 * @param buf - the raw file bytes.
 * @returns half-open `[start, end)` ranges of complete frames.
 */
export function scanZstdFrames(buf: Buffer): Array<[number, number]> {
  const frames: Array<[number, number]> = []
  let off = 0
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0xFD2FB528) {
    const start = off
    let p = off + 4
    if (p >= buf.length) break
    const fhd = buf[p++]
    const singleSegment = (fhd >> 5) & 1
    const hasChecksum = (fhd >> 2) & 1
    const didSize = [0, 1, 2, 4][fhd & 3]
    const fcsFlag = (fhd >> 6) & 3
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [2, 4, 8][fcsFlag - 1]
    p += (singleSegment ? 0 : 1) + didSize + fcsSize
    let last = 0
    while (p + 3 <= buf.length) {
      const header = buf.readUIntLE(p, 3)
      p += 3
      last = header & 1
      const type = (header >> 1) & 3
      const size = header >> 3
      // RLE blocks carry one literal byte; raw and compressed carry `size`.
      p += type === 1 ? 1 : size
      if (last === 1) break
    }
    if (last !== 1) break // torn frame: the container's committed prefix ends here
    p += hasChecksum ? 4 : 0
    if (p > buf.length) break
    frames.push([start, p])
    off = p
  }
  return frames
}

/**
 * Decode a whole session-log container: complete frames decompressed in
 * order, concatenated UTF-8. The line list omits torn-frame content,
 * matching the backend's committed-prefix read semantics.
 * @param buf - the raw file bytes.
 * @returns the JSONL text as an array of non-empty lines.
 */
export function decodeLogLines(buf: Buffer): string[] {
  const frames = scanZstdFrames(buf)
  const parts: Buffer[] = []
  for (const [start, end] of frames) {
    parts.push(zstdDecompressSync(buf.subarray(start, end)))
  }
  const text = Buffer.concat(parts).toString('utf8')
  return text.split('\n').filter(line => line !== '')
}

/**
 * Translate one stored row into a fold input event. Envelope rows pass
 * through — including the V3 `assistant/attempt` and `assistant/message`
 * settlements whose embedded `AssistantStreamRecord[]` stream carries the
 * original chunk timestamps the fold's TTFT reads. Legacy (pre-V3) packed
 * chunk runs (`text-chunks`/`reasoning-chunks`/`tool-call-chunks` as
 * standalone rows) become a single synthetic first-token `assistant/chunk`
 * at the run's `time0` — exactly the one fact TTFT needs, since a run by
 * construction packs non-empty token deltas. The header row and any other
 * non-core vocabulary is dropped.
 * @param row - one parsed JSONL row.
 * @returns a SessionEvent-shaped input, or null when the row is irrelevant.
 */
export function toFoldEvent(row: Record<string, unknown>): SessionEvent | null {
  const type = row.type
  if (typeof type !== 'string') return null
  if (type === 'assistant/attempt' || type === 'request/context' || type === 'step/start'
    || type === 'step/end' || type === 'assistant/message' || type === 'tool/call'
    || type === 'tool/result') {
    return row as unknown as SessionEvent
  }
  const packedToken = type === 'text-chunks' ? 'text-delta'
    : type === 'reasoning-chunks' ? 'reasoning-delta'
    : type === 'tool-call-chunks' ? 'tool-call-delta'
    : null
  if (packedToken === null) return null
  const data = row.data as Record<string, unknown> | undefined
  if (data === undefined || typeof data.turn !== 'number' || typeof data.step !== 'number') return null
  const texts = data.texts
  const firstText = Array.isArray(texts) && typeof texts[0] === 'string' ? texts[0] : '·'
  const chunk = packedToken === 'tool-call-delta'
    ? { type: packedToken, name: 'tool', argumentsDelta: '' }
    : { type: packedToken, text: firstText }
  return {
    type: 'assistant/chunk',
    seq: typeof row.seq0 === 'number' ? row.seq0 : 0,
    time: typeof row.time0 === 'number' ? row.time0 : 0,
    data: { turn: data.turn, step: data.step, chunk },
  } as unknown as SessionEvent
}

/**
 * Fold one decoded session log into StepRecords.
 * @param sid - the session's authoritative id.
 * @param lines - decoded JSONL lines.
 * @returns the session's step records (empty for a session with no steps).
 */
export function foldSessionLog(sid: string, lines: readonly string[]): StepRecord[] {
  const rows: Array<{ row: Record<string, unknown>; seq: number }> = []
  let seedBoundary = 0
  for (const line of lines) {
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (row.type === 'session') {
      // The header. `seedLength` = leading events inherited through a seed
      // (fork/subagent children only); everything below that seq is the
      // PARENT's history. Resume markers are ignored on purpose — see the
      // module comment.
      const seedLength = row.seedLength
      if (typeof seedLength === 'number' && Number.isSafeInteger(seedLength) && seedLength > seedBoundary) {
        seedBoundary = seedLength
      }
      continue
    }
    const seq = typeof row.seq === 'number' ? row.seq : typeof row.seq0 === 'number' ? row.seq0 : Number.POSITIVE_INFINITY
    rows.push({ row, seq })
  }
  const fold = new SessionFold()
  const records: StepRecord[] = []
  for (const { row, seq } of rows) {
    // Seed history belongs to the parent session's ledger; never re-counted.
    if (seq < seedBoundary) continue
    const event = toFoldEvent(row)
    if (event === null) continue
    try {
      const record = fold.fold(sid, event)
      if (record !== null) records.push(record)
    } catch {
      // A malformed row must not abort the session's backfill.
    }
  }
  return records
}

/**
 * Discover session logs under `<dshHome>/sessions/<project>/<id>/`.
 * @param dshHome - optional explicit harness home override.
 * @returns one entry per session log file, unsorted.
 */
export function discoverSessionLogs(dshHome?: string): SessionLog[] {
  const home = dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const sessionsRoot = join(home, 'sessions')
  const logs: SessionLog[] = []
  let projects: string[] = []
  try {
    projects = readdirSync(sessionsRoot)
  } catch {
    return logs
  }
  for (const project of projects) {
    let ids: string[] = []
    try {
      ids = readdirSync(join(sessionsRoot, project))
    } catch {
      continue
    }
    for (const id of ids) {
      // The artifact name carries the format generation since the V3 format
      // (dsh 0.1.5-rc.1): `session.v3.jsonl[.zstd]`; legacy sessions keep
      // `session.jsonl[.zstd]`. Prefer the current generation, compressed
      // over raw — the first that exists wins (a preserved V0 sibling of a
      // migrated session would double-count nothing: aggregation dedupes on
      // (sid, turn, step), but one log per session keeps TTFT sources clean).
      for (const suffix of ['session.v3.jsonl.zstd', 'session.v3.jsonl', 'session.jsonl.zstd', 'session.jsonl'] as const) {
        const path = join(sessionsRoot, project, id, suffix)
        try {
          logs.push({ id, path, mtime: statSync(path).mtimeMs })
          break
        } catch {
          // Try the next suffix (current generation, then zstd preferred).
        }
      }
    }
  }
  return logs
}

/** Runs one backfill pass and returns what it did. */
export interface BackfillOutcome {
  /** Log files examined. */
  scanned: number
  /** Sessions whose records were added. */
  backfilled: number
  /** Sessions skipped because the done-ledger already covers them. */
  known: number
  /** Sessions that decoded fine but contain no qualifying records. */
  empty: number
  /** Step records added to the ledger. */
  records: number
  /** True when the signal aborted the pass before every log was visited. */
  aborted: boolean
}

/** Options for a backfill pass. */
export interface BackfillOptions {
  /** The ledger store to append records into. */
  store: import('./store.ts').StatsStore
  /** Retention window: records older than this are dropped, ancient sessions skipped. */
  retentionDays: number
  /** Explicit harness home override for the session-log root (tests). */
  dshHome?: string
  /** Wall-clock override (epoch ms). */
  now?: () => number
  /** Cancellation for the pass; checked between sessions. */
  signal?: AbortSignal
}

const BACKFILL_LEDGER = 'backfill.json'
/** Sessions processed between done-ledger flushes. */
const DONE_FLUSH_EVERY = 25
const DAY_MS = 86_400_000

/**
 * Run the backfill pass. Appends go to the ledger's `records.backfill.jsonl`
 * shard; the done-ledger (`backfill.json`) skips sessions already covered.
 * The pass holds the ledger's compaction lock, so a concurrent compaction
 * (this or another process) simply skips its round.
 * @param options - see {@link BackfillOptions}.
 * @returns what the pass did.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillOutcome> {
  const { store, retentionDays, signal } = options
  const now = options.now ?? Date.now
  const outcome: BackfillOutcome = { scanned: 0, backfilled: 0, known: 0, empty: 0, records: 0, aborted: false }
  const release = store.acquireLedgerLock()
  if (release === null) {
    // Another backfill or compaction holds the lock; report a no-op pass.
    return outcome
  }
  try {
    const done = readDoneLedger(store.dir)
    const cutoff = now() - retentionDays * DAY_MS
    const logs = discoverSessionLogs(options.dshHome).filter(log => log.mtime >= cutoff)
    logs.sort((a, b) => b.mtime - a.mtime)
    const appendPath = join(store.dir, 'records.backfill.jsonl')
    let unflushed = 0
    for (const log of logs) {
      if (signal?.aborted) {
        outcome.aborted = true
        break
      }
      outcome.scanned += 1
      if (done[log.id] === true) {
        outcome.known += 1
        continue
      }
      let lines: string[]
      try {
        lines = decodeLogLines(readFileSync(log.path))
      } catch {
        continue // unreadable or vanished log: leave it to a future run
      }
      const records = foldSessionLog(log.id, lines).filter(r => r.t >= cutoff)
      if (records.length > 0) {
        for (const record of records) {
          appendFileSync(appendPath, `${JSON.stringify(record)}\n`)
        }
        outcome.records += records.length
        outcome.backfilled += 1
      } else {
        outcome.empty += 1
      }
      done[log.id] = true
      unflushed += 1
      if (unflushed >= DONE_FLUSH_EVERY) {
        writeDoneLedger(store.dir, done)
        unflushed = 0
      }
      // Yield between sessions so the host's event loop stays responsive.
      await new Promise(resolve => setImmediate(resolve))
    }
    writeDoneLedger(store.dir, done)
  } finally {
    release()
  }
  return outcome
}

function writeDoneLedger(dir: string, done: Record<string, boolean>): void {
  const payload = JSON.stringify({ version: 1, sessions: done })
  const tmp = join(dir, `.${BACKFILL_LEDGER}.tmp`)
  try {
    writeFileSync(tmp, payload)
    renameSync(tmp, join(dir, BACKFILL_LEDGER))
  } catch {
    // A failed flush costs a re-scan next run, never correctness.
  }
}

function readDoneLedger(dir: string): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, BACKFILL_LEDGER), 'utf8'))
    const sessions = (parsed as { sessions?: unknown }).sessions
    if (sessions !== null && typeof sessions === 'object' && !Array.isArray(sessions)) {
      return sessions as Record<string, boolean>
    }
  } catch {
    // Absent or corrupt ledger: start empty.
  }
  return {}
}
