/**
 * BRUTUS Orchestrator — scheduler
 * --------------------------------
 * Executes a validated plan.
 *
 * Model: repeatedly take every task whose dependencies are all satisfied (the
 * "ready frontier") and run them CONCURRENTLY up to a cap. That is where the
 * speed comes from - research and a document lookup have no reason to wait for
 * each other, and only genuinely dependent work is serialised.
 *
 * Three behaviours worth knowing:
 *  • Approval: a task that hits a gated capability parks in
 *    `awaiting-approval`, the run raises the request, and the whole scheduler
 *    waits. On approval the task re-runs from the start of its agent turn with
 *    a single-use token; on refusal it fails cleanly.
 *  • Retry: a failed or critic-rejected task gets exactly one more attempt,
 *    with the critic's reason fed back so the retry is informed.
 *  • Degradation: when a task ultimately fails, its dependents are marked
 *    `skipped` rather than run on missing input, and the run still synthesises
 *    whatever did succeed. A partial answer beats no answer.
 */
import { ApprovalNeeded, runAgentTask, type AgentRunContext } from './agent-runner'
import { grantApproval } from './capability-bus'
import { critique } from './critic'
import type { ModelRouter } from './model-router'
import type {
  ApprovalRequest,
  CallBudget,
  OrchestratorConfig,
  Plan,
  RunState,
  TaskState
} from './types'

export interface SchedulerHooks {
  onTaskUpdate: (task: TaskState) => void
  onLog: (line: string) => void
  /**
   * Ask the user. Resolves true when they approve. The scheduler is fully
   * paused while this is pending.
   */
  requestApproval: (req: ApprovalRequest) => Promise<boolean>
}

let approvalSeq = 0

export function planToTasks(plan: Plan): TaskState[] {
  return plan.tasks.map((t) => ({ ...t, status: 'pending', attempts: 0, calls: [] }))
}

export async function runPlan(
  run: RunState,
  router: ModelRouter,
  config: OrchestratorConfig,
  hooks: SchedulerHooks,
  signal?: AbortSignal,
  budget?: CallBudget
): Promise<void> {
  const byId = new Map(run.tasks.map((t) => [t.id, t]))
  const concurrency = Math.max(1, config.concurrency)

  const isSettled = (t: TaskState): boolean =>
    t.status === 'done' || t.status === 'failed' || t.status === 'skipped'

  /** Dependencies all finished successfully. */
  const isReady = (t: TaskState): boolean =>
    t.status === 'pending' && t.dependsOn.every((d) => byId.get(d)?.status === 'done')

  /** A dependency failed or was skipped, so this can never run. */
  const isBlocked = (t: TaskState): boolean =>
    t.status === 'pending' &&
    t.dependsOn.some((d) => {
      const dep = byId.get(d)
      return dep?.status === 'failed' || dep?.status === 'skipped'
    })

  const runOne = async (task: TaskState): Promise<void> => {
    const approvals = new Map<string, string>()

    // Each pass is one full agent turn. An approval adds a token and re-runs;
    // a failure consumes one of the two allowed attempts.
    for (let pass = 0; pass < 6; pass++) {
      if (signal?.aborted) return
      task.attempts++
      task.status = 'running'
      task.startedAt = task.startedAt ?? Date.now()
      hooks.onTaskUpdate(task)

      const ctx: AgentRunContext = {
        router,
        config,
        approvals,
        feedback: task.feedback,
        budget,
        upstream: task.dependsOn
          .map((d) => byId.get(d))
          .filter((d): d is TaskState => Boolean(d?.output))
          .map((d) => ({ id: d.id, agent: d.agent, goal: d.goal, output: d.output! })),
        onCall: (capability, ok, summary) => {
          task.calls.push({ capability, ok, summary })
          hooks.onTaskUpdate(task)
        },
        onLog: (line) => hooks.onLog(`[${task.id} ${task.agent}] ${line}`),
        signal
      }

      try {
        const result = await runAgentTask(task, ctx)
        task.output = result.output
        task.provider = result.provider as TaskState['provider']
        task.model = result.model

        // Validate before letting this feed downstream agents.
        //
        // Skipped on the final attempt and when the run is out of budget: the
        // result is accepted either way at that point, so the call could not
        // change the outcome and would only burn quota.
        const canRetry = task.attempts < 2
        const budgetLeft = !budget || budget.remaining() > 0
        if (!canRetry || !budgetLeft) {
          task.status = 'done'
          task.finishedAt = Date.now()
          hooks.onTaskUpdate(task)
          return
        }

        task.status = 'validating'
        hooks.onTaskUpdate(task)
        const verdict = await critique(router, task, signal, budget)
        task.critique = verdict

        if (verdict.pass) {
          task.status = 'done'
          task.finishedAt = Date.now()
          hooks.onTaskUpdate(task)
          return
        }

        hooks.onLog(`[${task.id}] retrying: ${verdict.reason}`)
        // Feedback goes in its own field. Mutating `goal` corrupted the search
        // query and leaked critic chatter into the user-facing answer.
        task.feedback = verdict.reason
        continue
      } catch (err) {
        if (err instanceof ApprovalNeeded) {
          const req: ApprovalRequest = {
            id: `ap_${Date.now()}_${++approvalSeq}`,
            runId: run.id,
            taskId: task.id,
            agent: task.agent,
            capability: err.capability,
            tags: err.tags,
            args: err.args,
            summary: err.summary,
            createdAt: Date.now()
          }
          task.status = 'awaiting-approval'
          hooks.onTaskUpdate(task)

          const granted = await hooks.requestApproval(req)
          if (!granted) {
            task.status = 'failed'
            task.error = `You declined: ${err.summary}`
            task.finishedAt = Date.now()
            hooks.onTaskUpdate(task)
            return
          }

          // Mint a token bound to this exact capability + args, then re-run.
          grantApproval(req.id, err.capability, err.args)
          approvals.set(
            `${err.capability}:${JSON.stringify(err.args, Object.keys(err.args).sort())}`,
            req.id
          )
          task.attempts-- // an approval pause is not a failed attempt
          continue
        }

        if (signal?.aborted || String((err as Error)?.message) === 'cancelled') return

        const message = String((err as { message?: string })?.message || err).slice(0, 400)
        if (task.attempts >= 2) {
          task.status = 'failed'
          task.error = message
          task.finishedAt = Date.now()
          hooks.onTaskUpdate(task)
          return
        }
        hooks.onLog(`[${task.id}] error, retrying: ${message}`)
      }
    }

    if (!isSettled(task)) {
      task.status = 'failed'
      task.error = task.error ?? 'Exceeded the attempt budget.'
      task.finishedAt = Date.now()
      hooks.onTaskUpdate(task)
    }
  }

  // ── Main loop: drain the frontier until nothing is left to do ─────────────
  while (!signal?.aborted) {
    // Anything whose upstream died can never run.
    let changed = false
    for (const t of run.tasks) {
      if (isBlocked(t)) {
        t.status = 'skipped'
        t.error = 'A task it depended on did not complete.'
        hooks.onTaskUpdate(t)
        changed = true
      }
    }
    if (changed) continue

    const frontier = run.tasks.filter(isReady).slice(0, concurrency)
    if (!frontier.length) {
      if (run.tasks.every(isSettled)) break
      // Nothing ready and nothing settled would mean a cycle — the planner
      // proves acyclicity before we get here, so this is a genuine bug guard.
      const stuck = run.tasks.filter((t) => !isSettled(t))
      for (const t of stuck) {
        t.status = 'failed'
        t.error = 'Deadlocked: no runnable path to this task.'
        hooks.onTaskUpdate(t)
      }
      break
    }

    for (const t of frontier) {
      t.status = 'ready'
      hooks.onTaskUpdate(t)
    }
    await Promise.all(frontier.map(runOne))
  }
}
