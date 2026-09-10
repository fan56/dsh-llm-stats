/**
 * Live event → StepRecord fold, one state machine per session.
 *
 * Mirrors the upstream `dsh-session-stats` fold semantics (the web stats
 * strip's durable projection): `step/end` is the counted and emitted anchor
 * because the agent loop appends exactly one per entered step in a `finally`;
 * model time is `step/start` → `assistant/message`; the first token is the
 * first non-empty delta chunk and survives an in-step `llm/retry` (this fold
 * never resets on retry events at all); decode spans first token → message
 * on steps carrying both timing and output tokens; tool time pairs
 * `tool/call` → `tool/result` by callId (read from
 * `message.source.callId`, where the host actually records it) and drops
 * unresolved calls.
 *
 * The fold is deliberately total: it never throws on unexpected shapes and
 * treats events for steps it did not see open as no-ops, so a billing side
 * channel can never take a live session down.
 *
 * @module @aiwayds/dsh-llm-stats/fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm'
import { RECORD_VERSION, type StepRecord } from './types.ts'

/**
 * Legacy (pre-V3 log) synthetic chunk event, produced only by the backfill's
 * packed-run translation of old logs. dsh 0.1.5-rc.1 removed `assistant/chunk`
 * from the live vocabulary — streaming settles as `assistant/attempt` /
 * `assistant/message` whose embedded `AssistantStreamRecord[]` carries the
 * original chunk timestamps — so live folds never see this shape.
 */
export interface LegacyChunkEvent {
  type: 'assistant/chunk'
  seq: number
  time: number
  data: { turn: number; step: number; chunk: unknown }
}

/** Everything the fold accepts: live session events plus the legacy backfill shape. */
export type FoldEvent = SessionEvent | LegacyChunkEvent

/** Provider/model route carried by a `request/context` event. */
export interface StepRoute {
  provider: string
  model: string
}

/** Provider usage buckets summed across a step's messages. */
interface StepUsage {
  tin: number
  cr: number
  cw: number
  out: number
}

/** Per-session in-flight fold state. */
interface SessionFoldState {
  /** Latest route seen for this session; steps before any route fall back to `unknown`. */
  route: StepRoute | null
  /** The open step's boundary facts; null outside a step. */
  open: {
    turn: number
    step: number
    startTime: number
    firstTokenTime: number | null
    messageTime: number | null
    usage: StepUsage | null
  } | null
  /** Dispatch times of in-flight tool calls, by callId. */
  pendingCalls: Map<string, number>
  /** Resolved tool pair count and summed wall time for the open step. */
  tools: number
  toolMs: number
}

/** Cap on simultaneously tracked sessions so short-lived child sessions cannot grow it unbounded. */
const MAX_TRACKED_SESSIONS = 256

/** Route stand-in for steps logged before any route became known. */
const UNKNOWN_ROUTE: StepRoute = { provider: 'unknown', model: 'unknown' }

/** Guard a usage bucket field the way the upstream projection does. */
function usageField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Whether a stream chunk carries visible model output (the first-token
 * boundary). Empty deltas (heartbeats, empty tool-call frames) do not count.
 *
 * Localized: dsh 0.1.2-alpha.3 removed the `isTokenDelta` export from
 * `@deepseek-ai/dsh-llm/message` (upstream dsh-session-stats now defines the
 * identical helper inline); the semantics here match it byte for byte.
 */
function isTokenDelta(chunk: unknown): boolean {
  if (chunk === null || typeof chunk !== 'object') return false
  const { type, text, argumentsDelta, name } = chunk as {
    type?: unknown
    text?: unknown
    argumentsDelta?: unknown
    name?: unknown
  }
  switch (type) {
    case 'text-delta':
    case 'reasoning-delta':
      return text !== ''
    case 'tool-call-delta':
      return argumentsDelta !== '' || name !== undefined
    default:
      return false
  }
}

/**
 * First-token time of one embedded `AssistantStreamRecord[]` (V3 attempt and
 * message settlements), delegated to the official reader. Total by contract:
 * a non-array or malformed stream yields null instead of throwing, matching
 * the fold's never-throw guarantee.
 */
function firstTokenFromStream(stream: unknown): number | null {
  if (!Array.isArray(stream)) return null
  try {
    return assistantStreamFirstTokenTime(stream) ?? null
  } catch {
    return null
  }
}

/**
 * Per-session fold store: feed it committed session events, collect finished
 * StepRecords. Session ids come from the `session/event` listener's session
 * argument, so child sessions that bubble to the host fold under their own
 * ids and count toward the same machine-wide ledger.
 */
export class SessionFold {
  private readonly sessions = new Map<string, SessionFoldState>()

  /**
   * Fold one committed event; a finished step returns its record.
   * @param sid - id of the session the event belongs to.
   * @param event - the committed session event (or a legacy backfill chunk).
   * @param currentRoute - the session's authoritative current route
   *   (`session.requestContext()`), when the caller can supply it. Seeding
   *   from the session object keeps attribution exact across /reload,
   *   mid-session plugin mounts, and fold-state eviction — situations where
   *   this fold never saw the `request/context` events (they log only on
   *   change, and constructor seeds do not emit).
   * @returns the closed step's record on `step/end`, otherwise null.
   */
  fold(sid: string, event: FoldEvent, currentRoute?: StepRoute): StepRecord | null {
    if (typeof sid !== 'string' || sid === '' || event === null || typeof event !== 'object') {
      return null
    }
    const state = this.stateFor(sid)
    if (currentRoute !== undefined && typeof currentRoute.provider === 'string' && typeof currentRoute.model === 'string') {
      state.route = { provider: currentRoute.provider, model: currentRoute.model }
    }
    // Runtime guard (the type says data is always present; foreign or torn
    // events at runtime may not carry it).
    if ((event as { data?: unknown }).data === undefined || (event as { data?: unknown }).data === null) {
      return null
    }
    switch (event.type) {
      case 'request/context': {
        // Narrowed payload: { provider, model, contextWindow? }.
        const { provider, model } = event.data
        state.route = { provider, model }
        return null
      }
      case 'step/start': {
        state.open = {
          turn: event.data.turn,
          step: event.data.step,
          startTime: event.time,
          firstTokenTime: null,
          messageTime: null,
          usage: null,
        }
        state.tools = 0
        state.toolMs = 0
        return null
      }
      case 'assistant/chunk': {
        // Legacy backfill path only (pre-V3 packed-run logs); see LegacyChunkEvent.
        const legacy = event as LegacyChunkEvent
        const open = state.open
        if (open === null || open.firstTokenTime !== null) return null
        if (isTokenDelta(legacy.data.chunk)) {
          open.firstTokenTime = legacy.time
        }
        return null
      }
      case 'assistant/attempt': {
        // A settled attempt that produced no surface message (failed, retried,
        // or cancelled). Its embedded stream carries the original chunk times,
        // so a first token spent on an attempt that later failed still counts,
        // matching the old live-chunk semantics.
        const open = state.open
        if (open === null || open.firstTokenTime !== null) return null
        const firstToken = firstTokenFromStream(event.data.stream)
        if (firstToken !== null) open.firstTokenTime = firstToken
        return null
      }
      case 'assistant/message': {
        const open = state.open
        if (open === null) return null
        if (open.firstTokenTime === null) {
          const firstToken = firstTokenFromStream(event.data.stream)
          if (firstToken !== null) open.firstTokenTime = firstToken
        }
        if (open.messageTime === null) open.messageTime = event.time
        const usage = event.data.usage
        if (usage !== undefined) {
          // Sum every usage-bearing message of the step (retry re-asks land
          // as distinct messages here, unlike the durable log's replace-per-
          // (turn,step) projection — live steps carry one message each in
          // practice, and a second one is additional billed work).
          open.usage ??= { tin: 0, cr: 0, cw: 0, out: 0 }
          open.usage.tin += usageField(usage.inputTokens)
          open.usage.out += usageField(usage.outputTokens)
          open.usage.cr += usageField(usage.cacheReadTokens)
          open.usage.cw += usageField(usage.cacheWriteTokens)
        }
        return null
      }
      case 'tool/call': {
        state.pendingCalls.set(event.data.callId, event.time)
        return null
      }
      case 'tool/result': {
        // The correlation id rides the result message's source, not the event.
        const callId = event.data.message?.source?.callId
        if (typeof callId === 'string') {
          const dispatch = state.pendingCalls.get(callId)
          if (dispatch !== undefined) {
            state.pendingCalls.delete(callId)
            state.tools += 1
            state.toolMs += Math.max(0, event.time - dispatch)
          }
        }
        return null
      }
      case 'step/end': {
        return this.close(sid, state, event.time)
      }
      default:
        // Plugin-extended or unrecognized vocabulary is irrelevant here.
        return null
    }
  }

  /** Forget one session's in-flight state (used when the tracker sheds sessions). */
  forget(sid: string): void {
    this.sessions.delete(sid)
  }

  /**
   * Close the open step into a record; a step this fold never saw open is a
   * no-op (its start predates the plugin fiber, e.g. after /reload).
   */
  private close(sid: string, state: SessionFoldState, endTime: number): StepRecord | null {
    const open = state.open
    state.open = null
    state.pendingCalls.clear()
    const tools = state.tools
    const toolMs = state.toolMs
    state.tools = 0
    state.toolMs = 0
    if (open === null) return null
    const route = state.route ?? UNKNOWN_ROUTE
    const usage = open.usage
    const decodeReady = open.firstTokenTime !== null && usage !== null && open.messageTime !== null
    return {
      v: RECORD_VERSION,
      sid,
      turn: open.turn,
      step: open.step,
      t: endTime,
      prov: route.provider,
      model: route.model,
      tin: usage?.tin ?? null,
      cr: usage?.cr ?? null,
      cw: usage?.cw ?? null,
      out: usage?.out ?? null,
      llmMs: open.messageTime === null ? null : Math.max(0, open.messageTime - open.startTime),
      ttftMs: open.firstTokenTime === null ? null : Math.max(0, open.firstTokenTime - open.startTime),
      decMs: decodeReady ? Math.max(0, (open.messageTime ?? 0) - (open.firstTokenTime ?? 0)) : null,
      decTk: decodeReady ? usage?.out ?? null : null,
      tools,
      toolMs,
    }
  }

  /** State accessor with recency-ordered eviction of the oldest idle sessions. */
  private stateFor(sid: string): SessionFoldState {
    let state = this.sessions.get(sid)
    if (state !== undefined) {
      // Refresh insertion order so the map acts as a recency list.
      this.sessions.delete(sid)
      this.sessions.set(sid, state)
      return state
    }
    while (this.sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      this.sessions.delete(oldest.value)
    }
    state = { route: null, open: null, pendingCalls: new Map(), tools: 0, toolMs: 0 }
    this.sessions.set(sid, state)
    return state
  }
}
