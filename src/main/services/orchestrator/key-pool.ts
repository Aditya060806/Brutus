/**
 * BRUTUS Orchestrator — Groq API key pool
 * ----------------------------------------
 * Multi-agent runs fire several LLM calls at once. On Groq's free tier a single
 * key runs into per-minute request/token limits almost immediately, and the run
 * either stalls or degrades to a weaker provider for no good reason.
 *
 * This pool spreads that load. Give it N keys and it:
 *   • hands out the least-loaded healthy key per request (round-robin, biased
 *     away from keys with calls already in flight);
 *   • on a 429 / quota error, parks that key for a cooldown and reports
 *     `retryable`, so the caller can immediately re-run the SAME call on the
 *     next healthy key — the agent never sees the rate limit;
 *   • only reports exhaustion when every key is cooling down, which is the
 *     signal for the router to fall through to another provider entirely;
 *   • treats auth errors (401/403) as permanent and disables that key for the
 *     session rather than retrying it forever.
 *
 * Cooldown honours the server's `retry-after` when present, because guessing
 * shorter than the server wants just burns the key again.
 */

export interface KeyLease {
  key: string
  index: number
}

interface KeyState {
  key: string
  inFlight: number
  cooldownUntil: number
  /** Permanently disabled for this session (bad key). */
  dead: boolean
  lastError: string | null
  successes: number
  failures: number
  /** When this key last started a request, for proactive pacing. */
  lastUsedAt: number
}

/** Reported to the UI so you can see which keys are hot. */
export interface KeyPoolStatus {
  total: number
  healthy: number
  cooling: number
  dead: number
  keys: {
    /** Masked — never expose the raw key to the renderer. */
    label: string
    inFlight: number
    coolingForMs: number
    dead: boolean
    successes: number
    failures: number
    lastError: string | null
  }[]
}

const DEFAULT_COOLDOWN_MS = 20_000
const MAX_COOLDOWN_MS = 120_000

/**
 * Minimum gap between two requests on the SAME key.
 *
 * Groq's free tier is around 30 requests/minute per key, so ~2.1s spacing keeps
 * one key just under the limit. This is *proactive* pacing: reacting to 429s
 * afterwards still burns quota and stalls runs, whereas spacing means the limit
 * is rarely reached at all. Aggregate throughput scales with key count, so N
 * keys give roughly N × 28 requests/minute.
 */
const DEFAULT_MIN_INTERVAL_MS = 2100

/** True when an error from Groq means "try again on another key". */
export function isRateLimitError(err: unknown): boolean {
  const e = err as { status?: number; message?: string }
  if (e?.status === 429) return true
  const msg = String(e?.message || err || '').toLowerCase()
  return (
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('quota')
  )
}

/** True when the key itself is bad and retrying is pointless. */
export function isAuthError(err: unknown): boolean {
  const e = err as { status?: number; message?: string }
  if (e?.status === 401 || e?.status === 403) return true
  const msg = String(e?.message || err || '').toLowerCase()
  return (
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('unauthorized') ||
    msg.includes('authentication')
  )
}

/** Pull `retry-after` (seconds) out of a provider error if it gave one. */
function retryAfterMs(err: unknown): number | null {
  const e = err as { headers?: Record<string, string>; message?: string }
  const header = e?.headers?.['retry-after'] || e?.headers?.['Retry-After']
  if (header) {
    const secs = Number(header)
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, MAX_COOLDOWN_MS)
  }
  // Groq often phrases it in the message: "Please try again in 7.5s"
  const m = String(e?.message || '').match(/try again in ([\d.]+)s/i)
  if (m) {
    const secs = parseFloat(m[1])
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000 + 500, MAX_COOLDOWN_MS)
  }
  return null
}

export class KeyPool {
  private states: KeyState[] = []
  private cursor = 0
  private minIntervalMs: number

  constructor(keys: string[] = [], minIntervalMs = DEFAULT_MIN_INTERVAL_MS) {
    this.minIntervalMs = Math.max(0, minIntervalMs)
    this.setKeys(keys)
  }

  setMinInterval(ms: number): void {
    this.minIntervalMs = Math.max(0, ms)
  }

  /** Replace the pool, preserving health for keys that are still present. */
  setKeys(keys: string[]): void {
    const cleaned = Array.from(
      new Set(keys.map((k) => String(k || '').trim()).filter((k) => k.length > 0))
    )
    const previous = new Map(this.states.map((s) => [s.key, s]))
    this.states = cleaned.map(
      (key) =>
        previous.get(key) ?? {
          key,
          inFlight: 0,
          cooldownUntil: 0,
          dead: false,
          lastError: null,
          successes: 0,
          failures: 0,
          lastUsedAt: 0
        }
    )
    if (this.cursor >= this.states.length) this.cursor = 0
  }

  get size(): number {
    return this.states.length
  }

  get hasKeys(): boolean {
    return this.states.length > 0
  }

  /** Not dead and not in a 429 cooldown. */
  private isHealthy(s: KeyState, now: number): boolean {
    return !s.dead && s.cooldownUntil <= now
  }

  /** Healthy AND far enough past its last request to respect the rate limit. */
  private isReady(s: KeyState, now: number): boolean {
    return this.isHealthy(s, now) && now - s.lastUsedAt >= this.minIntervalMs
  }

  get available(): boolean {
    const now = Date.now()
    return this.states.some((s) => this.isReady(s, now))
  }

  /** True when at least one key is not dead — i.e. waiting could still help. */
  get recoverable(): boolean {
    return this.states.some((s) => !s.dead)
  }

  /**
   * How long until a key frees up, or null when every key is permanently dead.
   *
   * Rate limits are temporary — a Groq free-tier minute window resets in
   * seconds. Treating "everything is cooling right now" as a hard failure threw
   * away runs that only needed to pause briefly, which is exactly what a single
   * key plus parallel agents produces.
   */
  msUntilAvailable(): number | null {
    const now = Date.now()
    const live = this.states.filter((s) => !s.dead)
    if (!live.length) return null
    if (live.some((s) => this.isReady(s, now))) return 0
    // Whichever frees up first: a 429 cooldown expiring, or a paced key
    // becoming eligible again.
    return Math.max(
      0,
      Math.min(
        ...live.map((s) =>
          Math.max(s.cooldownUntil - now, this.minIntervalMs - (now - s.lastUsedAt), 0)
        )
      )
    )
  }

  /** Human-readable reason the pool cannot serve right now. */
  unavailableReason(): string {
    const now = Date.now()
    if (!this.states.length) return 'no Groq API keys configured'
    const dead = this.states.filter((s) => s.dead)
    if (dead.length === this.states.length) {
      return `all ${dead.length} Groq key(s) rejected as invalid: ${dead[0]?.lastError ?? 'unauthorized'}`
    }
    const wait = this.msUntilAvailable()
    const cooling = this.states.filter((s) => !s.dead && s.cooldownUntil > now)
    if (!cooling.length) {
      // Nothing is in a 429 cooldown, so we are simply pacing to stay under the
      // per-key rate limit. That is normal operation, not an error.
      return `throttling to stay under the Groq rate limit${
        wait ? `, next key free in ${Math.ceil(wait / 1000)}s` : ''
      }`
    }
    return (
      `all ${cooling.length} usable Groq key(s) are rate-limited` +
      (wait ? `, next free in ${Math.ceil(wait / 1000)}s` : '') +
      (cooling[0]?.lastError ? ` (${cooling[0].lastError})` : '')
    )
  }

  /**
   * Take the least-loaded healthy key. Returns null when every key is dead or
   * cooling — the router reads that as "this provider is exhausted, move on".
   */
  acquire(): KeyLease | null {
    const now = Date.now()
    const n = this.states.length
    if (n === 0) return null

    let best: { state: KeyState; index: number } | null = null
    // Start from the cursor so equal-load keys still rotate evenly. `isReady`
    // (not `isHealthy`) enforces the per-key rate limit, so a key that was used
    // moments ago is skipped in favour of a rested one.
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n
      const s = this.states[idx]
      if (!this.isReady(s, now)) continue
      if (!best || s.inFlight < best.state.inFlight) best = { state: s, index: idx }
      if (best.state.inFlight === 0) break // can't do better than idle
    }
    if (!best) return null

    this.cursor = (best.index + 1) % n
    best.state.inFlight++
    best.state.lastUsedAt = now
    return { key: best.state.key, index: best.index }
  }

  release(lease: KeyLease | null): void {
    if (!lease) return
    const s = this.states[lease.index]
    if (s) s.inFlight = Math.max(0, s.inFlight - 1)
  }

  reportSuccess(lease: KeyLease): void {
    const s = this.states[lease.index]
    if (!s) return
    s.successes++
    s.lastError = null
    // A success proves the key recovered; clear any lingering cooldown.
    s.cooldownUntil = 0
  }

  /**
   * Record a failure. Returns true when the caller should retry the same
   * request on a different key (rate limit, and another key is available).
   */
  reportFailure(lease: KeyLease, err: unknown): boolean {
    const s = this.states[lease.index]
    if (!s) return false
    s.failures++
    s.lastError = String((err as { message?: string })?.message || err).slice(0, 200)

    if (isAuthError(err)) {
      s.dead = true
      return this.available
    }
    if (isRateLimitError(err)) {
      s.cooldownUntil = Date.now() + (retryAfterMs(err) ?? DEFAULT_COOLDOWN_MS)
      return this.available
    }
    // Anything else (bad model id, network, 500) is not a key problem — let the
    // router decide whether to try another model or provider.
    return false
  }

  status(): KeyPoolStatus {
    const now = Date.now()
    return {
      total: this.states.length,
      healthy: this.states.filter((s) => this.isHealthy(s, now)).length,
      cooling: this.states.filter((s) => !s.dead && s.cooldownUntil > now).length,
      dead: this.states.filter((s) => s.dead).length,
      keys: this.states.map((s, i) => ({
        label: `key ${i + 1} ···${s.key.slice(-4)}`,
        inFlight: s.inFlight,
        coolingForMs: Math.max(0, s.cooldownUntil - now),
        dead: s.dead,
        successes: s.successes,
        failures: s.failures,
        lastError: s.lastError
      }))
    }
  }
}
