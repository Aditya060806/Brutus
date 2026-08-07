/**
 * BRUTUS Orchestrator — renderer client
 * --------------------------------------
 * Thin subscribable mirror of the run happening in the main process. The UI
 * reads a snapshot; nothing here does orchestration work itself.
 *
 * `/agent <request>` is the ONLY way a run starts. Ordinary chat never touches
 * this module, so normal conversation keeps its existing single-call latency.
 */

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'awaiting-approval'
  | 'validating'
  | 'done'
  | 'failed'
  | 'skipped'

export interface TaskState {
  id: string
  agent: string
  goal: string
  dependsOn: string[]
  status: TaskStatus
  output?: string
  error?: string
  attempts: number
  startedAt?: number
  finishedAt?: number
  provider?: string
  model?: string
  calls: { capability: string; ok: boolean; summary: string }[]
  critique?: { pass: boolean; reason: string }
}

export interface ApprovalRequest {
  id: string
  runId: string
  taskId: string
  agent: string
  capability: string
  tags: string[]
  args: Record<string, unknown>
  summary: string
  createdAt: number
}

export interface RunState {
  id: string
  request: string
  status:
    | 'planning'
    | 'running'
    | 'awaiting-approval'
    | 'synthesizing'
    | 'done'
    | 'failed'
    | 'cancelled'
  objective?: string
  tasks: TaskState[]
  answer?: string
  error?: string
  startedAt: number
  finishedAt?: number
  pendingApproval?: ApprovalRequest | null
}

export interface AgentInfo {
  name: string
  title: string
  charter: string
  capabilities: string[]
}

export interface KeyPoolStatus {
  total: number
  healthy: number
  cooling: number
  dead: number
  keys: {
    label: string
    inFlight: number
    coolingForMs: number
    dead: boolean
    successes: number
    failures: number
    lastError: string | null
  }[]
}

export interface OrchestratorSnapshot {
  run: RunState | null
  logs: string[]
  approval: ApprovalRequest | null
  keyPool: KeyPoolStatus | null
  agents: AgentInfo[]
  history: RunState[]
}

/** True when a chat message is an orchestration request. */
export const AGENT_COMMAND = '/agent'

export function isAgentCommand(text: string): boolean {
  return String(text || '')
    .trimStart()
    .toLowerCase()
    .startsWith(AGENT_COMMAND)
}

/** Strip the `/agent` prefix, returning the actual request (may be empty). */
export function stripAgentCommand(text: string): string {
  return String(text || '')
    .trimStart()
    .slice(AGENT_COMMAND.length)
    .trim()
}

const MAX_LOGS = 200

class OrchestratorClient {
  private snapshot: OrchestratorSnapshot = {
    run: null,
    logs: [],
    approval: null,
    keyPool: null,
    agents: [],
    history: []
  }
  private listeners = new Set<() => void>()

  constructor() {
    type IncomingEvent = {
      type?: string
      run?: RunState
      task?: TaskState
      approval?: ApprovalRequest
      objective?: string
      tasks?: TaskState[]
      line?: string
    }
    window.electron?.ipcRenderer?.on('orchestrator-event', (_e: unknown, ev: IncomingEvent) => {
      switch (ev?.type) {
        case 'run-started':
          if (!ev.run) return
          this.snapshot = { ...this.snapshot, run: ev.run, logs: [], approval: null }
          break
        case 'plan-ready':
          if (this.snapshot.run) {
            this.snapshot = {
              ...this.snapshot,
              run: {
                ...this.snapshot.run,
                objective: ev.objective,
                tasks: ev.tasks ?? this.snapshot.run.tasks,
                status: 'running'
              }
            }
          }
          break
        case 'task-updated': {
          const run = this.snapshot.run
          const incoming = ev.task
          if (!run || !incoming) break
          const tasks = run.tasks.some((t) => t.id === incoming.id)
            ? run.tasks.map((t) => (t.id === incoming.id ? incoming : t))
            : [...run.tasks, incoming]
          this.snapshot = { ...this.snapshot, run: { ...run, tasks } }
          break
        }
        case 'approval-required':
          if (!ev.approval) return
          this.snapshot = {
            ...this.snapshot,
            approval: ev.approval,
            run: this.snapshot.run
              ? { ...this.snapshot.run, status: 'awaiting-approval' }
              : this.snapshot.run
          }
          break
        case 'approval-resolved':
          this.snapshot = { ...this.snapshot, approval: null }
          break
        case 'run-finished': {
          const finished = ev.run
          if (!finished) return
          this.snapshot = {
            ...this.snapshot,
            run: finished,
            approval: null,
            history: [finished, ...this.snapshot.history].slice(0, 20)
          }
          break
        }
        case 'log': {
          const line = ev.line
          if (!line) return
          this.snapshot = {
            ...this.snapshot,
            logs: [...this.snapshot.logs, line].slice(-MAX_LOGS)
          }
          break
        }
        default:
          return
      }
      this.emit()
    })
  }

  private emit(): void {
    this.listeners.forEach((l) => l())
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  getSnapshot = (): OrchestratorSnapshot => this.snapshot

  get isRunning(): boolean {
    const s = this.snapshot.run?.status
    return s === 'planning' || s === 'running' || s === 'awaiting-approval' || s === 'synthesizing'
  }

  /** Start a run. `request` should already have `/agent` stripped. */
  async run(request: string): Promise<{ ok: boolean; error?: string; runId?: string }> {
    return (await window.electron.ipcRenderer.invoke('orchestrator-run', { request })) as {
      ok: boolean
      error?: string
      runId?: string
    }
  }

  async approve(approvalId: string, granted: boolean): Promise<void> {
    await window.electron.ipcRenderer.invoke('orchestrator-approve', { approvalId, granted })
  }

  async cancel(): Promise<void> {
    await window.electron.ipcRenderer.invoke('orchestrator-cancel')
  }

  /** Pull agents + key-pool health; used on mount and after config changes. */
  async refresh(): Promise<void> {
    try {
      const status = (await window.electron.ipcRenderer.invoke('orchestrator-status')) as {
        run: RunState | null
        keyPool: KeyPoolStatus
        agents: AgentInfo[]
      }
      const history = (await window.electron.ipcRenderer.invoke(
        'orchestrator-history'
      )) as RunState[]
      this.snapshot = {
        ...this.snapshot,
        run: status.run ?? this.snapshot.run,
        keyPool: status.keyPool,
        agents: status.agents,
        history: Array.isArray(history) ? history : []
      }
      this.emit()
    } catch {
      /* main not ready yet — the view retries on next mount */
    }
  }

  /**
   * Wait for the current run to finish and return its answer, so a chat panel
   * can await `/agent` like a normal reply.
   */
  waitForAnswer(): Promise<{ answer: string; run: RunState | null }> {
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        const run = this.snapshot.run
        if (!run) return
        if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
          off()
          resolve({
            answer:
              run.answer ??
              (run.status === 'cancelled' ? 'Run cancelled.' : (run.error ?? 'The run failed.')),
            run
          })
        }
      })
    })
  }
}

export const orchestrator = new OrchestratorClient()
