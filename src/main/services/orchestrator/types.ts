/**
 * BRUTUS Multi-Agent Orchestrator — shared types
 * ----------------------------------------------
 * One request in, a DAG of specialised agent tasks out, one synthesised answer
 * back. Everything the planner, scheduler, agents and UI exchange is defined
 * here so the wire shape is identical in main and renderer.
 */

// ─── Model routing ──────────────────────────────────────────────────────────

/**
 * What KIND of thinking a call needs. Roles map to provider fallback chains in
 * model-router.ts rather than to a single model, so a deprecated or
 * rate-limited model degrades instead of failing the run.
 */
export type ModelRole =
  | 'plan' // decomposition — needs strong structured output
  | 'research' // long-context synthesis over raw search results
  | 'worker' // general agent reasoning + tool use
  | 'fast' // cheap classification / validation / extraction
  | 'vision' // image understanding
  | 'synth' // final merge into one answer
  | 'edge' // honour the Brain Node toggle via runChat()

export type ProviderName = 'groq' | 'gemini' | 'huggingface' | 'edge'

export interface ModelCandidate {
  provider: ProviderName
  model: string
  /** Rough context budget, used to decide how much evidence we can inline. */
  contextTokens?: number
}

export interface LlmRequest {
  role: ModelRole
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  /** Ask the provider for strict JSON back. */
  json?: boolean
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface LlmResponse {
  text: string
  provider: ProviderName
  model: string
  /** Every candidate that failed before this one succeeded, for diagnostics. */
  attempts: { provider: ProviderName; model: string; error: string }[]
  elapsedMs: number
}

// ─── Capabilities ───────────────────────────────────────────────────────────

/**
 * Risk classification. This is the whole basis of the approval gate:
 *   read        free — search, read, analyse. Never prompts.
 *   write       creates/modifies something locally (a file, a note).
 *   external    leaves the machine (email, WhatsApp). Always prompts.
 *   destructive irreversible (delete, overwrite, shell). Always prompts.
 */
export type CapabilityTag = 'read' | 'write' | 'external' | 'destructive'

export interface CapabilitySpec {
  name: string
  tags: CapabilityTag[]
  /** One line the model sees, describing when to use this. */
  description: string
  /** JSON-schema-ish hint for arguments, shown to the agent. */
  args?: Record<string, string>
}

export interface CapabilityCall {
  capability: string
  args: Record<string, unknown>
}

export interface CapabilityResult {
  ok: boolean
  /** Stringified for the model. Large payloads are truncated by the runner. */
  output: string
  error?: string
  /** Set when the call was blocked pending user approval. */
  needsApproval?: boolean
}

// ─── Plan / tasks ───────────────────────────────────────────────────────────

export type AgentName =
  | 'researcher'
  | 'analyst'
  | 'librarian'
  | 'scribe'
  | 'courier'
  | 'filesmith'
  | 'coder'
  | 'operator'

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'awaiting-approval'
  | 'validating'
  | 'done'
  | 'failed'
  | 'skipped'

export interface PlannedTask {
  id: string
  agent: AgentName
  /** Imperative, self-contained goal for that agent. */
  goal: string
  /** Task ids whose outputs this one needs. Drives ordering + parallelism. */
  dependsOn: string[]
}

export interface Plan {
  /** One-line restatement of what the user actually wants. */
  objective: string
  tasks: PlannedTask[]
}

export interface TaskState extends PlannedTask {
  status: TaskStatus
  output?: string
  error?: string
  /**
   * Critic feedback for a retry, kept SEPARATE from `goal`.
   *
   * This used to be appended onto `goal`, which corrupted everything that reads
   * a goal: the researcher used it as a literal search query (blowing Tavily's
   * 400-char limit) and the final answer printed "(Your previous attempt was
   * rejected…)" back to the user. The goal is now immutable.
   */
  feedback?: string
  attempts: number
  startedAt?: number
  finishedAt?: number
  provider?: ProviderName
  model?: string
  /** Capability calls this task made, for the run log. */
  calls: { capability: string; ok: boolean; summary: string }[]
  critique?: { pass: boolean; reason: string }
}

// ─── Approvals ──────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  id: string
  runId: string
  taskId: string
  agent: AgentName
  capability: string
  tags: CapabilityTag[]
  args: Record<string, unknown>
  /** Human-readable description of exactly what will happen. */
  summary: string
  createdAt: number
}

// ─── Runs ───────────────────────────────────────────────────────────────────

export type RunStatus =
  | 'planning'
  | 'running'
  | 'awaiting-approval'
  | 'synthesizing'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface RunState {
  id: string
  request: string
  status: RunStatus
  objective?: string
  tasks: TaskState[]
  answer?: string
  error?: string
  startedAt: number
  finishedAt?: number
  pendingApproval?: ApprovalRequest | null
}

/** Everything pushed to the renderer on the `orchestrator-event` channel. */
export type RunEvent =
  | { type: 'run-started'; run: RunState }
  | { type: 'plan-ready'; runId: string; objective: string; tasks: TaskState[] }
  | { type: 'task-updated'; runId: string; task: TaskState }
  | { type: 'approval-required'; runId: string; approval: ApprovalRequest }
  | { type: 'approval-resolved'; runId: string; approvalId: string; granted: boolean }
  | { type: 'run-finished'; run: RunState }
  | { type: 'log'; runId: string; line: string }

// ─── Config ─────────────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  /** Groq keys, tried round-robin. More keys = more parallel headroom. */
  groqKeys: string[]
  tavilyKey: string
  hfKey: string
  /** Per-role model overrides, keyed by `${role}` → model id. */
  modelOverrides: Partial<Record<ModelRole, string>>
  /** How many tasks may run at once. */
  concurrency: number
  /** 'guarded' prompts for write/external/destructive; 'autonomous' never does. */
  autonomy: 'guarded' | 'strict' | 'autonomous'
  /** Hard ceiling on tool iterations inside one agent turn. */
  maxToolIterations: number
  /**
   * Hard ceiling on LLM calls a single run may spend. Without this a plan with
   * a few tasks, each looping and retrying, can quietly burn a hundred requests
   * and exhaust a free tier. When the budget runs out agents stop looping and
   * answer with what they already have, so the run still finishes.
   */
  maxLlmCallsPerRun: number
  /** Minimum gap between two requests on the same Groq key (proactive limiting). */
  minKeyIntervalMs: number
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  groqKeys: [],
  tavilyKey: '',
  hfKey: '',
  modelOverrides: {},
  concurrency: 3,
  autonomy: 'guarded',
  // 3, not 6: in practice agents settle in 1-2 tool calls, and every extra
  // iteration is a whole request against the quota.
  maxToolIterations: 3,
  maxLlmCallsPerRun: 20,
  minKeyIntervalMs: 2100
}

/** Spend tracker for one run. Shared by every agent in that run. */
export interface CallBudget {
  limit: number
  used: number
  /** Reserve one call. Returns false when the run is out of budget. */
  consume: () => boolean
  remaining: () => number
}

export function createCallBudget(limit: number): CallBudget {
  const budget = {
    limit: Math.max(1, limit),
    used: 0,
    consume: (): boolean => {
      if (budget.used >= budget.limit) return false
      budget.used++
      return true
    },
    remaining: (): number => Math.max(0, budget.limit - budget.used)
  }
  return budget
}
