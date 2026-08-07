/**
 * BRUTUS Studio — the Dashboard mission
 * --------------------------------------
 * One sentence in, a working crew out.
 *
 *   "add dark mode to the settings page and make sure nothing else broke"
 *     → Apollo (claude)  builds it
 *     → Atlas  (codex)   reviews the diff
 *     → Orion  (gemini)  runs the tests and reports
 *
 * The command bar already turns English into canvas edits. This is the other
 * half: English into a *task graph* that actually runs, with every step tracked
 * from dispatch to done and every transition recorded in Activity.
 *
 * ── TWO HALVES, DELIBERATELY SEPARATE ──────────────────────────────────────
 * `validateMission` is pure and synchronous — it is the only thing standing
 * between a hallucinated plan and several real CLI processes being launched
 * against the user's repository, so it is tested exhaustively without a model.
 * `MissionTracker` is the live state machine, with the terminal and the model
 * both behind injected callbacks so it can be driven deterministically in tests.
 *
 * ── WHY A STEP MAY DEPEND ON AT MOST ONE OTHER ─────────────────────────────
 * The router fires per edge: when an agent finishes, every outgoing string
 * delivers independently. A join (two steps feeding one) would therefore prompt
 * the joining agent twice — once per upstream — and it would start work on the
 * first arrival with only half its inputs. Rather than pretend to support that
 * and produce a subtly wrong run, the validator keeps the first dependency and
 * says plainly in `skipped` that the others were dropped. Chains and fan-out
 * (one step feeding several) are exactly what the router does well, and that is
 * what a plan is allowed to express.
 *
 * ── WHY DEPENDENCIES MAY ONLY POINT BACKWARDS ──────────────────────────────
 * A dependency must name a step defined *earlier* in the array. That single
 * rule makes a cycle unrepresentable — no graph walk, no visited set, no way
 * for a malformed plan to hang the tracker waiting on itself.
 *
 * ── WHO DISPATCHES WHAT ────────────────────────────────────────────────────
 * The tracker dispatches ROOT steps only. Everything downstream is delivered by
 * the router along the canvas edges, reframed with project context, subject to
 * the cascade ceilings that already exist. If the tracker also prompted
 * downstream steps they would each receive two instructions for one handoff.
 */
import type { AgentKind } from './types'
import { sanitizeForTerminal } from './router'

// ─── Ceilings ───────────────────────────────────────────────────────────────

/**
 * Agents one mission may launch.
 *
 * Not a UI limit: each step is a real CLI process holding a pty, a model
 * subscription and possibly a git worktree. Six is already a lot of machine.
 */
export const MAX_STEPS = 6
export const MAX_BRIEF_CHARS = 1500
export const MAX_TITLE_CHARS = 40
export const MAX_ROLE_CHARS = 40
export const MAX_SUMMARY_CHARS = 300
/** Preview of an agent's output kept per step, for the dashboard. */
export const MAX_OUTPUT_PREVIEW = 400
/** No transition for this long while running, and the mission reads as stalled. */
export const STALL_AFTER_MS = 5 * 60_000

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked'
export type MissionStatus = 'planned' | 'running' | 'done' | 'failed' | 'aborted'

export interface MissionStep {
  /** Handle used within the plan; the canvas maps it to a real node id. */
  ref: string
  agentKind: AgentKind
  /** Display name on the canvas — Apollo, Atlas, Orion. */
  title: string
  /** What this agent is for, in two or three words. Shown on the board. */
  role: string
  /** The instruction typed into this agent. */
  brief: string
  /** Ref of the step that must finish first, or null for a root step. */
  dependsOn: string | null
}

export interface MissionPlan {
  id: string
  /** What the human asked, verbatim. Never model-rewritten. */
  task: string
  /** The planner's own restatement, shown so a wrong reading is visible early. */
  summary: string
  steps: MissionStep[]
}

export interface MissionStepState extends MissionStep {
  status: StepStatus
  /** Canvas node running this step. Absent until the renderer binds it. */
  nodeId?: string
  startedAt?: number
  finishedAt?: number
  /** Tail of what the agent produced, for the board. */
  output?: string
  /** Why it failed, or which failure blocked it. */
  note?: string
}

export interface MissionState {
  id: string
  task: string
  summary: string
  status: MissionStatus
  startedAt: number
  finishedAt?: number
  /** Last time any step changed. Drives the stall readout. */
  lastProgressAt: number
  /** Running, but nothing has moved for a long time. */
  stalled: boolean
  steps: MissionStepState[]
  /** Counts the dashboard shows without recomputing them. */
  totals: { total: number; done: number; running: number; failed: number; blocked: number }
}

// ─── Planning prompt ────────────────────────────────────────────────────────

export const MISSION_SYSTEM = [
  'You break one request into a small crew of coding agents that will run in real',
  'terminals on the user’s machine. Reply with JSON only — no prose, no fences.',
  '',
  'Shape:',
  '{"summary":"one line restating the goal",',
  ' "steps":[{"ref":"a","agentKind":"claude","title":"Apollo","role":"Build",',
  '           "brief":"...","dependsOn":null}]}',
  '',
  'Rules:',
  '- Use only agentKind values listed as AVAILABLE. Never invent one.',
  '- Between 1 and 6 steps. Prefer the fewest that genuinely do the job; two',
  '  agents doing the same work is worse than one.',
  '- "dependsOn" is null, or the "ref" of a step listed EARLIER in the array.',
  '  A step may depend on at most one other. Several steps may depend on the',
  '  same one (fan-out) — that is how parallel work is expressed.',
  '- "brief" is what gets typed into that agent. Write it as a direct instruction',
  '  to that agent, self-contained, with the concrete specifics from the request.',
  '  Do not write "as above" or refer to other steps by ref — an agent only ever',
  '  sees its own brief plus whatever the previous agent handed it.',
  '- The LAST step must verify the work rather than add to it: run the tests,',
  '  re-read the changed files, and report what is actually true.',
  '- "title" is a short codename (Apollo, Atlas, Orion, Vega, Lyra, Rigel).',
  '- "role" is two or three words: Build, Review, Test and report.',
  '- If the request is not something coding agents can do, reply {"steps":[]}.'
].join('\n')

export function missionPrompt(
  task: string,
  availableKinds: AgentKind[],
  context: { projectName?: string; rootDir?: string } = {}
): string {
  const where = context.projectName
    ? `PROJECT: ${context.projectName}${context.rootDir ? ` (${context.rootDir})` : ''}`
    : 'PROJECT: (no folder chosen — agents open in the workspace default)'

  return [
    `AVAILABLE agentKind values: ${availableKinds.join(', ') || 'none'}`,
    where,
    '',
    'STRENGTHS:',
    '- claude: large refactors, reading unfamiliar code, careful multi-file edits',
    '- codex: focused code generation and review of a diff',
    '- gemini: analysis, test running, summarising what changed',
    '- shell: a plain terminal — only when the job really is just commands',
    '',
    `REQUEST: ${task}`
  ].join('\n')
}

// ─── Validation ─────────────────────────────────────────────────────────────

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : ''

export interface ValidateMissionOpts {
  availableKinds: AgentKind[]
  /** The human's request, kept verbatim rather than taken from the model. */
  task: string
  /** Injected so a test gets a stable id. */
  id?: string
}

export interface MissionValidation {
  plan: MissionPlan | null
  skipped: string[]
}

/**
 * Turn a model's proposal into a plan that is safe to run, or into nothing.
 *
 * Everything is treated as untrusted. A step that names an agent the user has
 * not installed would spawn a window that can never start; a step with no brief
 * would type an empty line into a CLI; a forward reference would leave the
 * tracker waiting on a step that had already been dropped. All are removed
 * here, each with a sentence saying so, rather than surfacing later as a canvas
 * that half works.
 */
export function validateMission(raw: unknown, opts: ValidateMissionOpts): MissionValidation {
  const skipped: string[] = []

  const rawSteps = Array.isArray((raw as { steps?: unknown })?.steps)
    ? ((raw as { steps: unknown[] }).steps as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : []

  if (!rawSteps.length) return { plan: null, skipped }

  const steps: MissionStep[] = []
  /** Refs accepted so far. A dependency may only name one of these. */
  const accepted = new Set<string>()

  for (const entry of rawSteps) {
    if (steps.length >= MAX_STEPS) {
      skipped.push(`Stopped at ${MAX_STEPS} agents — the rest of the plan was dropped.`)
      break
    }

    const e = entry as {
      ref?: unknown
      agentKind?: unknown
      title?: unknown
      role?: unknown
      brief?: unknown
      dependsOn?: unknown
    }

    const agentKind = str(e.agentKind, 20) as AgentKind
    if (!opts.availableKinds.includes(agentKind)) {
      skipped.push(`"${agentKind || 'unknown'}" is not an installed agent — that step was dropped.`)
      continue
    }

    // The brief IS the step. Without it there is nothing to type in, and a bare
    // Enter into a freshly booted CLI is worse than no step at all.
    const brief = str(e.brief, MAX_BRIEF_CHARS)
    if (!brief) {
      skipped.push(`A ${agentKind} step arrived with no instruction — dropped.`)
      continue
    }

    let ref = str(e.ref, 60) || `s${steps.length + 1}`
    if (accepted.has(ref)) {
      skipped.push(`Two steps both called themselves "${ref}" — the second was renamed.`)
      ref = `${ref}_${steps.length + 1}`
    }

    /**
     * Resolve the dependency, or make this a root.
     *
     * Only a ref already accepted counts. A forward reference, a self
     * reference and an unknown name are all the same failure from here: the
     * step would wait forever, so it starts immediately instead and the plan
     * says why.
     */
    let dependsOn: string | null = null
    const rawDep = Array.isArray(e.dependsOn) ? e.dependsOn[0] : e.dependsOn
    const dep = str(rawDep, 60)
    if (Array.isArray(e.dependsOn) && e.dependsOn.length > 1) {
      skipped.push(
        `"${ref}" wanted to wait for several steps at once; it now waits for the first only.`
      )
    }
    if (dep && dep !== ref && accepted.has(dep)) {
      dependsOn = dep
    } else if (dep) {
      skipped.push(`"${ref}" depended on "${dep}", which is not an earlier step — it starts first.`)
    }

    accepted.add(ref)
    steps.push({
      ref,
      agentKind,
      title: str(e.title, MAX_TITLE_CHARS) || `Agent ${steps.length + 1}`,
      role: str(e.role, MAX_ROLE_CHARS) || 'Work',
      brief,
      dependsOn
    })
  }

  if (!steps.length) return { plan: null, skipped }

  return {
    plan: {
      id: opts.id ?? `msn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      task: opts.task,
      summary: str((raw as { summary?: unknown })?.summary, MAX_SUMMARY_CHARS) || opts.task,
      steps
    },
    skipped
  }
}

/**
 * The canvas edges a plan implies.
 *
 * Derived rather than asked for. A planner that returns both nodes and edges
 * can contradict itself; a dependency list cannot.
 */
export function missionEdges(plan: MissionPlan): { from: string; to: string; label: string }[] {
  return plan.steps
    .filter((s) => s.dependsOn)
    .map((s) => ({ from: s.dependsOn as string, to: s.ref, label: s.role }))
}

// ─── The live mission ───────────────────────────────────────────────────────

export interface TrackerDeps {
  /** The live session behind a canvas node, or null if it has not started. */
  sessionForNode(nodeId: string): string | null
  /** Queue text into a session. Lands the moment the agent reports idle. */
  deliver(sessionId: string, text: string): void
  /** One structured record per transition; ends up in the Activity panel. */
  record(
    level: 'info' | 'warn' | 'error',
    event: string,
    message: string,
    fields?: Record<string, unknown>
  ): void
  now?: () => number
}

/**
 * One mission, from dispatch to done.
 *
 * Fed by the same three signals `registerStudio` already has — a node's status
 * changing, a turn completing, a session exiting — so it observes what really
 * happened rather than assuming the plan was followed.
 */
export class MissionTracker {
  private state: MissionState
  private byNode = new Map<string, string>()
  /** Refs whose brief has been typed. Guards against a second dispatch. */
  private dispatched = new Set<string>()
  private now: () => number

  constructor(
    plan: MissionPlan,
    bindings: { ref: string; nodeId: string }[],
    private deps: TrackerDeps
  ) {
    this.now = deps.now ?? Date.now
    const at = this.now()
    const nodeByRef = new Map(bindings.map((b) => [b.ref, b.nodeId]))

    this.state = {
      id: plan.id,
      task: plan.task,
      summary: plan.summary,
      status: 'running',
      startedAt: at,
      lastProgressAt: at,
      stalled: false,
      steps: plan.steps.map((s) => ({
        ...s,
        status: 'pending',
        nodeId: nodeByRef.get(s.ref)
      })),
      totals: { total: plan.steps.length, done: 0, running: 0, failed: 0, blocked: 0 }
    }

    for (const [ref, nodeId] of nodeByRef) this.byNode.set(nodeId, ref)

    this.deps.record('info', 'mission.start', `Mission started: ${plan.summary}`, {
      missionId: plan.id,
      steps: plan.steps.length,
      agents: plan.steps.map((s) => `${s.title} (${s.agentKind})`).join(', ')
    })

    /**
     * Send the root briefs now, and again on every `idle` until they land.
     *
     * Both paths exist because a step can be un-dispatchable for two different
     * reasons, and only one of them resolves itself:
     *
     *   The CLI is still booting. Normal, and already handled — `deliver` is
     *   `PtyManager.enqueue`, which holds the write until the agent reports
     *   idle rather than typing into a half-started terminal.
     *
     *   There is no session at all, because the spawn is still in flight or
     *   failed. Nothing to enqueue against, so the attempt is simply dropped
     *   and retried when that node next reports idle — the CLI itself saying it
     *   is ready. No sleep, no retry timer, and no race to lose.
     */
    this.tryDispatchRoots()
  }

  get id(): string {
    return this.state.id
  }

  private step(ref: string): MissionStepState | undefined {
    return this.state.steps.find((s) => s.ref === ref)
  }

  private stepForNode(nodeId: string): MissionStepState | undefined {
    const ref = this.byNode.get(nodeId)
    return ref ? this.step(ref) : undefined
  }

  private touch(): void {
    this.state.lastProgressAt = this.now()
  }

  /** Send a root step its brief, if it is ready to receive one. */
  private tryDispatchRoots(): void {
    if (this.state.status !== 'running') return

    for (const step of this.state.steps) {
      if (step.dependsOn) continue // the router delivers these
      if (step.status !== 'pending' || this.dispatched.has(step.ref)) continue
      if (!step.nodeId) continue

      const session = this.deps.sessionForNode(step.nodeId)
      if (!session) continue

      /**
       * Sanitised on the way out, not on the way in.
       *
       * The brief came from a model and is about to become keystrokes in a real
       * pseudo-terminal. Doing it here means the guarantee holds for every path
       * that reaches a pty, exactly as the router does it — and the `\r` below
       * is the only control character that ever gets through.
       */
      const safe = sanitizeForTerminal(step.brief)
      if (!safe) {
        step.status = 'failed'
        step.note = 'The brief was empty once cleaned, so nothing was sent.'
        this.dispatched.add(step.ref)
        this.deps.record('warn', 'step.empty', `${step.title} had nothing to send.`, {
          ref: step.ref
        })
        this.blockDependents(step.ref, `${step.title} never started.`)
        this.settle()
        continue
      }

      this.dispatched.add(step.ref)
      step.status = 'running'
      step.startedAt = this.now()
      this.touch()
      this.deps.deliver(session, `${safe}\r`)
      this.deps.record('info', 'step.dispatch', `${step.title} — ${step.role}`, {
        ref: step.ref,
        agent: step.agentKind,
        brief: safe.slice(0, 200)
      })
    }
  }

  /**
   * A node's terminal changed state.
   *
   * `idle` on a root is the cue to type its brief. `busy` on any step means it
   * is genuinely working, which is what turns the board amber rather than
   * guessing from elapsed time.
   */
  noteStatus(nodeId: string, status: string): void {
    const step = this.stepForNode(nodeId)
    if (!step || this.state.status !== 'running') return

    if (status === 'idle') {
      this.tryDispatchRoots()
      return
    }

    if (status === 'busy' && step.status === 'pending') {
      // A downstream step the router just prompted. It is working now even
      // though this tracker never typed anything into it.
      step.status = 'running'
      step.startedAt = this.now()
      this.touch()
      this.deps.record('info', 'step.begin', `${step.title} picked up the handoff.`, {
        ref: step.ref
      })
    }
  }

  /** A step's agent finished a turn and produced something. */
  noteTurn(nodeId: string, output: string): void {
    const step = this.stepForNode(nodeId)
    if (!step || this.state.status !== 'running') return
    if (step.status === 'done' || step.status === 'failed') return

    step.status = 'done'
    step.finishedAt = this.now()
    step.output = output.trim().slice(-MAX_OUTPUT_PREVIEW)
    this.touch()
    this.deps.record('info', 'step.done', `${step.title} finished — ${step.role}.`, {
      ref: step.ref,
      ms: step.startedAt ? step.finishedAt - step.startedAt : undefined
    })
    this.settle()
  }

  /**
   * A step's terminal died.
   *
   * Only a failure if the step had not already finished: an agent exiting after
   * its work is done is ordinary, and marking that as a failure would make
   * every completed mission look broken.
   */
  noteExit(nodeId: string, exitCode?: number): void {
    const step = this.stepForNode(nodeId)
    if (!step || this.state.status !== 'running') return
    if (step.status === 'done') return

    step.status = 'failed'
    step.finishedAt = this.now()
    step.note =
      exitCode === undefined
        ? 'The terminal closed before this step reported anything.'
        : `The terminal exited with code ${exitCode} before this step reported anything.`
    this.touch()
    this.deps.record('error', 'step.failed', `${step.title} stopped before finishing.`, {
      ref: step.ref,
      exitCode
    })
    this.blockDependents(step.ref, `${step.title} did not finish.`)
    this.settle()
  }

  /**
   * Mark everything downstream of a failure unreachable.
   *
   * Transitive, and safe against a malformed plan because a dependency can only
   * ever point at an earlier step — so following them terminates.
   */
  private blockDependents(ref: string, why: string): void {
    let changed = true
    const dead = new Set([ref])
    while (changed) {
      changed = false
      for (const step of this.state.steps) {
        if (!step.dependsOn || !dead.has(step.dependsOn)) continue
        if (step.status === 'done' || step.status === 'failed' || step.status === 'blocked') {
          dead.add(step.ref)
          continue
        }
        step.status = 'blocked'
        step.note = why
        dead.add(step.ref)
        changed = true
        this.deps.record('warn', 'step.blocked', `${step.title} cannot run — ${why}`, {
          ref: step.ref
        })
      }
    }
  }

  /** Decide whether the mission as a whole is over. */
  private settle(): void {
    if (this.state.status !== 'running') return
    const steps = this.state.steps

    if (steps.every((s) => s.status === 'done')) {
      this.state.status = 'done'
      this.state.finishedAt = this.now()
      this.deps.record('info', 'mission.done', `Mission complete: ${this.state.summary}`, {
        missionId: this.state.id,
        ms: this.state.finishedAt - this.state.startedAt
      })
      return
    }

    const settled = (s: MissionStepState): boolean =>
      s.status === 'done' || s.status === 'failed' || s.status === 'blocked'

    if (steps.every(settled)) {
      this.state.status = 'failed'
      this.state.finishedAt = this.now()
      const bad = steps.filter((s) => s.status !== 'done').length
      this.deps.record('error', 'mission.failed', `Mission stopped — ${bad} step(s) did not run.`, {
        missionId: this.state.id
      })
    }
  }

  /** Stop the mission. Nothing further is dispatched or recorded against it. */
  abort(reason = 'Stopped by the operator.'): void {
    if (this.state.status !== 'running') return
    this.state.status = 'aborted'
    this.state.finishedAt = this.now()
    for (const step of this.state.steps) {
      if (step.status === 'pending' || step.status === 'running') {
        step.status = 'blocked'
        step.note = reason
      }
    }
    this.deps.record('warn', 'mission.aborted', reason, { missionId: this.state.id })
  }

  /**
   * The whole board, in one object.
   *
   * `stalled` is computed here rather than kept by a timer: a timer would be one
   * more thing to clear on teardown, and the answer is a subtraction.
   */
  snapshot(): MissionState {
    const now = this.now()
    const totals = { total: this.state.steps.length, done: 0, running: 0, failed: 0, blocked: 0 }
    for (const s of this.state.steps) {
      if (s.status === 'done') totals.done++
      else if (s.status === 'running') totals.running++
      else if (s.status === 'failed') totals.failed++
      else if (s.status === 'blocked') totals.blocked++
    }

    return {
      ...this.state,
      totals,
      stalled: this.state.status === 'running' && now - this.state.lastProgressAt > STALL_AFTER_MS,
      steps: this.state.steps.map((s) => ({ ...s }))
    }
  }
}
