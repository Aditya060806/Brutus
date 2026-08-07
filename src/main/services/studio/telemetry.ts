/**
 * BRUTUS Studio — telemetry
 * --------------------------
 * Structured events, spans and metrics for the one part of Brutus where
 * several autonomous processes act at once. When a multi-agent run goes wrong
 * the question is never "did it fail" — it is *which* agent, *which* edge, and
 * *how long* it sat there before it did.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Studio already emitted log lines. Nothing consumed them: the renderer defined
 * a subscription and never called it, so every policy decision, git merge and
 * routing hop was formatted, sent over IPC and dropped. Logging nobody can read
 * is worse than no logging, because it looks like coverage.
 *
 * ── SHAPE ──────────────────────────────────────────────────────────────────
 * Events are records, not sentences. A message is still carried for display,
 * but the fields beside it are what make a run answerable after the fact.
 *
 * A **span** is an operation with a duration and an outcome. A **trace** is one
 * human prompt and everything it caused — which is exactly what the router
 * already calls a cascade, so cascade ids are trace ids rather than a second
 * parallel notion of "a run".
 *
 * Everything is bounded. A long session must not grow memory, so the event log
 * is a ring buffer and histograms keep summary statistics rather than samples.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface TelemetryEvent {
  /** Monotonic within a process; used for ordering and as a React key. */
  seq: number
  ts: number
  level: LogLevel
  /** Subsystem: 'policy' | 'git' | 'router' | 'command' | 'studio' | … */
  scope: string
  /** Short machine-readable name, e.g. 'turn.complete'. */
  event: string
  /** Human sentence for display. */
  message: string
  /** Structured detail — the part that makes this answerable later. */
  fields?: Record<string, unknown>
  /** The cascade this belongs to, when it belongs to one. */
  traceId?: string
  spanId?: string
  /** Duration in milliseconds, present on span-end events. */
  durationMs?: number
}

/** Events kept for the Activity panel. Older ones fall off the front. */
const MAX_EVENTS = 500

export interface Histogram {
  count: number
  totalMs: number
  minMs: number
  maxMs: number
  /** Arithmetic mean, precomputed so the UI does no maths. */
  avgMs: number
}

export interface MetricsSnapshot {
  counters: Record<string, number>
  durations: Record<string, Histogram>
}

export interface SpanHandle {
  id: string
  traceId?: string
  /**
   * Close the span, recording its duration and outcome.
   *
   * The outcome is a free string rather than a fixed pair, because callers have
   * meaningful outcomes of their own — a merge ends `merged`, `conflict` or
   * `nothing-to-do`, and flattening those to "ok/error" would throw away the
   * distinction that makes the metric worth having. Anything other than `ok`
   * is recorded at warn level.
   */
  end(outcome?: string, fields?: Record<string, unknown>): void
  /** Close the span as failed, recording the reason. */
  fail(error: unknown, fields?: Record<string, unknown>): void
}

type Sink = (event: TelemetryEvent) => void

/**
 * The recorder.
 *
 * A class rather than module state so tests get a fresh one per case and the
 * app gets exactly one, wired at registration. No global mutable singleton to
 * reason about.
 */
export class Telemetry {
  private events: TelemetryEvent[] = []
  private counters = new Map<string, number>()
  private durations = new Map<string, { count: number; total: number; min: number; max: number }>()
  private sinks = new Set<Sink>()
  private seq = 0
  private spanSeq = 0

  constructor(private now: () => number = Date.now) {}

  /** Subscribe to the live stream. Returns an unsubscribe. */
  onEvent(sink: Sink): () => void {
    this.sinks.add(sink)
    return () => this.sinks.delete(sink)
  }

  record(
    level: LogLevel,
    scope: string,
    event: string,
    message: string,
    fields?: Record<string, unknown>,
    trace?: { traceId?: string; spanId?: string; durationMs?: number }
  ): TelemetryEvent {
    const entry: TelemetryEvent = {
      seq: ++this.seq,
      ts: this.now(),
      level,
      scope,
      event,
      message,
      ...(fields && Object.keys(fields).length ? { fields } : {}),
      ...(trace?.traceId ? { traceId: trace.traceId } : {}),
      ...(trace?.spanId ? { spanId: trace.spanId } : {}),
      ...(typeof trace?.durationMs === 'number' ? { durationMs: trace.durationMs } : {})
    }

    this.events.push(entry)
    // Trim from the front so the newest are always kept.
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)

    this.count(`${scope}.${event}`)

    // One bad subscriber must not stop the rest, nor the operation being logged.
    for (const sink of this.sinks) {
      try {
        sink(entry)
      } catch (err) {
        console.error('[Studio] telemetry sink threw:', err)
      }
    }
    return entry
  }

  debug = (s: string, e: string, m: string, f?: Record<string, unknown>): TelemetryEvent =>
    this.record('debug', s, e, m, f)
  info = (s: string, e: string, m: string, f?: Record<string, unknown>): TelemetryEvent =>
    this.record('info', s, e, m, f)
  warn = (s: string, e: string, m: string, f?: Record<string, unknown>): TelemetryEvent =>
    this.record('warn', s, e, m, f)
  error = (s: string, e: string, m: string, f?: Record<string, unknown>): TelemetryEvent =>
    this.record('error', s, e, m, f)

  count(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }

  observe(name: string, ms: number): void {
    const h = this.durations.get(name)
    if (!h) this.durations.set(name, { count: 1, total: ms, min: ms, max: ms })
    else {
      h.count++
      h.total += ms
      h.min = Math.min(h.min, ms)
      h.max = Math.max(h.max, ms)
    }
  }

  /**
   * Begin a timed operation.
   *
   * The handle must be ended exactly once; ending twice is ignored rather than
   * double-counted, because an operation that both resolves and rejects (a
   * race, a timeout beaten by a late success) is exactly when metrics matter
   * and exactly when they are easiest to corrupt.
   */
  startSpan(
    scope: string,
    event: string,
    fields?: Record<string, unknown>,
    traceId?: string
  ): SpanHandle {
    const startedAt = this.now()
    const spanId = `sp_${++this.spanSeq}`
    let closed = false

    this.record('debug', scope, `${event}.start`, `${event} started`, fields, { traceId, spanId })

    const finish = (level: LogLevel, outcome: string, extra?: Record<string, unknown>): void => {
      if (closed) return
      closed = true
      const durationMs = this.now() - startedAt
      this.observe(`${scope}.${event}`, durationMs)
      this.record(
        level,
        scope,
        `${event}.${outcome}`,
        `${event} ${outcome} in ${durationMs}ms`,
        { ...fields, ...extra },
        { traceId, spanId, durationMs }
      )
    }

    return {
      id: spanId,
      traceId,
      end: (outcome = 'ok', extra) => finish(outcome === 'ok' ? 'info' : 'warn', outcome, extra),
      fail: (error, extra) =>
        finish('error', 'error', {
          ...extra,
          error: String((error as { message?: string })?.message ?? error)
        })
    }
  }

  /** Newest last. `since` returns only events after a sequence number. */
  snapshot(since = 0): TelemetryEvent[] {
    return since > 0 ? this.events.filter((e) => e.seq > since) : this.events.slice()
  }

  metrics(): MetricsSnapshot {
    const durations: Record<string, Histogram> = {}
    for (const [name, h] of this.durations) {
      durations[name] = {
        count: h.count,
        totalMs: Math.round(h.total),
        minMs: Math.round(h.min),
        maxMs: Math.round(h.max),
        avgMs: Math.round(h.total / h.count)
      }
    }
    return { counters: Object.fromEntries(this.counters), durations }
  }

  /** Drop everything. Used by tests and by an explicit "clear" in the panel. */
  clear(): void {
    this.events = []
    this.counters.clear()
    this.durations.clear()
    this.seq = 0
  }
}

/**
 * Parse the `[scope] message` convention the existing call sites already use.
 *
 * Rather than rewrite dozens of `log('[policy] …')` calls — churn with no
 * behavioural gain and plenty of room for typos — the existing shape is read
 * into structured form. New code calls the levelled methods directly.
 */
export function parseLegacyLine(line: string): { scope: string; message: string } {
  const match = /^\[([a-z0-9_-]+)\]\s*(.*)$/i.exec(line.trim())
  return match ? { scope: match[1], message: match[2] } : { scope: 'studio', message: line.trim() }
}
