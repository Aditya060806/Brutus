/**
 * BRUTUS Orchestrator — synthesizer
 * ----------------------------------
 * Merges every finished task into the single answer the user reads.
 *
 * This is the only place the user's actual question is answered, so it runs on
 * the strongest role (`synth`). It receives each agent's output verbatim,
 * including any [n] citations the researcher produced, and is told to keep
 * those intact - losing citations between the researcher and the final answer
 * would quietly turn sourced claims into unsourced ones.
 */
import type { ModelRouter } from './model-router'
import type { RunState, TaskState } from './types'

const SYNTH_SYSTEM = `You are Brutus giving the user their final answer.

Several specialists worked on parts of this request. Merge their findings into
one coherent reply, written in Markdown (it is rendered, so formatting shows).

STRUCTURE
- Open with 1-2 sentences that answer the question directly. No preamble, no
  restating the question back.
- Then use "## " headings to break the answer into scannable sections. Use a
  heading only when there is genuinely more than one section.
- Use "- " bullets for lists of items, and a Markdown table when you are
  comparing three or more things across the same attributes. A table beats a
  wall of bullets for comparisons.
- Keep paragraphs to 2-3 sentences.

FORMATTING DISCIPLINE
- Bold is for the occasional key term only. Do NOT bold whole sentences, and do
  NOT bold every item label - heavy bolding makes output look like noise.
- Never write literal asterisks or hashes as decoration.
- No emoji.

CONTENT
- Preserve [1][2] citations exactly as the specialists wrote them, and keep the
  Sources list at the end when one exists.
- Never describe the process. Do not say "the researcher found" or "task 2
  produced" - the user does not care which agent did what.
- If a subtask failed, add a short "## Not covered" section at the very end
  saying plainly what is missing and what it means. Never paper over a gap.
- Invent nothing that is not in the findings.
- Match the user's language. Direct and concrete; no filler.`

export async function synthesize(
  router: ModelRouter,
  run: RunState,
  signal?: AbortSignal
): Promise<{ answer: string; model: string }> {
  const done = run.tasks.filter((t) => t.status === 'done' && (t.output ?? '').trim())
  const failed = run.tasks.filter((t) => t.status === 'failed' || t.status === 'skipped')

  // Nothing worked — say so honestly instead of asking a model to dress it up.
  // Only the first line of a goal and a trimmed error, so internal retry
  // scaffolding never surfaces as if it were part of the answer.
  if (!done.length) {
    const why = failed
      .map((t) => {
        const goal = t.goal.split('\n')[0].trim()
        const reason = (t.error ?? 'did not complete').split('\n')[0].trim()
        return `- ${t.agent}: ${goal}\n  Reason: ${reason}`
      })
      .join('\n')
    return {
      answer: `I could not complete this request.\n\n${why || 'No tasks produced a result.'}`,
      model: 'none'
    }
  }

  // A single successful task needs no merging; returning it verbatim keeps its
  // citations and formatting exactly as written, and saves a call.
  if (done.length === 1 && !failed.length) {
    return { answer: done[0].output!.trim(), model: 'passthrough' }
  }

  const findings = done
    .map((t: TaskState) => `### ${t.agent} - ${t.goal.split('\n')[0]}\n${t.output!.trim()}`)
    .join('\n\n')

  const problems = failed.length
    ? `\n\nSubtasks that did not complete:\n${failed
        .map(
          (t) => `- ${t.agent}: ${t.goal.split('\n')[0]} (${(t.error ?? 'blocked').split('\n')[0]})`
        )
        .join('\n')}`
    : ''

  const res = await router.complete({
    role: 'synth',
    system: SYNTH_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `The user asked:\n${run.request}\n\nFindings:\n\n${findings}${problems}`
      }
    ],
    temperature: 0.35,
    maxTokens: 4096,
    signal
  })

  return { answer: res.text.trim(), model: `${res.provider}/${res.model}` }
}
