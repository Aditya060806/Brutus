import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  RiAlertLine,
  RiArrowRightLine,
  RiCheckLine,
  RiCloseLine,
  RiLoader4Line,
  RiMicFill,
  RiMicLine,
  RiPlayFill,
  RiSendPlane2Fill,
  RiStopCircleLine,
  RiTimeLine,
  RiArchiveLine,
  RiAddLine
} from 'react-icons/ri'
import {
  studio,
  type MissionEdge,
  type MissionPlan,
  type MissionState,
  type MissionStepState,
  type StepStatus
} from '@renderer/services/studio-client'
import { useDictation } from './use-dictation'
import SourceChecklist from './SourceChecklist'
import RecordsPanel from './RecordsPanel'
import type { ChecklistItem } from '@renderer/services/studio-client'

/**
 * The Dashboard — one request, a crew that runs it.
 *
 * Three states in one surface, because they are one thought:
 *
 *   ask   — a prompt box (typed or spoken)
 *   plan  — the crew Brutus proposes, before anything is spawned
 *   run   — the live board, one row per agent
 *
 * ── WHY THE PLAN IS SHOWN BEFORE IT RUNS ───────────────────────────────────
 * Pressing Run launches several real CLI processes against a real repository.
 * The confirmation is not ceremony: it is the last point at which a
 * misunderstanding costs nothing. Everything Brutus dropped while validating
 * the plan is listed here too, so the crew on screen is exactly the crew that
 * will exist.
 */

const STATUS_STYLE: Record<StepStatus, { dot: string; text: string; label: string }> = {
  pending: { dot: 'bg-zinc-600', text: 'text-zinc-500', label: 'Waiting' },
  running: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'Working' },
  done: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'Done' },
  failed: { dot: 'bg-red-500', text: 'text-red-300', label: 'Failed' },
  blocked: { dot: 'bg-zinc-700', text: 'text-zinc-600', label: 'Blocked' }
}

const EXAMPLES = [
  'Find every TODO in the codebase and fix the ones that are one-liners',
  'Add dark mode to the settings page, then check nothing else broke',
  'Write tests for the auth module and run them'
]

/** How often the live board re-reads main. Cheap: it is a counter read. */
const POLL_MS = 1000

export interface MissionDashboardProps {
  /**
   * Lay the plan out on the canvas and launch it.
   *
   * Returns the node id created for each step, which is what lets main map a
   * terminal back to the step it belongs to. Owned by the canvas because only
   * it knows about positions, node data and the spawn lifecycle.
   */
  onRun: (
    plan: MissionPlan,
    edges: MissionEdge[]
  ) => Promise<{ ok: boolean; bindings?: { ref: string; nodeId: string }[]; error?: string }>
  /**
   * The canvas this Dashboard belongs to.
   *
   * Every mission call carries it, so a workspace only ever plans, watches and
   * stops its own crew. Another workspace can have one running at the same time
   * and neither board shows the other.
   */
  workspaceId: string
  onClose: () => void
}

export default function MissionDashboard({
  onRun,
  workspaceId,
  onClose
}: MissionDashboardProps): ReactElement {
  const [task, setTask] = useState('')
  const [plan, setPlan] = useState<MissionPlan | null>(null)
  const [edges, setEdges] = useState<MissionEdge[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [planning, setPlanning] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<MissionState | null>(null)
  /** Which half of the Dashboard is showing. */
  const [tab, setTab] = useState<'new' | 'records'>('new')
  /**
   * The source checklist for the plan on screen.
   *
   * Held here rather than inside `PlanPreview` because it outlives it: the
   * ticks a user makes before pressing Run are handed to `startMission`, which
   * writes them into the task record. State inside the preview would be thrown
   * away at exactly the moment it becomes worth keeping.
   */
  const [checklist, setChecklist] = useState<ChecklistItem[]>([])
  const reduceMotion = useReducedMotion()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const dictation = useDictation(
    useCallback((text: string) => {
      // Appended rather than replacing: speaking is often used to finish a
      // sentence someone already started typing.
      setTask((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
      inputRef.current?.focus()
    }, [])
  )

  // Adopt a mission already running — reopening the dashboard must show the
  // board, not an empty prompt over agents that are visibly working.
  useEffect(() => {
    let cancelled = false
    void studio.missionState(workspaceId).then((m) => {
      // A finished crew is still worth showing. Coming back to a board reading
      // 3/3 done is the answer to whether it worked; an empty prompt box is not.
      if (!cancelled && m) setLive(m)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  /**
   * Follow the live mission.
   *
   * Polled rather than pushed: the board is a handful of counters, the panel is
   * often closed, and a per-transition IPC event would arrive during the
   * busiest moment of a multi-agent run for no gain over a one-second read.
   */
  useEffect(() => {
    if (!live || live.status !== 'running') return
    const id = setInterval(() => {
      void studio.missionState(workspaceId).then((m) => m && setLive(m))
    }, POLL_MS)
    return () => clearInterval(id)
  }, [live, workspaceId])

  const makePlan = useCallback(async () => {
    const text = task.trim()
    if (!text || planning) return
    setPlanning(true)
    setError(null)
    setSkipped([])
    try {
      const res = await studio.planMission(text, workspaceId)
      if (!res.ok || !res.plan) {
        setError(res.error ?? 'That could not be planned.')
        setSkipped(res.skipped ?? [])
        return
      }
      setPlan(res.plan)
      setEdges(res.edges ?? [])
      setSkipped(res.skipped ?? [])
      setChecklist(res.checklist ?? [])
    } catch (err) {
      setError(String((err as { message?: string })?.message || err))
    } finally {
      setPlanning(false)
    }
  }, [task, planning, workspaceId])

  const run = useCallback(async () => {
    if (!plan || launching) return
    setLaunching(true)
    setError(null)
    try {
      const laid = await onRun(plan, edges)
      if (!laid.ok || !laid.bindings) {
        setError(laid.error ?? 'The crew could not be placed on the canvas.')
        return
      }
      const res = await studio.startMission(plan, laid.bindings, checklist)
      if (!res.ok || !res.mission) {
        setError(res.error ?? 'The mission could not be started.')
        return
      }
      setLive(res.mission)
      setPlan(null)
    } catch (err) {
      setError(String((err as { message?: string })?.message || err))
    } finally {
      setLaunching(false)
    }
  }, [plan, edges, onRun, launching, checklist])

  const stop = useCallback(async () => {
    const m = await studio.abortMission(workspaceId)
    setLive(m)
  }, [workspaceId])

  const reset = useCallback(() => {
    setLive(null)
    setPlan(null)
    setEdges([])
    setSkipped([])
    setChecklist([])
    setError(null)
    setTask('')
  }, [])

  const tickItem = useCallback((id: string, done: boolean) => {
    setChecklist((items) => items.map((i) => (i.id === id ? { ...i, done } : i)))
  }, [])

  const answerItem = useCallback((id: string, value: string) => {
    setChecklist((items) => items.map((i) => (i.id === id ? { ...i, value } : i)))
  }, [])

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: 12 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      className="studio-glass pointer-events-auto flex max-h-[min(660px,calc(100vh-7rem))] w-[min(720px,calc(100vw-2rem))] flex-col rounded-2xl"
    >
      {/* ── Header ── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-200">
          Dashboard
        </span>
        {/* Two halves of one job: starting work, and reviewing what came back.
            A segmented control rather than a second panel, because the records
            are about the same thing the New tab produces. */}
        <div className="flex items-center rounded-lg bg-white/[0.06] p-0.5">
          {(
            [
              // The anchor is spelled out rather than templated: `data-tour` is a
              // contract the tutorial greps for, and a value assembled at runtime
              // cannot be found by reading the source — which is exactly what the
              // anchor test checks, and it caught this.
              ['new', 'New', RiAddLine, 'dashboard.tab.new'],
              ['records', 'Records', RiArchiveLine, 'dashboard.tab.records']
            ] as const
          ).map(([id, label, Icon, anchor]) => (
            <button
              key={id}
              data-tour={anchor}
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${
                tab === id ? 'bg-white/15 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Icon size={11} />
              {label}
            </button>
          ))}
        </div>

        <span className="truncate text-[11px] text-zinc-600">
          {tab === 'records'
            ? 'Everything the agents have produced'
            : live
              ? 'A crew is on the job'
              : 'Describe the job — Brutus assembles the crew'}
        </span>
        <button
          onClick={onClose}
          title="Close"
          className="ml-auto cursor-pointer rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          <RiCloseLine size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'records' ? (
          <RecordsPanel workspaceId={workspaceId} />
        ) : live ? (
          <LiveBoard mission={live} onStop={() => void stop()} onNew={reset} />
        ) : (
          <div className="flex flex-col gap-3 p-4">
            {/* ── The prompt ── */}
            <div className="rounded-xl border border-white/10 bg-black/30 p-2.5 transition-shadow focus-within:border-red-500/30">
              <textarea
                ref={inputRef}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void makePlan()
                  }
                }}
                rows={3}
                autoFocus
                disabled={planning}
                placeholder="What do you want done? Brutus splits it across agents and runs it."
                className="w-full resize-none bg-transparent text-[12.5px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 disabled:opacity-50"
              />
              <div className="mt-1 flex items-center gap-2">
                {dictation.supported && (
                  <button
                    data-tour="dashboard.mic"
                    onClick={dictation.toggle}
                    disabled={dictation.transcribing || planning}
                    title={dictation.recording ? 'Stop and transcribe' : 'Speak instead of typing'}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      dictation.recording
                        ? 'bg-red-500/20 text-red-300'
                        : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-200'
                    }`}
                  >
                    {dictation.transcribing ? (
                      <RiLoader4Line size={12} className="animate-spin" />
                    ) : dictation.recording ? (
                      <RiMicFill size={12} className="animate-pulse" />
                    ) : (
                      <RiMicLine size={12} />
                    )}
                    {dictation.transcribing
                      ? 'Transcribing…'
                      : dictation.recording
                        ? 'Listening — click to stop'
                        : 'Speak'}
                  </button>
                )}

                <button
                  onClick={() => void makePlan()}
                  disabled={!task.trim() || planning}
                  className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg bg-red-500/15 px-2.5 py-1.5 text-[10px] font-semibold text-red-400 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {planning ? (
                    <RiLoader4Line size={12} className="animate-spin" />
                  ) : (
                    <RiSendPlane2Fill size={12} />
                  )}
                  {planning ? 'Planning…' : 'Plan the crew'}
                </button>
              </div>
            </div>

            {dictation.error && (
              <p className="px-1 text-[10.5px] text-amber-400/90">{dictation.error}</p>
            )}
            {error && (
              <p className="flex items-start gap-1.5 px-1 text-[10.5px] text-red-400">
                <RiAlertLine size={12} className="mt-0.5 shrink-0" />
                {error}
              </p>
            )}

            {/* ── The proposed crew ── */}
            {plan ? (
              <PlanPreview
                plan={plan}
                skipped={skipped}
                launching={launching}
                checklist={checklist}
                onTick={tickItem}
                onAnswer={answerItem}
                onRun={() => void run()}
                onDiscard={() => setPlan(null)}
              />
            ) : (
              !planning && (
                <div className="flex flex-col gap-1.5">
                  <p className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
                    For example
                  </p>
                  {EXAMPLES.map((e) => (
                    <button
                      key={e}
                      onClick={() => setTask(e)}
                      className="cursor-pointer rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left text-[11.5px] text-zinc-400 transition-colors hover:border-white/10 hover:bg-white/[0.05] hover:text-zinc-200"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        )}
      </div>
    </motion.div>
  )
}

/** The crew Brutus proposes, and what it dropped getting there. */
function PlanPreview({
  plan,
  skipped,
  launching,
  checklist,
  onTick,
  onAnswer,
  onRun,
  onDiscard
}: {
  plan: MissionPlan
  skipped: string[]
  launching: boolean
  checklist: ChecklistItem[]
  onTick: (id: string, done: boolean) => void
  onAnswer: (id: string, value: string) => void
  onRun: () => void
  onDiscard: () => void
}): ReactElement {
  const outstanding = checklist.filter((i) => i.required && !i.done).length
  const count = plan.steps.length

  return (
    <div
      data-tour="dashboard.plan"
      className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3"
    >
      <p className="text-[12px] font-medium leading-snug text-zinc-200">{plan.summary}</p>

      {/* Why this many agents.
          The user never asks for a crew size, so the one thing they cannot infer
          from the list below is why it is this long. Saying it plainly is what
          stops "it opened five terminals" reading as arbitrary. */}
      <p className="flex items-center gap-1.5 text-[10px] text-zinc-500">
        <span
          className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-[0.1em] ${
            plan.complexity === 'complex'
              ? 'bg-red-500/12 text-red-400'
              : plan.complexity === 'standard'
                ? 'bg-amber-400/12 text-amber-400'
                : 'bg-emerald-500/12 text-emerald-400'
          }`}
        >
          {plan.complexity}
        </span>
        judged {plan.complexity} — {count} agent{count === 1 ? '' : 's'} for this one
      </p>

      <div className="flex flex-col gap-1.5">
        {plan.steps.map((s, i) => (
          <div
            key={s.ref}
            className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-2"
          >
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[9px] text-zinc-500 ring-1 ring-white/10">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] font-semibold text-zinc-200">
                {s.title}
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] font-normal text-zinc-400">
                  {s.agentKind}
                </span>
                <span className="text-[10px] font-normal text-zinc-500">{s.role}</span>
                {s.dependsOn && (
                  <span className="flex items-center gap-0.5 text-[9.5px] font-normal text-zinc-600">
                    <RiArrowRightLine size={9} />
                    after {plan.steps.find((p) => p.ref === s.dependsOn)?.title ?? s.dependsOn}
                  </span>
                )}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-relaxed text-zinc-500">
                {s.brief}
              </p>
            </div>
          </div>
        ))}
      </div>

      {skipped.length > 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-2.5 py-2">
          <p className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-amber-400/90">
            Adjusted
          </p>
          <ul className="mt-1 space-y-0.5">
            {skipped.map((s) => (
              <li key={s} className="text-[10.5px] leading-relaxed text-amber-200/70">
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── What this task still needs ──
          Directly above Run, because that is the moment it matters: once
          several CLIs are editing files, "you never said which database" is
          expensive to undo. */}
      <SourceChecklist items={checklist} onToggle={onTick} onValue={onAnswer} />

      <div className="flex items-center gap-2">
        <button
          onClick={onRun}
          disabled={launching}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-red-500/20 px-3 py-1.5 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {launching ? (
            <RiLoader4Line size={12} className="animate-spin" />
          ) : (
            <RiPlayFill size={13} />
          )}
          {launching
            ? 'Starting the crew…'
            : `Run ${plan.steps.length} agent${plan.steps.length === 1 ? '' : 's'}`}
        </button>
        <button
          onClick={onDiscard}
          disabled={launching}
          className="cursor-pointer rounded-lg px-2.5 py-1.5 text-[11px] text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300 disabled:opacity-40"
        >
          Rewrite
        </button>

        {/* Warns; never blocks. The checklist is derived from what the request
            appears to touch, so it is sometimes wrong — and a checklist that can
            refuse to let you work is one people learn to defeat. */}
        {outstanding > 0 ? (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-amber-400/90">
            <RiAlertLine size={10} />
            {outstanding} input{outstanding === 1 ? '' : 's'} still missing
          </span>
        ) : (
          <span className="ml-auto text-[10px] text-zinc-600">
            Each agent opens a real terminal
          </span>
        )}
      </div>
    </div>
  )
}

/** One row per agent, updated while the crew works. */
function LiveBoard({
  mission,
  onStop,
  onNew
}: {
  mission: MissionState
  onStop: () => void
  onNew: () => void
}): ReactElement {
  const running = mission.status === 'running'
  const pct = Math.round((mission.totals.done / Math.max(1, mission.totals.total)) * 100)

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <p className="text-[12px] font-medium leading-snug text-zinc-200">{mission.summary}</p>
        <p className="mt-0.5 text-[10.5px] text-zinc-600">{mission.task}</p>
      </div>

      {/* ── Progress ── */}
      <div>
        <div className="flex items-center gap-2 text-[10px]">
          <span
            className={`font-semibold uppercase tracking-[0.12em] ${
              mission.status === 'done'
                ? 'text-emerald-400'
                : mission.status === 'failed'
                  ? 'text-red-400'
                  : mission.status === 'aborted'
                    ? 'text-zinc-500'
                    : 'text-amber-400'
            }`}
          >
            {mission.status}
          </span>
          <span className="font-mono tabular-nums text-zinc-500">
            {mission.totals.done}/{mission.totals.total} done
          </span>
          {mission.totals.failed > 0 && (
            <span className="font-mono tabular-nums text-red-400">
              {mission.totals.failed} failed
            </span>
          )}
          {mission.stalled && (
            <span className="flex items-center gap-1 text-amber-400">
              <RiTimeLine size={10} /> nothing has moved in a while
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {running ? (
              <button
                onClick={onStop}
                className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-red-400 transition-colors hover:bg-red-500/10"
              >
                <RiStopCircleLine size={12} /> Stop
              </button>
            ) : (
              <button
                onClick={onNew}
                className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
              >
                New mission
              </button>
            )}
          </div>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-red-500/70 transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {mission.steps.map((s) => (
          <StepRow key={s.ref} step={s} steps={mission.steps} />
        ))}
      </div>

      <p className="text-[10px] leading-relaxed text-zinc-600">
        Every dispatch, handoff and failure is recorded in Activity — open it from the bottom right
        to read the run in full.
      </p>
    </div>
  )
}

function StepRow({
  step,
  steps
}: {
  step: MissionStepState
  steps: MissionStepState[]
}): ReactElement {
  const style = STATUS_STYLE[step.status]
  const ms = step.startedAt && step.finishedAt ? step.finishedAt - step.startedAt : null

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-2">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] font-semibold text-zinc-200">
          {step.title}
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] font-normal text-zinc-400">
            {step.agentKind}
          </span>
          <span className="text-[10px] font-normal text-zinc-500">{step.role}</span>
          <span className={`ml-auto text-[9.5px] font-normal ${style.text}`}>
            {step.status === 'done' && <RiCheckLine size={10} className="mr-0.5 inline" />}
            {style.label}
            {ms !== null && (
              <span className="ml-1 font-mono text-zinc-600">{Math.round(ms / 1000)}s</span>
            )}
          </span>
        </p>

        {step.dependsOn && step.status === 'pending' && (
          <p className="mt-0.5 text-[10px] text-zinc-600">
            waits for {steps.find((p) => p.ref === step.dependsOn)?.title ?? step.dependsOn}
          </p>
        )}
        {step.note && (
          <p className="mt-0.5 text-[10px] leading-relaxed text-red-400/80">{step.note}</p>
        )}
        {step.output && (
          <p className="mt-1 line-clamp-3 rounded bg-white/[0.03] px-2 py-1 font-mono text-[9.5px] leading-relaxed text-zinc-500">
            {step.output}
          </p>
        )}
      </div>
    </div>
  )
}
