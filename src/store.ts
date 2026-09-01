/**
 * Append-only sharded ledger store under `$DSH_HOME/llm-stats/`.
 *
 * Every dsh process owns exactly one shard file it appends to and never
 * rewrites while alive; shared-file read-modify-write is the double-writer
 * hazard this design exists to avoid (see the dsh multi-writer session
 * incident). Dead shards — owners whose pid is gone, or files idle past a
 * hard wall — are merged into `baseline.jsonl` under a lock directory during
 * compaction, which is also where retention (`retentionDays`) drops expired
 * records. A live shard's own expired lines are simply left in place; they
 * are filtered at aggregation time and its shard gets compacted by whichever
 * process runs cleanup after this one exits.
 *
 * Durability stance: this is a billing side channel, not session truth.
 * Writes are plain appends without fsync (an OS crash may lose the tail);
 * malformed lines are skipped on read, never thrown.
 *
 * @module @aiwayds/dsh-llm-stats/store
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { RECORD_VERSION, type StepRecord } from './types.ts'

/** Directory name under the dsh home. */
export const STORE_DIR_NAME = 'llm-stats'
/** Baseline file name (merged dead-shard records). */
export const BASELINE_NAME = 'baseline.jsonl'
/** Lock directory name; created exclusively with mkdir. */
export const LOCK_NAME = 'compact.lock'
/** A lock older than this is stale and gets taken over. */
const LOCK_STALE_MS = 10 * 60_000
/** A shard idle this long belongs to a dead process even if its pid was reused. */
const SHARD_DEAD_MS = 48 * 3_600_000
/** Shard file name prefix. */
const SHARD_PREFIX = 'records.'
/** Records at or older than this age (ms) are retention-expired. */
const DAY_MS = 86_400_000

/** Dedupe key of one step: (sid, turn, step) is unique within a session log. */
function recordKey(r: StepRecord): string {
  return `${r.sid}\u0000${r.turn}\u0000${r.step}`
}

function isStepRecord(value: unknown): value is StepRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return r.v === RECORD_VERSION
    && typeof r.sid === 'string' && r.sid !== ''
    && typeof r.turn === 'number' && Number.isSafeInteger(r.turn)
    && typeof r.step === 'number' && Number.isSafeInteger(r.step)
    && typeof r.t === 'number' && Number.isFinite(r.t)
    && typeof r.prov === 'string'
    && typeof r.model === 'string'
}

/**
 * Parse ledger text into records, skipping blank and malformed lines.
 * @param text - full file text.
 * @returns the valid records in file order.
 */
export function parseRecords(text: string): StepRecord[] {
  const records: StepRecord[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (isStepRecord(value)) records.push(value)
    } catch {
      // A torn or foreign line is skipped, never fatal.
    }
  }
  return records
}

/** Last-wins dedupe over (sid, turn, step). */
export function dedupeRecords(records: readonly StepRecord[]): StepRecord[] {
  const byKey = new Map<string, StepRecord>()
  for (const record of records) byKey.set(recordKey(record), record)
  return [...byKey.values()]
}

/**
 * Resolve the ledger directory: `<dshHome>/llm-stats`, where `dshHome` is an
 * explicit override, `$DSH_HOME` (blank = unset), or `~/.dsh` — the same
 * precedence as the harness home resolver, implemented locally so the plugin
 * stays dependency-light.
 * @param dshHome - optional explicit harness home override.
 * @returns the absolute ledger directory (not created).
 */
export function resolveStoreDir(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME
  const selected = home !== undefined && home.trim().length > 0 ? home : join(process.env.HOME ?? '', '.dsh')
  const expanded = selected.startsWith('~/') ? join(process.env.HOME ?? '', selected.slice(2)) : selected
  return join(resolve(expanded), STORE_DIR_NAME)
}

/** Injection seam for tests: wall clock and process identity. */
export interface StoreOptions {
  /** Wall-clock override (epoch ms). */
  now?: () => number
  /** Process identity override for shard naming and liveness checks. */
  pid?: number
  /** Shard dead-wall override (ms). */
  shardDeadMs?: number
}

/**
 * One process's view of the ledger. Construct once per plugin fiber; append
 * freely from the session-event path (synchronous, one line per step), and
 * run `compact()` off the hot path for retention and dead-shard merging.
 */
export class StatsStore {
  /** Absolute ledger directory. */
  readonly dir: string
  private readonly now: () => number
  private readonly pid: number
  private readonly shardDeadMs: number
  private readonly shardName: string
  private fd: number | null = null
  /** Inode the open fd points at; a mismatch means the file was replaced/unlinked under us. */
  private fdIno: number | null = null

  constructor(dir: string, options: StoreOptions = {}) {
    this.dir = dir
    this.now = options.now ?? Date.now
    this.pid = options.pid ?? process.pid
    this.shardDeadMs = options.shardDeadMs ?? SHARD_DEAD_MS
    this.shardName = `${SHARD_PREFIX}${this.pid.toString(36)}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.jsonl`
    mkdirSync(this.dir, { recursive: true })
  }

  /** This fiber's shard file path. */
  get shardPath(): string {
    return join(this.dir, this.shardName)
  }

  /**
   * Append one record as a single line. Sync write-through: step ends are
   * low-frequency (one per model call) and a failed write must never take
   * the session down, so errors are swallowed — the line is lost and the
   * session keeps running.
   *
   * Before every write the shard file is checked against the open fd's
   * inode: a concurrent compaction that judged this process dead and
   * unlinked the shard would otherwise leave the fd appending to an
   * orphaned inode, silently losing every later record. On mismatch the fd
   * is rolled to a fresh file at the same path.
   * @param record - the closed step's record.
   */
  append(record: StepRecord): void {
    const line = `${JSON.stringify(record)}\n`
    try {
      this.ensureLiveFd()
      if (this.fd === null) {
        this.fd = openSync(this.shardPath, 'a')
        this.fdIno = fstatSync(this.fd).ino
      }
      writeSync(this.fd, line)
    } catch {
      // Best-effort by design; drop the line rather than surface an error.
      // A dead descriptor must not wedge every later append.
      this.resetFd()
    }
  }

  /**
   * Reopen the append fd when the on-disk shard no longer matches it
   * (unlinked by another process's compaction, or a rolled file).
   */
  private ensureLiveFd(): void {
    if (this.fd === null) return
    try {
      const onDisk = statSync(this.shardPath)
      if (this.fdIno !== null && onDisk.ino === this.fdIno) return
    } catch {
      // Missing file: fall through and re-create it.
    }
    this.resetFd()
  }

  /** Close (and forget) the current fd so the next append opens a fresh file. */
  private resetFd(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // Already closed.
      }
      this.fd = null
      this.fdIno = null
    }
  }

  /**
   * Read every record in the ledger: baseline first, then all shards
   * (including this fiber's), in directory order. Malformed lines and
   * foreign files are skipped. Records are pushed in a loop — spreading a
   * large file's array overflows the call stack at ~150K records, which is
   * reachable within the default retention window.
   * @returns valid records across the whole ledger.
   */
  readAll(): StepRecord[] {
    const records: StepRecord[] = []
    const files = this.listFiles()
    if (files.includes(BASELINE_NAME)) {
      for (const record of this.readFile(join(this.dir, BASELINE_NAME))) records.push(record)
    }
    for (const name of files) {
      if (name.startsWith(SHARD_PREFIX)) {
        for (const record of this.readFile(join(this.dir, name))) records.push(record)
      }
    }
    return records
  }

  /**
   * Take the compaction lock (single attempt, no waiting): a caller that
   * loses the race skips this round — another live process is doing the work.
   *
   * The lock is a directory carrying an owner file; stale takeovers go
   * through an atomic rename so two simultaneous judgers can never both end
   * up holding it, and release deletes the directory only when the owner
   * file still names us.
   * @returns the lock release thunk, or null when a healthy lock is held elsewhere.
   */
  private acquireLock(): (() => void) | null {
    const lockPath = join(this.dir, LOCK_NAME)
    const owner = `${this.pid}\u0000${this.shardName}`
    const mkOwner = (): void => {
      writeFileSync(join(lockPath, 'owner'), owner)
    }
    const owned = (): boolean => {
      try {
        return readFileSync(join(lockPath, 'owner'), 'utf8') === owner
      } catch {
        return false
      }
    }
    try {
      mkdirSync(lockPath)
      mkOwner()
      return () => {
        if (owned()) rmSync(lockPath, { recursive: true, force: true })
      }
    } catch {
      let stale = false
      try {
        stale = this.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
      } catch {
        stale = false
      }
      if (!stale) return null
      try {
        // Take over a stale lock by renaming it aside atomically: a rival
        // takeover's rename throws and it skips the round instead of both
        // re-creating the lock and later deleting each other's hold.
        renameSync(lockPath, `${lockPath}.stale-${this.pid}-${randomBytes(3).toString('hex')}`)
        mkdirSync(lockPath)
        mkOwner()
        return () => {
          if (owned()) rmSync(lockPath, { recursive: true, force: true })
        }
      } catch {
        return null
      }
    }
  }

  /** Ledger file names (baseline + shards), no subdirectories. */
  private listFiles(): string[] {
    try {
      return readdirSync(this.dir).filter(name => name === BASELINE_NAME || name.startsWith(SHARD_PREFIX))
    } catch {
      return []
    }
  }

  private readFile(path: string): StepRecord[] {
    try {
      return parseRecords(readFileSync(path, 'utf8'))
    } catch {
      return []
    }
  }

  /** Decide whether a shard's owning process is gone. */
  private shardDead(name: string): boolean {
    if (name === this.shardName) return false
    const path = join(this.dir, name)
    let idleMs = 0
    try {
      idleMs = this.now() - statSync(path).mtimeMs
    } catch {
      return false
    }
    if (idleMs > this.shardDeadMs) return true
    const pid = Number.parseInt(name.slice(SHARD_PREFIX.length), 36)
    if (!Number.isFinite(pid) || pid <= 0) return false
    if (pid === this.pid) return false
    try {
      // Signal 0 probes liveness without signalling.
      process.kill(pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }

  /**
   * Merge dead shards into a retention-filtered, deduped baseline and delete
   * the merged files. The live shard (this fiber's) is never touched; its
   * mtime is refreshed first so a process that compacts on cadence can
   * never trip another process's idle wall (a laptop asleep over a weekend
   * wakes with its shard intact).
   * @param retentionDays - drop records older than this many days; null skips retention filtering.
   * @returns the number of records written into the new baseline.
   */
  compact(retentionDays: number | null): number {
    // Heartbeat: prove this shard's owner is alive even if it has appended
    // nothing lately; the idle wall then only ever catches true orphans.
    try {
      const path = this.shardPath
      if (existsSync(path)) utimesSync(path, new Date(this.now()), new Date(this.now()))
    } catch {
      // The shard may not exist yet (nothing appended); nothing to prove.
    }
    const release = this.acquireLock()
    if (release === null) return 0
    try {
      const cutoff = retentionDays === null ? null : this.now() - retentionDays * DAY_MS
      const dead: string[] = []
      const records: StepRecord[] = []
      for (const name of this.listFiles()) {
        const path = join(this.dir, name)
        if (name === BASELINE_NAME || this.shardDead(name)) {
          for (const record of this.readFile(path)) records.push(record)
          if (name !== BASELINE_NAME) dead.push(name)
        }
      }
      const kept = dedupeRecords(records).filter(r => cutoff === null || r.t >= cutoff)
      kept.sort((a, b) => a.t - b.t)
      const payload = kept.map(r => JSON.stringify(r)).join('\n')
      const tmp = join(this.dir, `.${BASELINE_NAME}.tmp-${this.pid}`)
      writeFileSync(tmp, needsNewline(payload))
      renameSync(tmp, join(this.dir, BASELINE_NAME))
      for (const name of dead) {
        try {
          unlinkSync(join(this.dir, name))
        } catch {
          // A concurrent takeover may have removed it already.
        }
      }
      return kept.length
    } catch {
      // A failed compaction round is a no-op; the next one retries.
      return 0
    } finally {
      release()
    }
  }

  /** Close this fiber's append handle (idempotent). */
  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // Already closed.
      }
      this.fd = null
    }
  }
}

function needsNewline(payload: string): string {
  return payload === '' ? '' : `${payload}\n`
}
