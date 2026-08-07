import { useState, useEffect, useSyncExternalStore, useRef, memo, type ReactElement } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import {
  RiTeamLine,
  RiPlayLine,
  RiStopCircleLine,
  RiCheckLine,
  RiCloseLine,
  RiLoader4Line,
  RiShieldCheckLine,
  RiKey2Line,
  RiTerminalBoxLine,
  RiArrowRightLine,
  RiSparkling2Line
} from 'react-icons/ri'
import Markdown from '@renderer/components/Markdown'
import {
  orchestrator,
  type TaskState,
  type TaskStatus
} from '@renderer/services/orchestrator-client'

/* Same visual system as the Dashboard: one red accent, documented radius scale
   (surface 2xl / nested xl / control lg / pill full), 4-step type scale. */
const SURFACE = 'bg-zinc-950/50 backdrop-blur-xl border border-white/[0.06] rounded-2xl'
const LABEL = 'text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-400'

const STATUS_STYLE: Record<TaskStatus, { dot: string; text: string; label: string }> = {
  pending: { dot: 'bg-zinc-700', text: 'text-zinc-500', label: 'Queued' },
  ready: { dot: 'bg-zinc-500', text: 'text-zinc-400', label: 'Ready' },
  running: { dot: 'bg-red-500', text: 'text-red-400', label: 'Working' },
  'awaiting-approval': { dot: 'bg-amber-400', text: 'text-amber-400', label: 'Needs you' },
  validating: { dot: 'bg-red-400', text: 'text-red-300', label: 'Checking' },
  done: { dot: 'bg-emerald-500', text: 'text-emerald-400', label: 'Done' },
  failed: { dot: 'bg-red-600', text: 'text-red-400', label: 'Failed' },
  skipped: { dot: 'bg-zinc-700', text: 'text-zinc-600', label: 'Skipped' }
}

function elapsed(t: TaskState, now: number): string {
  if (!t.startedAt) return ''
  const end = t.finishedAt ?? now
  const s = (end - t.startedAt) / 1000
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

/**
 * One shared clock for every running timer on the page.
 *
 * Elapsed times used to read `Date.now()` during render with nothing to trigger
 * a re-render, so a running task appeared frozen at its start time. A single
 * interval that only ticks while work is in flight fixes that without giving
 * each card its own timer.
 */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/**
 * One task in the graph.
 *
 * Memoised because the shared clock re-renders the page every second while a
 * run is live; without it every card and its Markdown subtree would re-render
 * on each tick.
 */
const TaskCard = memo(function TaskCard({
  task,
  index,
  reduce,
  now
}: {
  task: TaskState
  index: number
  reduce: boolean
  now: number
}): ReactElement {
  const [open, setOpen] = useState(false)
  const style = STATUS_STYLE[task.status] ?? STATUS_STYLE.pending
  const active = task.status === 'running' || task.status === 'validating'

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.04, ease: [0.16, 1, 0.3, 1] }}
      className={`rounded-xl border p-3 transition-colors ${
        active ? 'border-red-500/30 bg-red-500/[0.04]' : 'border-white/[0.06] bg-black/20'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <span
            className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${style.dot} ${
              active && !reduce ? 'animate-pulse' : ''
            }`}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-zinc-200 capitalize">
                {task.agent}
              </span>
              <span className="text-[9px] font-mono text-zinc-600">{task.id}</span>
              {task.dependsOn.length > 0 && (
                <span className="text-[9px] font-mono text-zinc-600 flex items-center gap-0.5">
                  <RiArrowRightLine size={9} /> {task.dependsOn.join(', ')}
                </span>
              )}
            </div>
            <p className="text-[11px] text-zinc-400 leading-snug mt-0.5 line-clamp-2">
              {task.goal.split('\n')[0]}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end shrink-0">
          <span className={`text-[9px] font-semibold tracking-wider ${style.text}`}>
            {style.label}
          </span>
          {task.startedAt && (
            <span className="text-[9px] font-mono text-zinc-600 tabular-nums">
              {elapsed(task, now)}
            </span>
          )}
        </div>
      </div>

      {(task.calls.length > 0 || task.model) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2 pl-4">
          {task.model && (
            <span className="text-[9px] font-mono text-zinc-600 px-1.5 py-0.5 rounded bg-white/[0.03]">
              {task.model}
            </span>
          )}
          {task.calls.map((c, i) => (
            <span
              key={i}
              title={c.summary}
              className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                c.ok ? 'bg-white/[0.04] text-zinc-500' : 'bg-red-500/10 text-red-400'
              }`}
            >
              {c.capability}
            </span>
          ))}
        </div>
      )}

      {task.error && (
        <p className="text-[10px] text-red-400/90 mt-2 pl-4 leading-snug">{task.error}</p>
      )}

      {task.output && (
        <div className="mt-2 pl-4">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors"
          >
            {open ? 'Hide output' : 'Show output'}
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                initial={reduce ? false : { height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={reduce ? undefined : { height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="mt-2 max-h-60 overflow-y-auto scrollbar-small pr-1">
                  <Markdown density="compact">{task.output}</Markdown>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  )
})

const OrchestratorView = (): ReactElement => {
  const snap = useSyncExternalStore(orchestrator.subscribe, orchestrator.getSnapshot)
  const reduce = useReducedMotion() ?? false
  const [request, setRequest] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void orchestrator.refresh()
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [snap.logs.length])

  const run = snap.run
  const busy = orchestrator.isRunning
  const approval = snap.approval
  const now = useClock(busy)

  const start = async (): Promise<void> => {
    const text = request.trim()
    if (!text || busy) return
    setRequest('')
    await orchestrator.run(text)
  }

  const done = run?.tasks.filter((t) => t.status === 'done').length ?? 0
  const total = run?.tasks.length ?? 0

  return (
    <div className="h-full w-full overflow-y-auto p-6 scrollbar-small">
      <div className="max-w-[1200px] mx-auto flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <RiTeamLine className="text-red-500 text-2xl" />
            <div className="flex flex-col leading-none">
              <span className="font-black tracking-[0.18em] text-sm text-zinc-100">
                ORCHESTRATOR
              </span>
              <span className="text-[10px] font-mono text-red-500/60 tracking-widest mt-0.5">
                {snap.agents.length} SPECIALISTS · PARALLEL EXECUTION
              </span>
            </div>
          </div>
          {snap.keyPool && (
            <div className="flex items-center gap-2 text-[10px] font-mono">
              <RiKey2Line className="text-zinc-500" />
              <span className="text-zinc-400">
                {snap.keyPool.healthy}/{snap.keyPool.total} keys
              </span>
              {snap.keyPool.cooling > 0 && (
                <span className="text-amber-400">{snap.keyPool.cooling} cooling</span>
              )}
              {snap.keyPool.dead > 0 && (
                <span className="text-red-400">{snap.keyPool.dead} invalid</span>
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className={`${SURFACE} p-4`}>
          <div className="flex items-end gap-2">
            <textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void start()
                }
              }}
              disabled={busy}
              rows={2}
              placeholder="Give the team a complex, multi-step task…"
              className="flex-1 bg-black/40 border border-white/[0.06] rounded-lg text-[12px] text-zinc-200 placeholder-zinc-600 px-3 py-2.5 outline-none resize-none transition-colors focus:border-red-500/40 disabled:opacity-40"
            />
            {busy ? (
              <button
                onClick={() => void orchestrator.cancel()}
                className="px-4 py-2.5 rounded-lg bg-red-500/15 text-red-400 text-[11px] font-semibold hover:bg-red-500/25 transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <RiStopCircleLine size={14} /> Stop
              </button>
            ) : (
              <button
                onClick={() => void start()}
                disabled={!request.trim()}
                className="px-4 py-2.5 rounded-lg bg-red-500/15 text-red-400 text-[11px] font-semibold hover:bg-red-500/25 transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <RiPlayLine size={14} /> Run
              </button>
            )}
          </div>
          <p className="text-[10px] text-zinc-600 mt-2">
            Also available anywhere in chat as{' '}
            <code className="text-zinc-500">/agent your request</code>
          </p>
        </div>

        {/* Approval gate */}
        <AnimatePresence>
          {approval && (
            <motion.div
              initial={reduce ? false : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -8 }}
              className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-4"
            >
              <div className="flex items-start gap-3">
                <RiShieldCheckLine className="text-amber-400 text-lg shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className={`${LABEL} text-amber-400/90`}>Approval needed</div>
                  <p className="text-[12px] text-zinc-200 mt-1 leading-snug">{approval.summary}</p>
                  <p className="text-[10px] text-zinc-500 mt-1 font-mono">
                    {approval.agent} · {approval.capability} · {approval.tags.join(', ')}
                  </p>
                  <pre className="mt-2 text-[10px] text-zinc-500 bg-black/30 rounded-lg p-2 max-h-32 overflow-auto scrollbar-small whitespace-pre-wrap">
                    {JSON.stringify(approval.args, null, 2)}
                  </pre>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <button
                    onClick={() => void orchestrator.approve(approval.id, true)}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 text-[10px] font-bold tracking-wider hover:bg-emerald-500/25 transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <RiCheckLine size={12} /> ALLOW
                  </button>
                  <button
                    onClick={() => void orchestrator.approve(approval.id, false)}
                    className="px-3 py-1.5 rounded-lg bg-white/5 text-zinc-400 text-[10px] font-bold tracking-wider hover:bg-white/10 transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <RiCloseLine size={12} /> DENY
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Run */}
        {run ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
            <div className={`${SURFACE} p-4 lg:col-span-2 flex flex-col gap-3`}>
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div className={LABEL}>Objective</div>
                  <p className="text-[12px] text-zinc-200 mt-1 leading-snug">
                    {run.objective || run.request}
                  </p>
                </div>
                <span className="text-[10px] font-mono text-zinc-500 shrink-0 ml-3">
                  {done}/{total}
                </span>
              </div>

              {/* Spring rather than a linear tween: progress arriving with a
                  little momentum reads as work completing, not a bar filling. */}
              <div className="h-[3px] w-full rounded-full bg-white/[0.06] overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-linear-to-r from-red-600 to-red-400 origin-left"
                  initial={false}
                  animate={{ scaleX: total ? done / total : 0 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 180, damping: 26, mass: 0.6 }
                  }
                  style={{ width: '100%' }}
                />
              </div>

              <div className="flex flex-col gap-2">
                {run.tasks.map((t, i) => (
                  <TaskCard key={t.id} task={t} index={i} reduce={reduce} now={now} />
                ))}
                {!run.tasks.length && (
                  <div className="flex items-center gap-2 text-[11px] text-zinc-500 py-6 justify-center">
                    <RiLoader4Line className={reduce ? '' : 'animate-spin'} /> Planning…
                  </div>
                )}
              </div>

              <AnimatePresence>
                {run.answer && (
                  <motion.div
                    initial={reduce ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ type: 'spring', stiffness: 220, damping: 26 }}
                    className="mt-1 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] p-4"
                  >
                    <div className="flex items-center gap-2 mb-2.5">
                      <RiSparkling2Line className="text-emerald-400" size={13} />
                      <span className={`${LABEL} text-emerald-400/90`}>Answer</span>
                      <div className="flex-1 h-px bg-linear-to-r from-emerald-500/20 to-transparent" />
                    </div>
                    {/* Rendered, not printed: agent output is Markdown, and
                        showing it raw is what produced literal ** and ##. */}
                    <Markdown>{run.answer}</Markdown>
                  </motion.div>
                )}
              </AnimatePresence>
              {run.error && <p className="text-[11px] text-red-400 leading-snug">{run.error}</p>}
            </div>

            {/* Log */}
            <div className={`${SURFACE} p-4 flex flex-col gap-2 max-h-[70vh]`}>
              <div className="flex items-center gap-2">
                <RiTerminalBoxLine className="text-zinc-500" size={13} />
                <span className={LABEL}>Activity</span>
              </div>
              <div
                ref={logRef}
                className="flex-1 overflow-y-auto scrollbar-small font-mono text-[10px] text-zinc-500 leading-relaxed space-y-0.5 min-h-0"
              >
                {snap.logs.length ? (
                  snap.logs.map((l, i) => (
                    <div key={i} className="break-words">
                      {l}
                    </div>
                  ))
                ) : (
                  <span className="text-zinc-700">No activity yet.</span>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* Empty state — the roster doubles as documentation */
          <div className={`${SURFACE} p-5`}>
            <div className={LABEL}>The team</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mt-3">
              {snap.agents.map((a) => (
                <div key={a.name} className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
                  <div className="text-[11px] font-semibold text-zinc-200 capitalize">
                    {a.title}
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-snug mt-0.5">{a.charter}</p>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {a.capabilities.slice(0, 4).map((c) => (
                      <span
                        key={c}
                        className="text-[9px] font-mono text-zinc-600 px-1.5 py-0.5 rounded bg-white/[0.03]"
                      >
                        {c}
                      </span>
                    ))}
                    {a.capabilities.length > 4 && (
                      <span className="text-[9px] font-mono text-zinc-700">
                        +{a.capabilities.length - 4}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {!snap.agents.length && (
                <p className="text-[11px] text-zinc-600">
                  Add a Groq API key in Settings to enable the agent team.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default OrchestratorView
