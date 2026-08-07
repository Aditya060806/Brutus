import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { RiCloseLine, RiDeleteBinLine, RiPulseLine } from 'react-icons/ri'
import { studio, type LogLevel, type TelemetryEvent } from '@renderer/services/studio-client'

/**
 * What Studio is doing, as it does it.
 *
 * A canvas of autonomous agents is opaque by nature: work moves between
 * terminals on its own, and when it goes wrong the question is never "did it
 * fail" but *which* agent, *which* edge, and how long it sat there first.
 *
 * Events already existed and went nowhere — the main process formatted them,
 * sent them over IPC and nothing subscribed. This is the consumer.
 *
 * Grouped by trace, because a cascade is the unit a person actually reasons
 * about: one prompt and everything it set off.
 */

const LEVEL_STYLE: Record<LogLevel, { dot: string; text: string }> = {
  debug: { dot: 'bg-zinc-600', text: 'text-zinc-500' },
  info: { dot: 'bg-sky-400', text: 'text-zinc-300' },
  warn: { dot: 'bg-amber-400', text: 'text-amber-300' },
  error: { dot: 'bg-red-500', text: 'text-red-300' }
}

const SCOPE_TINT: Record<string, string> = {
  policy: 'text-amber-400',
  git: 'text-emerald-400',
  router: 'text-red-400',
  command: 'text-sky-400',
  studio: 'text-zinc-400',
  project: 'text-purple-400',
  mission: 'text-red-300'
}

/** Events kept in the panel. The main process bounds its own buffer too. */
const MAX_RENDERED = 400

function time(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export default function ActivityPanel({ onClose }: { onClose: () => void }): ReactElement {
  const [events, setEvents] = useState<TelemetryEvent[]>([])
  const [minLevel, setMinLevel] = useState<LogLevel>('info')
  const [scope, setScope] = useState<string>('all')
  const reduceMotion = useReducedMotion()
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // Backfill what happened before the panel opened, then follow the stream.
  useEffect(() => {
    let cancelled = false
    void studio.activity().then((a) => {
      if (!cancelled) setEvents(a.events.slice(-MAX_RENDERED))
    })
    const off = studio.onTelemetry((e) => {
      setEvents((prev) => {
        const next = [...prev, e]
        return next.length > MAX_RENDERED ? next.slice(next.length - MAX_RENDERED) : next
      })
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  /**
   * Follow the tail, but only while the reader is already at the bottom.
   *
   * Yanking the view down while someone is reading back through a failure is
   * the fastest way to make a live log useless.
   */
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [events])

  const scopes = useMemo(() => Array.from(new Set(events.map((e) => e.scope))).sort(), [events])

  const visible = useMemo(() => {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error']
    const floor = order.indexOf(minLevel)
    return events.filter(
      (e) => order.indexOf(e.level) >= floor && (scope === 'all' || e.scope === scope)
    )
  }, [events, minLevel, scope])

  return (
    <motion.div
      initial={reduceMotion ? false : { x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={reduceMotion ? undefined : { x: 24, opacity: 0 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 30 }}
      className="studio-glass pointer-events-auto flex h-full w-[380px] flex-col rounded-2xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
        <RiPulseLine size={14} className="text-red-400" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
          Activity
        </span>
        <span className="font-mono text-[10px] tabular-nums text-zinc-600">{visible.length}</span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => {
              void studio.clearActivity()
              setEvents([])
            }}
            title="Clear"
            className="cursor-pointer rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            <RiDeleteBinLine size={12} />
          </button>
          <button
            onClick={onClose}
            title="Close"
            className="cursor-pointer rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            <RiCloseLine size={13} />
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.05] px-3 py-2">
        <select
          value={minLevel}
          onChange={(e) => setMinLevel(e.target.value as LogLevel)}
          className="cursor-pointer rounded-md border border-white/10 bg-black/40 px-1.5 py-1 text-[10px] text-zinc-300 outline-none"
        >
          <option value="debug">All detail</option>
          <option value="info">Info and up</option>
          <option value="warn">Warnings and up</option>
          <option value="error">Errors only</option>
        </select>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="cursor-pointer rounded-md border border-white/10 bg-black/40 px-1.5 py-1 text-[10px] text-zinc-300 outline-none"
        >
          <option value="all">Everything</option>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {visible.length === 0 ? (
          <p className="px-2 py-8 text-center text-[11px] leading-relaxed text-zinc-600">
            Nothing yet. Launch an agent and connect it to another — every policy decision, handoff
            and merge shows up here.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {visible.map((e) => {
              const style = LEVEL_STYLE[e.level]
              return (
                <div
                  key={e.seq}
                  className="group flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04]"
                >
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                  <div className="min-w-0 flex-1">
                    <p className={`text-[11px] leading-snug ${style.text}`}>{e.message}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] text-zinc-600">
                      <span>{time(e.ts)}</span>
                      <span className={SCOPE_TINT[e.scope] ?? 'text-zinc-500'}>{e.scope}</span>
                      {typeof e.durationMs === 'number' && (
                        <span className="text-zinc-500">{e.durationMs}ms</span>
                      )}
                      {e.traceId && (
                        <span
                          title={`Cascade ${e.traceId}`}
                          className="truncate text-zinc-700 opacity-0 transition-opacity group-hover:opacity-100"
                        >
                          {e.traceId.slice(-6)}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </motion.div>
  )
}
