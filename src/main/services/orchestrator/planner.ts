/**
 * BRUTUS Orchestrator — planner
 * ------------------------------
 * Turns one user request into a validated DAG of agent tasks.
 *
 * The model is asked for JSON, but a model producing a *plausible-looking* plan
 * that references a missing dependency or contains a cycle would deadlock the
 * scheduler forever. So nothing the model returns is trusted: every plan is
 * schema-checked, every agent name and dependency id is verified to exist, and
 * the graph is topologically sorted to prove it is acyclic before a single
 * agent runs.
 */
import { agentRosterForPlanner, getAgent } from './agents'
import type { ModelRouter } from './model-router'
import type { AgentName, Plan, PlannedTask } from './types'

const MAX_TASKS = 12

const PLANNER_SYSTEM = `You are the Planner for Brutus, a multi-agent assistant.

Decompose the user's request into the SMALLEST set of subtasks that fully
answers it, and assign each to the right specialist.

Available specialists:
{{ROSTER}}

Return ONLY a JSON object:
{
  "objective": "one sentence restating what the user actually wants",
  "tasks": [
    {
      "id": "t1",
      "agent": "researcher",
      "goal": "self-contained imperative instruction for this specialist",
      "dependsOn": []
    }
  ]
}

Planning rules:
- Between 1 and ${MAX_TASKS} tasks. Prefer FEWER. A simple request is one task.
- "dependsOn" lists the ids whose OUTPUT this task needs. Tasks with no
  dependency on each other run in parallel, so leave dependsOn empty whenever a
  task can genuinely start immediately. Do not serialise for neatness.
- Never create a cycle. Dependencies must point to earlier tasks only.
- Each "goal" must stand alone. The specialist sees the goal plus the outputs of
  its dependencies, nothing else - so never write "the above" or "that result".
- Writing something and sending it are SEPARATE tasks: scribe drafts, courier
  sends, and the courier task depends on the scribe task.
- Only use agent names from the list. Never invent one.`

/** Guard-rail result: either a clean plan or a precise reason it was rejected. */
export type PlanValidation =
  | { ok: true; plan: Plan; order: string[] }
  | { ok: false; error: string }

/**
 * Validate a raw model plan. Rejects anything that would break the scheduler:
 * unknown agents, dangling dependencies, duplicate ids, self-loops, cycles.
 * Returns a topological order as proof the graph is runnable.
 */
export function validatePlan(raw: unknown): PlanValidation {
  const p = raw as Partial<Plan>
  if (!p || typeof p !== 'object') return { ok: false, error: 'Plan was not an object.' }
  if (!Array.isArray(p.tasks) || p.tasks.length === 0) {
    return { ok: false, error: 'Plan contained no tasks.' }
  }
  if (p.tasks.length > MAX_TASKS) {
    return { ok: false, error: `Plan had ${p.tasks.length} tasks (max ${MAX_TASKS}).` }
  }

  const tasks: PlannedTask[] = []
  const seen = new Set<string>()

  for (const [i, t] of p.tasks.entries()) {
    const id = String((t as PlannedTask)?.id ?? '').trim() || `t${i + 1}`
    if (seen.has(id)) return { ok: false, error: `Duplicate task id "${id}".` }
    seen.add(id)

    const agent = String((t as PlannedTask)?.agent ?? '').trim() as AgentName
    if (!getAgent(agent)) {
      return { ok: false, error: `Task "${id}" names unknown agent "${agent}".` }
    }

    const goal = String((t as PlannedTask)?.goal ?? '').trim()
    if (!goal) return { ok: false, error: `Task "${id}" has no goal.` }

    const dependsOnRaw = (t as PlannedTask)?.dependsOn
    const dependsOn = Array.isArray(dependsOnRaw) ? dependsOnRaw.map((d) => String(d).trim()) : []
    if (dependsOn.includes(id)) return { ok: false, error: `Task "${id}" depends on itself.` }

    tasks.push({ id, agent, goal, dependsOn })
  }

  // Every dependency must reference a real task.
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!seen.has(d)) {
        return { ok: false, error: `Task "${t.id}" depends on unknown task "${d}".` }
      }
    }
  }

  // Kahn's algorithm: if we cannot drain every node, a cycle exists.
  const indegree = new Map<string, number>(tasks.map((t) => [t.id, t.dependsOn.length]))
  const dependents = new Map<string, string[]>()
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      dependents.set(d, [...(dependents.get(d) ?? []), t.id])
    }
  }

  const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1
      indegree.set(next, left)
      if (left === 0) queue.push(next)
    }
  }

  if (order.length !== tasks.length) {
    const stuck = tasks.filter((t) => !order.includes(t.id)).map((t) => t.id)
    return { ok: false, error: `Plan has a dependency cycle involving: ${stuck.join(', ')}.` }
  }

  return {
    ok: true,
    plan: { objective: String(p.objective ?? '').trim() || 'Complete the request.', tasks },
    order
  }
}

/**
 * Ask the model for a plan. One retry, with the validation error fed back so
 * the model can correct itself rather than failing the whole run.
 */
export async function makePlan(
  router: ModelRouter,
  request: string,
  signal?: AbortSignal
): Promise<{ plan: Plan; model: string }> {
  const system = PLANNER_SYSTEM.replace('{{ROSTER}}', agentRosterForPlanner())
  let lastError = ''

  for (let attempt = 0; attempt < 2; attempt++) {
    const userContent =
      attempt === 0
        ? request
        : `${request}\n\nYour previous plan was rejected: ${lastError}\nReturn a corrected plan.`

    const { data, meta } = await router.completeJson({
      role: 'plan',
      system,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.2,
      signal
    })

    const check = validatePlan(data)
    if (check.ok) return { plan: check.plan, model: `${meta.provider}/${meta.model}` }
    lastError = check.error
  }

  throw new Error(`Planner failed to produce a runnable plan: ${lastError}`)
}
