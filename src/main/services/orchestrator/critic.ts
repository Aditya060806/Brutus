/**
 * BRUTUS Orchestrator — critic
 * -----------------------------
 * Checks whether a finished task actually did what it was asked, before its
 * output is fed to downstream agents. Catching a bad result here stops one weak
 * link from poisoning everything that depends on it.
 *
 * Runs on the cheap `fast` role: this is a yes/no judgement, not authorship.
 * The critic deliberately does NOT rewrite the output - it only judges, and a
 * failure sends the task back for one retry with the reason attached.
 */
import type { ModelRouter } from './model-router'
import type { CallBudget, TaskState } from './types'

export interface Critique {
  pass: boolean
  reason: string
}

const CRITIC_SYSTEM = `You review one agent's work on one subtask.

Judge ONLY these things:
- Does the output actually address the stated goal?
- Is it free of obvious fabrication (invented URLs, fake numbers, made-up paths)?
- Is it substantive rather than a restatement of the goal or an empty promise?

You are NOT judging style, length, or whether you would have answered
differently. An honest "I could not do X because Y" is a PASS: it is a real,
useful result.

Return ONLY: {"pass": true|false, "reason": "one short sentence"}`

export async function critique(
  router: ModelRouter,
  task: TaskState,
  signal?: AbortSignal,
  budget?: CallBudget
): Promise<Critique> {
  const output = (task.output ?? '').trim()

  // Cheap structural checks first — no need to spend a call on an empty result.
  if (!output) return { pass: false, reason: 'The task produced no output.' }
  if (output.length < 15) {
    return { pass: false, reason: 'Output was too short to be a real answer.' }
  }

  // Reviewing is a nice-to-have; real work gets the remaining quota.
  if (budget && !budget.consume()) {
    return { pass: true, reason: 'Skipped review: run is out of call budget.' }
  }

  try {
    const { data } = await router.completeJson<Critique>({
      role: 'fast',
      system: CRITIC_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Goal given to the ${task.agent}:\n${task.goal}\n\nIts output:\n${output.slice(0, 6000)}`
        }
      ],
      temperature: 0,
      signal
    })
    return {
      pass: Boolean(data?.pass),
      reason: String(data?.reason ?? '').slice(0, 200) || 'No reason given.'
    }
  } catch {
    // The critic is a safety net, not a gate. If it cannot run (offline, rate
    // limited), let real work through rather than failing a good task.
    return { pass: true, reason: 'Critic unavailable; accepted without review.' }
  }
}
