/**
 * BRUTUS Orchestrator — agent runner
 * -----------------------------------
 * Runs ONE task with ONE agent, and returns that agent's final text.
 *
 * Two execution shapes:
 *
 *  • `pipeline: 'research'` — a fixed two-stage pass. Tavily gathers eight
 *    pages of raw evidence, then openai/gpt-oss-120b reasons over all of it in
 *    a single 131k-context call and writes a cited synthesis. Deterministic and
 *    one round-trip, which is why research does not use the generic loop.
 *
 *  • everything else — a bounded tool-calling loop. The model replies with
 *    either a capability call or a final answer, as JSON. Iterations are capped
 *    so a confused agent cannot spin forever.
 *
 * Approval: when a capability needs the user's consent the runner does not
 * fail. It throws `ApprovalNeeded`, the scheduler pauses that task and asks,
 * and on approval the runner resumes with the identical call plus a token.
 */
import { getAgent, type AgentSpec } from './agents'
import { listCapabilities, runCapability } from './capability-bus'
import { tavilySearch } from './capabilities'
import { parseJsonLoose, type ModelRouter } from './model-router'
import type { CallBudget, CapabilityTag, OrchestratorConfig, TaskState } from './types'

export class ApprovalNeeded extends Error {
  constructor(
    public capability: string,
    public args: Record<string, unknown>,
    public tags: CapabilityTag[],
    public summary: string
  ) {
    super(`approval required: ${capability}`)
    this.name = 'ApprovalNeeded'
  }
}

export interface AgentRunContext {
  router: ModelRouter
  config: OrchestratorConfig
  /** Outputs of this task's dependencies, in plan order. */
  upstream: { id: string; agent: string; goal: string; output: string }[]
  /** Approvals already granted for this task, keyed by `capability:fingerprint`. */
  approvals: Map<string, string>
  /** Critic feedback from a rejected previous attempt, if any. */
  feedback?: string
  /** Run-wide LLM call budget, shared by every agent in this run. */
  budget?: CallBudget
  onCall?: (capability: string, ok: boolean, summary: string) => void
  onLog?: (line: string) => void
  signal?: AbortSignal
}

export interface AgentRunResult {
  output: string
  provider: string
  model: string
}

function approvalKey(capability: string, args: Record<string, unknown>): string {
  try {
    return `${capability}:${JSON.stringify(args, Object.keys(args).sort())}`
  } catch {
    return `${capability}:${String(args)}`
  }
}

/** One line describing exactly what a gated call will do, shown to the user. */
export function describeCall(capability: string, args: Record<string, unknown>): string {
  const brief = (v: unknown, n = 90): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s && s.length > n ? `${s.slice(0, n)}…` : String(s ?? '')
  }
  switch (capability) {
    case 'gmail-send':
      return `Send an email to ${brief(args.to)} with subject "${brief(args.subject, 60)}"`
    case 'run-shell-command':
      return `Run shell command: ${brief(args.command, 120)}`
    case 'file-ops':
      return `${String(args.operation ?? 'modify').toUpperCase()} ${brief(args.source_path)}${
        args.dest_path ? ` → ${brief(args.dest_path)}` : ''
      }`
    case 'write-file':
      return `Write file ${brief(args.file_name)} (${String(args.content ?? '').length} chars)`
    case 'save-note':
      return `Save note "${brief(args.title, 60)}"`
    case 'gmail-draft':
      return `Create a Gmail draft to ${brief(args.to)}`
    default:
      return `${capability} ${brief(args, 120)}`
  }
}

/**
 * Turn a task GOAL (an instruction written for an agent) into a SEARCH QUERY
 * (what you would actually type into a search engine).
 *
 * Goals look like "Search the web for current open-source LLMs, evaluate them
 * on performance and licensing, and provide a ranked list with citations."
 * Fed verbatim to Tavily that is both a poor query and, once retry feedback was
 * appended, longer than Tavily's hard 400-character limit.
 */
export function toSearchQuery(goal: string): string {
  let q = String(goal || '')
    // Never let multi-line prompt scaffolding reach the query.
    .split('\n')[0]
    .trim()

  // Drop the imperative lead-in; the search engine does not need it.
  q = q.replace(
    /^(please\s+)?(search (the )?(web|internet|online) (for|about)|find( and (summari[sz]e|rank|compare))?|research|look up|investigate|gather( information about)?|identify)\s*:?\s*/i,
    ''
  )

  // Drop trailing instructions about FORMAT, which are not search terms.
  q = q.replace(
    /[,;.]?\s*(and\s+)?(then\s+)?(provide|include|return|give|produce|output|present|summari[sz]e|write|list)\b.*$/i,
    ''
  )
  q = q.replace(
    /[,;.]?\s*(with|including)\s+(brief\s+)?(descriptions?|citations?|sources?|links?)\b.*$/i,
    ''
  )

  q = q
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,;:.]+$/, '')

  // Fall back to the original if stripping ate everything meaningful.
  if (q.length < 8)
    q = String(goal || '')
      .split('\n')[0]
      .trim()

  return truncateQuery(q)
}

/** Tavily rejects queries over 400 characters, so cap on a word boundary. */
export function truncateQuery(q: string, limit = 380): string {
  const s = q.trim()
  if (s.length <= limit) return s
  const cut = s.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim()
}

function upstreamBlock(ctx: AgentRunContext): string {
  if (!ctx.upstream.length) return ''
  return (
    '\n\nFindings from earlier tasks you depend on:\n' +
    ctx.upstream
      .map((u) => `--- from ${u.agent} (task ${u.id}: ${u.goal}) ---\n${u.output}`)
      .join('\n\n')
  )
}

// ── Research pipeline ───────────────────────────────────────────────────────

async function runResearchPipeline(
  spec: AgentSpec,
  task: TaskState,
  ctx: AgentRunContext
): Promise<AgentRunResult> {
  const query = toSearchQuery(task.goal)
  ctx.onLog?.(`searching the web for: ${query}`)

  const { answer, sources } = await tavilySearch(query, { maxResults: 8 })
  ctx.onCall?.('web_search', true, `${sources.length} sources`)

  if (!sources.length) {
    return {
      output: `No web sources were found for "${query}", so there is nothing to report on: ${task.goal}`,
      provider: 'none',
      model: 'none'
    }
  }

  // Number every source so the model can cite [n] and we can map back to URLs.
  const evidence = sources
    .map((s) => `[${s.index}] ${s.title}\nURL: ${s.url}\n${s.content}`)
    .join('\n\n---\n\n')

  // Today's date matters: without it models reach for "the latest" from training
  // memory and invent plausible-sounding future releases. The critic caught
  // exactly that (fabricated models and 2026 sources), so ground the model in
  // real time and forbid anything not present in the evidence.
  const today = new Date().toISOString().slice(0, 10)

  // The synthesis call counts against the run budget like any other.
  if (ctx.budget && !ctx.budget.consume()) {
    return {
      output: `Gathered ${sources.length} sources for "${query}" but the run ran out of call budget before they could be synthesised.\n\n${sources
        .map((s) => `[${s.index}] ${s.title} - ${s.url}`)
        .join('\n')}`,
      provider: 'none',
      model: 'none'
    }
  }

  const res = await ctx.router.complete({
    role: 'research',
    system: `${spec.system}

Today's date is ${today}.

GROUNDING RULES (absolute):
- Every product, model, version, company, number, date and claim you write MUST
  appear in the numbered sources below. If it is not there, do not write it.
- Do NOT add anything from memory, however confident you are. Your training data
  is older than these sources and naming a release that is not in them is a
  fabrication, not helpfulness.
- If the sources are thin or do not cover part of the task, say so explicitly
  and answer only what they support.`,
    messages: [
      {
        role: 'user',
        content:
          `Task: ${task.goal}` +
          (ctx.feedback
            ? `\n\nYour previous attempt was rejected: ${ctx.feedback}\nDo not repeat that mistake.`
            : '') +
          (answer ? `\n\nSearch engine's quick answer (verify against sources): ${answer}` : '') +
          upstreamBlock(ctx) +
          `\n\nSources:\n\n${evidence}`
      }
    ],
    temperature: 0.15,
    maxTokens: 4096,
    signal: ctx.signal
  })

  // Append the source list so citations stay resolvable downstream.
  const bibliography = sources.map((s) => `[${s.index}] ${s.title} - ${s.url}`).join('\n')

  return {
    output: `${res.text.trim()}\n\nSources:\n${bibliography}`,
    provider: res.provider,
    model: res.model
  }
}

// ── Generic tool loop ───────────────────────────────────────────────────────

interface AgentStep {
  thought?: string
  action?: { capability?: string; args?: Record<string, unknown> }
  final?: string
}

function toolLoopSystem(spec: AgentSpec): string {
  const caps = listCapabilities(spec.capabilities)
  const catalogue = caps.length
    ? caps
        .map((c) => {
          const args = c.args
            ? Object.entries(c.args)
                .map(([k, v]) => `      ${k}: ${v}`)
                .join('\n')
            : '      (no arguments)'
          const risk = c.tags.includes('read') ? '' : `  [needs user approval: ${c.tags.join(',')}]`
          return `  - ${c.name}${risk}\n      ${c.description}\n${args}`
        })
        .join('\n')
    : '  (none — answer from reasoning alone)'

  return `${spec.system}

Tools you may use:
${catalogue}

Reply with ONLY a JSON object, one of these two shapes:

  {"thought": "why this tool", "action": {"capability": "name", "args": {...}}}
  {"final": "your complete answer to the task"}

Call one tool at a time. When you have enough to answer, return "final".
Never invent a tool name that is not listed above.`
}

async function runToolLoop(
  spec: AgentSpec,
  task: TaskState,
  ctx: AgentRunContext
): Promise<AgentRunResult> {
  const system = toolLoopSystem(spec)
  const transcript: { role: 'user' | 'assistant'; content: string }[] = [
    {
      role: 'user',
      content:
        `Task: ${task.goal}` +
        (ctx.feedback
          ? `\n\nYour previous attempt was rejected: ${ctx.feedback}\nDo not repeat that mistake.`
          : '') +
        upstreamBlock(ctx)
    }
  ]

  let lastProvider = 'none'
  let lastModel = 'none'
  const maxIterations = Math.max(1, ctx.config.maxToolIterations)
  let outOfBudget = false

  for (let i = 0; i < maxIterations; i++) {
    if (ctx.signal?.aborted) throw new Error('cancelled')

    // Stop looping once the run has spent its call allowance. Breaking here
    // (rather than erroring) lets the agent still deliver what it has.
    if (ctx.budget && !ctx.budget.consume()) {
      ctx.onLog?.('out of run call budget — answering with what I have')
      outOfBudget = true
      break
    }

    const res = await ctx.router.complete({
      role: spec.role,
      system,
      messages: transcript,
      json: true,
      temperature: 0.3,
      signal: ctx.signal
    })
    lastProvider = res.provider
    lastModel = res.model

    let step: AgentStep
    try {
      step = parseJsonLoose<AgentStep>(res.text)
    } catch {
      // The model wrote prose instead of JSON. On the last iteration that prose
      // is almost certainly the answer, so take it rather than losing the work.
      if (i === maxIterations - 1) {
        return { output: res.text.trim(), provider: lastProvider, model: lastModel }
      }
      transcript.push({ role: 'assistant', content: res.text })
      transcript.push({
        role: 'user',
        content: 'That was not valid JSON. Reply with only the JSON object.'
      })
      continue
    }

    if (step.final !== undefined && String(step.final).trim()) {
      return { output: String(step.final).trim(), provider: lastProvider, model: lastModel }
    }

    const capName = step.action?.capability
    if (!capName) {
      transcript.push({ role: 'assistant', content: res.text })
      transcript.push({
        role: 'user',
        content: 'You returned neither an action nor a final answer. Do one or the other.'
      })
      continue
    }

    if (!spec.capabilities.includes(capName)) {
      transcript.push({ role: 'assistant', content: res.text })
      transcript.push({
        role: 'user',
        content: `Tool "${capName}" is not available to you. Choose from: ${spec.capabilities.join(', ')}.`
      })
      continue
    }

    const args = step.action?.args ?? {}
    ctx.onLog?.(`${capName} ${JSON.stringify(args).slice(0, 140)}`)

    const token = ctx.approvals.get(approvalKey(capName, args))
    const result = await runCapability(capName, args, {
      autonomy: ctx.config.autonomy,
      approvalToken: token,
      signal: ctx.signal
    })

    if (result.needsApproval) {
      // Hand control back to the scheduler, which asks the user and re-runs us.
      const spec2 = listCapabilities([capName])[0]
      throw new ApprovalNeeded(capName, args, spec2?.tags ?? ['write'], describeCall(capName, args))
    }

    ctx.onCall?.(capName, result.ok, result.ok ? 'ok' : (result.error ?? 'failed'))

    transcript.push({ role: 'assistant', content: res.text })
    transcript.push({
      role: 'user',
      content: result.ok
        ? `Result of ${capName}:\n${result.output}`
        : `${capName} FAILED: ${result.error}. Adapt or explain why you cannot continue.`
    })
  }

  // Iterations exhausted without a final answer.
  //
  // If the RUN is out of budget, spending another call to write a summary is
  // exactly the waste the budget exists to prevent — hand back the evidence
  // already gathered instead. Only pay for a wrap-up when budget remains.
  if (outOfBudget || (ctx.budget && !ctx.budget.consume())) {
    const gathered = transcript
      .filter((m) => m.role === 'user' && m.content.startsWith('Result of '))
      .map((m) => m.content)
      .join('\n\n')
    return {
      output:
        gathered.trim() ||
        `This task ran out of the run's call budget before reaching an answer: ${task.goal.split('\n')[0]}`,
      provider: lastProvider,
      model: lastModel
    }
  }

  const wrap = await ctx.router.complete({
    role: spec.role,
    system: spec.system,
    messages: [
      ...transcript,
      {
        role: 'user',
        content: 'You are out of tool budget. Give your best complete answer now, as plain text.'
      }
    ],
    temperature: 0.3,
    signal: ctx.signal
  })
  return { output: wrap.text.trim(), provider: wrap.provider, model: wrap.model }
}

export async function runAgentTask(task: TaskState, ctx: AgentRunContext): Promise<AgentRunResult> {
  const spec = getAgent(task.agent)
  if (!spec) throw new Error(`Unknown agent "${task.agent}"`)
  return spec.pipeline === 'research'
    ? runResearchPipeline(spec, task, ctx)
    : runToolLoop(spec, task, ctx)
}
