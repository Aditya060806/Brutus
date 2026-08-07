/**
 * BRUTUS Studio — renderer client
 * --------------------------------
 * Thin mirror of the pty sessions living in the main process. Terminals are
 * rendered here with xterm.js, but nothing about the process lifecycle lives
 * here: the renderer only sends keystrokes and receives bytes.
 *
 * Data fan-out is per-session rather than a single global snapshot, because a
 * terminal receives thousands of small chunks and re-rendering the whole
 * canvas for each one would be hopeless. Components subscribe to just their
 * own session's stream.
 */

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'shell'

export type SessionStatus = 'starting' | 'idle' | 'busy' | 'awaiting-approval' | 'exited' | 'failed'

export interface PtySessionInfo {
  id: string
  kind: AgentKind
  pid: number | null
  cwd: string
  runMode: string
  status: SessionStatus
  agentSessionId?: string
  startedAt: number
  exitedAt?: number
  exitCode?: number
  cols: number
  rows: number
  /**
   * The canvas node this terminal belongs to.
   *
   * Set at spawn and reported back by `studio-sessions`, which is what makes
   * reattaching a reopened workspace to its still-running agents possible.
   */
  nodeId?: string
}

export interface RunMode {
  id: string
  label: string
  blurb: string
  danger?: boolean
}

/** What the picker renders: every adapter, with missing binaries greyed out. */
export interface AgentInfo {
  kind: AgentKind
  label: string
  accent: string
  bin: string
  install: string
  path: string | null
  available: boolean
  runModes: RunMode[]
  defaultRunMode: string
  models: { id: string; label: string }[]
  signedIn: boolean
}

export interface StudioNode {
  id: string
  kind: 'agent' | 'shell' | 'note' | 'preview'
  agentKind?: AgentKind
  title: string
  x: number
  y: number
  width: number
  height: number
  cwd?: string
  runMode?: string
  text?: string
  collapsed?: boolean
  autoReply?: boolean
  /** Preview nodes only: the dev server this window shows. */
  previewUrl?: string
  /** Preview nodes only: the agent node whose server this is. */
  sourceNodeId?: string
}

export type EdgeKind = 'handoff' | 'branch' | 'loop'

export interface StudioEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  kind: EdgeKind
  label?: string
  maxIterations?: number
}

export interface StudioWorkspace {
  id: string
  name: string
  rootDir: string
  nodes: StudioNode[]
  edges: StudioEdge[]
  backdrop: string
  viewport: { x: number; y: number; zoom: number }
  createdAt?: number
  updatedAt: number
}

/** One thing the canvas dock can place. */
export interface DockItem {
  id: string
  label: string
  node: 'agent' | 'note'
  agentKind?: string
  accent: string
  available: boolean
  install?: string
}

export interface DockState {
  onDock: DockItem[]
  available: DockItem[]
  catalogue: DockItem[]
  /** Default scenery for new workspaces. */
  backdrop: string
  defaultAgent: string
  models: Record<string, string>
  worktrees: boolean
  autoMerge: boolean
  shareContext: boolean
  skipPermissions: boolean
}

export type StudioConfigPatch = Partial<Omit<DockState, 'onDock' | 'available' | 'catalogue'>> & {
  onDock?: string[]
}

/** What the health panel reads. Counters and existing state only — no probing. */
export interface StudioHealth {
  engine: { ok: boolean; error?: string }
  sessions: {
    total: number
    byStatus: Record<string, number>
    hooked: number
    isolated: number
  }
  policy: {
    serverRunning: boolean
    port: number | null
    autonomy: Autonomy
    awaitingHuman: number
  }
  git: { reposBusy: number }
  /** The live Dashboard mission's counters, or null when none is running. */
  mission: { total: number; done: number; running: number; failed: number; blocked: number } | null
  metrics: MetricsSnapshot
  projects: number
  spawning: number
  agents: { kind: string; available: boolean; signedIn: boolean }[]
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** One structured record from the main process. */
export interface TelemetryEvent {
  seq: number
  ts: number
  level: LogLevel
  scope: string
  event: string
  message: string
  fields?: Record<string, unknown>
  traceId?: string
  spanId?: string
  durationMs?: number
}

export interface Histogram {
  count: number
  totalMs: number
  minMs: number
  maxMs: number
  avgMs: number
}

export interface MetricsSnapshot {
  counters: Record<string, number>
  durations: Record<string, Histogram>
}

/** A worktree Brutus left behind, for the Reclaim list. */
export interface OrphanedWorktree {
  repo: string
  dir: string
  branch: string
  /** Commits on this branch not present on the branch it was cut from. */
  unmerged: number
  ageMs: number
  /** The directory is gone but git still lists the worktree. */
  missing: boolean
}

/** What the launcher lists, without loading every graph. */
export interface WorkspaceSummary {
  id: string
  name: string
  rootDir: string
  backdrop: string
  nodeCount: number
  edgeCount: number
  kinds: string[]
  createdAt: number
  updatedAt: number
}

export interface StudioApproval {
  id: string
  nodeId: string
  sessionId: string
  toolName: string
  summary: string
  detail: Record<string, unknown>
  createdAt: number
  answerKeys?: { yes: string; no: string }
}

export type Autonomy = 'guarded' | 'strict' | 'autonomous'

/** One agent's output, reframed and delivered into the next. */
export interface RoutedEvent {
  edgeId: string
  from: string
  to: string
  preview: string
}

/**
 * A canvas edit proposed by the command bar.
 *
 * `ref` on an add-node is a handle the same batch can connect to before the
 * node has a real id; the renderer resolves it as it applies each op in order.
 */
export type CanvasMutation =
  | { op: 'add-node'; ref: string; agentKind: AgentKind; title: string; runMode?: string }
  | {
      op: 'connect'
      from: string
      to: string
      kind: EdgeKind
      label?: string
      maxIterations?: number
    }
  | { op: 'prompt'; target: string; text: string }
  | { op: 'remove-node'; target: string }

// ── Dashboard mission ───────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked'
export type MissionStatus = 'planned' | 'running' | 'done' | 'failed' | 'aborted'

export interface MissionStep {
  ref: string
  agentKind: AgentKind
  title: string
  role: string
  brief: string
  dependsOn: string | null
}

export interface MissionPlan {
  id: string
  task: string
  summary: string
  steps: MissionStep[]
}

export interface MissionStepState extends MissionStep {
  status: StepStatus
  nodeId?: string
  startedAt?: number
  finishedAt?: number
  output?: string
  note?: string
}

export interface MissionState {
  id: string
  task: string
  summary: string
  status: MissionStatus
  startedAt: number
  finishedAt?: number
  lastProgressAt: number
  stalled: boolean
  steps: MissionStepState[]
  totals: { total: number; done: number; running: number; failed: number; blocked: number }
}

/** The wiring a plan implies, derived in main from the dependency list. */
export interface MissionEdge {
  from: string
  to: string
  label: string
}

const EMPTY_DOCK: DockState = {
  onDock: [],
  available: [],
  catalogue: [],
  backdrop: 'ember',
  defaultAgent: 'claude',
  models: {},
  worktrees: false,
  autoMerge: false,
  shareContext: true,
  skipPermissions: false
}

/**
 * May a preview window load this URL?
 *
 * Mirrors the loopback rule in main's dev-server detector. It is repeated on the
 * renderer side because this also guards URLs coming back out of a saved or
 * imported workspace file, which main's detector never saw. Both paths end in a
 * live iframe, so both are checked.
 */
export function isLoopbackUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw) return false
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const h = u.hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h === '0.0.0.0'
  } catch {
    return false
  }
}

/** An agent announced a dev server; the canvas opens a window on it. */
export interface PreviewEvent {
  sessionId: string
  /** The agent node that started it, so the window can be placed beside it. */
  nodeId: string
  url: string
  port: number
}

type DataListener = (chunk: string) => void
type StatusListener = (status: SessionStatus, exitCode?: number) => void
type ApprovalListener = (approval: StudioApproval | null) => void
type RoutedListener = (event: RoutedEvent) => void
type PreviewListener = (event: PreviewEvent) => void

class StudioClient {
  private dataListeners = new Map<string, Set<DataListener>>()
  private statusListeners = new Map<string, Set<StatusListener>>()
  private sessions = new Map<string, PtySessionInfo>()
  private logListeners = new Set<(line: string) => void>()
  private approvalListeners = new Set<ApprovalListener>()
  private routedListeners = new Set<RoutedListener>()
  private previewListeners = new Set<PreviewListener>()
  private telemetryListeners = new Set<(event: TelemetryEvent) => void>()
  /**
   * The last preview seen per agent node.
   *
   * Replayed to a late subscriber, because the canvas subscribes after mount
   * while a dev server may have been announced before that — without this, a
   * server started during boot would be silently missed and the window would
   * never appear.
   */
  private lastPreviews = new Map<string, PreviewEvent>()
  /** Queued because several agents can ask at once; shown one at a time. */
  private approvalQueue: StudioApproval[] = []

  constructor() {
    window.electron?.ipcRenderer?.on('studio-event', (_e: unknown, ev: StudioEventPayload) => {
      switch (ev?.type) {
        case 'session-started':
          if (ev.session) this.sessions.set(ev.session.id, ev.session)
          break
        case 'data':
          if (ev.sessionId && typeof ev.chunk === 'string') {
            this.dataListeners.get(ev.sessionId)?.forEach((l) => l(ev.chunk as string))
          }
          break
        case 'status': {
          if (!ev.sessionId || !ev.status) break
          const s = this.sessions.get(ev.sessionId)
          if (s) s.status = ev.status
          this.statusListeners.get(ev.sessionId)?.forEach((l) => l(ev.status as SessionStatus))
          break
        }
        case 'session-exit': {
          if (!ev.sessionId) break
          const s = this.sessions.get(ev.sessionId)
          if (s) {
            s.status = 'exited'
            s.exitCode = ev.exitCode
          }
          this.statusListeners.get(ev.sessionId)?.forEach((l) => l('exited', ev.exitCode))
          break
        }
        case 'approval-required':
          if (ev.approval) {
            this.approvalQueue.push(ev.approval)
            this.emitApproval()
          }
          break
        case 'approval-resolved':
          this.approvalQueue = this.approvalQueue.filter((a) => a.id !== ev.approvalId)
          this.emitApproval()
          break
        case 'routed':
          if (ev.edgeId) {
            const routed: RoutedEvent = {
              edgeId: ev.edgeId,
              from: ev.from ?? '',
              to: ev.to ?? '',
              preview: ev.preview ?? ''
            }
            this.routedListeners.forEach((l) => l(routed))
          }
          break
        case 'preview-detected': {
          if (!ev.url || !ev.nodeId) break
          const preview: PreviewEvent = {
            sessionId: ev.sessionId ?? '',
            nodeId: ev.nodeId,
            url: ev.url,
            port: ev.port ?? 0
          }
          this.lastPreviews.set(preview.nodeId, preview)
          this.previewListeners.forEach((l) => l(preview))
          break
        }
        case 'telemetry':
          if (ev.event) {
            const te = ev.event as TelemetryEvent
            this.telemetryListeners.forEach((l) => l(te))
          }
          break
        case 'log':
          if (ev.line) this.logListeners.forEach((l) => l(ev.line as string))
          break
        default:
          break
      }
    })
  }

  private emitApproval(): void {
    const current = this.approvalQueue[0] ?? null
    this.approvalListeners.forEach((l) => l(current))
  }

  /** The approval currently awaiting an answer, or null. */
  onApproval(l: ApprovalListener): () => void {
    this.approvalListeners.add(l)
    l(this.approvalQueue[0] ?? null)
    return () => this.approvalListeners.delete(l)
  }

  async approve(approvalId: string, granted: boolean): Promise<void> {
    await window.electron.ipcRenderer.invoke('studio-approve', { approvalId, granted })
    // Drop it locally too, so the card clears even if the event races.
    this.approvalQueue = this.approvalQueue.filter((a) => a.id !== approvalId)
    this.emitApproval()
  }

  async autonomy(next?: Autonomy): Promise<Autonomy> {
    const res = (await window.electron.ipcRenderer.invoke('studio-autonomy', {
      autonomy: next
    })) as { autonomy?: Autonomy }
    return res?.autonomy ?? 'guarded'
  }

  /** Subscribe to one session's byte stream. */
  onData(sessionId: string, l: DataListener): () => void {
    if (!this.dataListeners.has(sessionId)) this.dataListeners.set(sessionId, new Set())
    this.dataListeners.get(sessionId)!.add(l)
    return () => this.dataListeners.get(sessionId)?.delete(l)
  }

  onStatus(sessionId: string, l: StatusListener): () => void {
    if (!this.statusListeners.has(sessionId)) this.statusListeners.set(sessionId, new Set())
    this.statusListeners.get(sessionId)!.add(l)
    return () => this.statusListeners.get(sessionId)?.delete(l)
  }

  onLog(l: (line: string) => void): () => void {
    this.logListeners.add(l)
    return () => this.logListeners.delete(l)
  }

  async available(): Promise<{ ok: boolean; error?: string; defaultShell?: string }> {
    return (await window.electron.ipcRenderer.invoke('studio-available')) as {
      ok: boolean
      error?: string
      defaultShell?: string
    }
  }

  /** Fires each time Brutus routes one agent's output into another. */
  onRouted(l: RoutedListener): () => void {
    this.routedListeners.add(l)
    return () => this.routedListeners.delete(l)
  }

  /**
   * Fires when an agent starts a dev server.
   *
   * Anything already detected is replayed immediately on subscribe, so a canvas
   * that mounts after the server came up still opens its window.
   */
  onPreview(l: PreviewListener): () => void {
    this.previewListeners.add(l)
    this.lastPreviews.forEach((p) => l(p))
    return () => this.previewListeners.delete(l)
  }

  /** Forget a node's remembered preview, so closing the window makes it stay closed. */
  forgetPreview(nodeId: string): void {
    this.lastPreviews.delete(nodeId)
  }

  /**
   * Every pty still alive in main.
   *
   * This is what lets a canvas reattach after it was unmounted: the processes
   * outlive the view, and each one remembers the canvas node it belongs to.
   */
  async listSessions(): Promise<PtySessionInfo[]> {
    const res = (await window.electron.ipcRenderer.invoke('studio-sessions')) as {
      sessions?: (PtySessionInfo & { nodeId?: string })[]
    }
    const list = res?.sessions ?? []
    for (const s of list) this.sessions.set(s.id, s)
    return list
  }

  /** Stop every agent and every routing chain. The deliberate way to end a run. */
  async stopAll(): Promise<number> {
    const res = (await window.electron.ipcRenderer.invoke('studio-stop-all')) as {
      stopped?: number
    }
    this.lastPreviews.clear()
    return res?.stopped ?? 0
  }

  /**
   * Push the graph to main.
   *
   * The renderer owns layout; main only needs the wiring, so routing can run
   * entirely in the main process without a round trip per handoff.
   */
  syncGraph(graph: { nodes: StudioNode[]; edges: StudioEdge[]; autoRoute: boolean }): void {
    void window.electron.ipcRenderer.invoke('studio-graph', graph)
  }

  /** The command bar: English in, proposed canvas edits out. */
  async command(
    instruction: string
  ): Promise<{ ok: boolean; mutations?: CanvasMutation[]; skipped?: string[]; error?: string }> {
    return (await window.electron.ipcRenderer.invoke('studio-command', { instruction })) as {
      ok: boolean
      mutations?: CanvasMutation[]
      skipped?: string[]
      error?: string
    }
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  /**
   * Turn one request into a crew. Plans only — nothing spawns until `startMission`.
   */
  async planMission(task: string): Promise<{
    ok: boolean
    plan?: MissionPlan
    edges?: MissionEdge[]
    skipped?: string[]
    error?: string
  }> {
    return (await window.electron.ipcRenderer.invoke('studio-mission-plan', { task })) as {
      ok: boolean
      plan?: MissionPlan
      edges?: MissionEdge[]
      skipped?: string[]
      error?: string
    }
  }

  /**
   * Hand main the plan and the canvas nodes that now stand for each step.
   *
   * Briefs are typed by main, not here: `enqueue` waits for the CLI to report
   * idle, and a freshly spawned agent takes seconds to get there.
   */
  async startMission(
    plan: MissionPlan,
    bindings: { ref: string; nodeId: string }[]
  ): Promise<{ ok: boolean; mission?: MissionState; error?: string }> {
    return (await window.electron.ipcRenderer.invoke('studio-mission-start', {
      plan,
      bindings
    })) as { ok: boolean; mission?: MissionState; error?: string }
  }

  async missionState(): Promise<MissionState | null> {
    const res = (await window.electron.ipcRenderer.invoke('studio-mission-state')) as {
      mission?: MissionState | null
    }
    return res?.mission ?? null
  }

  async abortMission(): Promise<MissionState | null> {
    const res = (await window.electron.ipcRenderer.invoke('studio-mission-abort')) as {
      mission?: MissionState | null
    }
    return res?.mission ?? null
  }

  async spawn(opts: {
    kind?: AgentKind
    file?: string
    args?: string[]
    cwd?: string
    runMode?: string
    cols?: number
    rows?: number
    nodeId?: string
  }): Promise<{ ok: boolean; session?: PtySessionInfo; error?: string }> {
    const res = (await window.electron.ipcRenderer.invoke('studio-spawn', opts)) as {
      ok: boolean
      session?: PtySessionInfo
      error?: string
    }
    if (res.ok && res.session) this.sessions.set(res.session.id, res.session)
    return res
  }

  write(id: string, data: string): void {
    void window.electron.ipcRenderer.invoke('studio-write', { id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    void window.electron.ipcRenderer.invoke('studio-resize', { id, cols, rows })
  }

  kill(id: string): void {
    void window.electron.ipcRenderer.invoke('studio-kill', { id })
  }

  /** Replay history into a terminal that just mounted. */
  async scrollback(id: string): Promise<string> {
    const res = (await window.electron.ipcRenderer.invoke('studio-scrollback', { id })) as {
      data?: string
    }
    return res?.data ?? ''
  }

  async pickFolder(): Promise<string | null> {
    const res = (await window.electron.ipcRenderer.invoke('studio-pick-folder')) as {
      ok: boolean
      path?: string
    }
    return res?.ok ? (res.path ?? null) : null
  }

  session(id: string): PtySessionInfo | null {
    return this.sessions.get(id) ?? null
  }

  /** Adapter roster with live binary detection. */
  async agents(refresh = false): Promise<AgentInfo[]> {
    const res = (await window.electron.ipcRenderer.invoke('studio-agents', { refresh })) as {
      agents?: AgentInfo[]
    }
    return res?.agents ?? []
  }

  /** A cheap, side-effect-free snapshot of everything that could be wrong. */
  async health(): Promise<StudioHealth | null> {
    const res = (await window.electron.ipcRenderer.invoke('studio-health')) as {
      health?: StudioHealth
    }
    return res?.health ?? null
  }

  /** Live structured events, for the Activity panel. */
  onTelemetry(l: (event: TelemetryEvent) => void): () => void {
    this.telemetryListeners.add(l)
    return () => this.telemetryListeners.delete(l)
  }

  /**
   * Backfill what happened before the panel opened.
   *
   * `since` makes it incremental, so reopening the panel does not re-transfer
   * the whole ring buffer.
   */
  async activity(since = 0): Promise<{ events: TelemetryEvent[]; metrics: MetricsSnapshot }> {
    const res = (await window.electron.ipcRenderer.invoke('studio-activity', { since })) as {
      events?: TelemetryEvent[]
      metrics?: MetricsSnapshot
    }
    return {
      events: res?.events ?? [],
      metrics: res?.metrics ?? { counters: {}, durations: {} }
    }
  }

  async clearActivity(): Promise<void> {
    await window.electron.ipcRenderer.invoke('studio-activity-clear')
  }

  /** Worktrees Brutus left behind. Read-only; nothing is touched by listing. */
  async orphans(): Promise<OrphanedWorktree[]> {
    const res = (await window.electron.ipcRenderer.invoke('studio-orphans')) as {
      orphans?: OrphanedWorktree[]
    }
    return res?.orphans ?? []
  }

  /** Merge or remove one orphan. Never called except from an explicit click. */
  async orphanAction(
    o: OrphanedWorktree,
    action: 'merge' | 'remove'
  ): Promise<{ ok: boolean; error?: string }> {
    return (await window.electron.ipcRenderer.invoke('studio-orphan-action', {
      repo: o.repo,
      dir: o.dir,
      branch: o.branch,
      action
    })) as { ok: boolean; error?: string }
  }

  /** Stop every routing chain — used when the canvas unmounts. */
  cancelRouting(): void {
    void window.electron.ipcRenderer.invoke('studio-cancel-routing')
  }

  // ── Dock ──────────────────────────────────────────────────────────────────

  async getDock(): Promise<DockState> {
    const res = (await window.electron.ipcRenderer.invoke('studio-dock-get')) as {
      dock?: DockState
    }
    return res?.dock ?? EMPTY_DOCK
  }

  async setDock(patch: StudioConfigPatch): Promise<DockState> {
    const res = (await window.electron.ipcRenderer.invoke('studio-dock-set', patch)) as {
      dock?: DockState
    }
    return res?.dock ?? EMPTY_DOCK
  }

  async resetDock(): Promise<DockState> {
    const res = (await window.electron.ipcRenderer.invoke('studio-dock-reset')) as {
      dock?: DockState
    }
    return res?.dock ?? EMPTY_DOCK
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const res = (await window.electron.ipcRenderer.invoke('studio-workspace-list')) as {
      workspaces?: WorkspaceSummary[]
    }
    return res?.workspaces ?? []
  }

  async openWorkspace(id: string): Promise<StudioWorkspace | null> {
    const res = (await window.electron.ipcRenderer.invoke('studio-workspace-open', { id })) as {
      workspace?: StudioWorkspace
    }
    return res?.workspace ?? null
  }

  async createWorkspace(over: Partial<StudioWorkspace>): Promise<StudioWorkspace | null> {
    const res = (await window.electron.ipcRenderer.invoke('studio-workspace-create', over)) as {
      workspace?: StudioWorkspace
    }
    return res?.workspace ?? null
  }

  async saveWorkspace(ws: Partial<StudioWorkspace>): Promise<void> {
    await window.electron.ipcRenderer.invoke('studio-workspace-save', ws)
  }

  async deleteWorkspace(id: string): Promise<void> {
    await window.electron.ipcRenderer.invoke('studio-workspace-delete', { id })
  }

  async exportWorkspace(id: string): Promise<string | null> {
    const res = (await window.electron.ipcRenderer.invoke('studio-workspace-export', { id })) as {
      data?: string
    }
    return res?.data ?? null
  }

  async importWorkspace(payload: string): Promise<{ ok: boolean; error?: string }> {
    return (await window.electron.ipcRenderer.invoke('studio-workspace-import', { payload })) as {
      ok: boolean
      error?: string
    }
  }

  /** Clone a repository and return the folder it landed in. */
  async cloneRepo(
    url: string,
    parentDir: string
  ): Promise<{ ok: boolean; path?: string; name?: string; error?: string }> {
    return (await window.electron.ipcRenderer.invoke('studio-clone-repo', { url, parentDir })) as {
      ok: boolean
      path?: string
      name?: string
      error?: string
    }
  }
}

interface StudioEventPayload {
  type?: string
  session?: PtySessionInfo
  sessionId?: string
  chunk?: string
  status?: SessionStatus
  exitCode?: number
  line?: string
  approval?: StudioApproval
  approvalId?: string
  edgeId?: string
  from?: string
  to?: string
  preview?: string
  event?: TelemetryEvent | unknown
  /** `preview-detected`: the agent node that started the server. */
  nodeId?: string
  /** `preview-detected`: the loopback URL it announced. */
  url?: string
  /** `preview-detected`: the port, for the window's subtitle. */
  port?: number
}

export const studio = new StudioClient()
