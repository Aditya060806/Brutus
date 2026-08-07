import type { TelemetryEvent } from './telemetry'

/**
 * BRUTUS Studio — shared types
 * -----------------------------
 * The canvas where real coding-agent CLIs run as live terminals in draggable
 * windows, wired together with visible strings, with Brutus opening them,
 * typing into them, answering their permission prompts, and routing one
 * agent's output into the next.
 *
 * Deliberately NOT MCP: each window is a real pseudo-terminal running the real
 * binary, so the user's existing Claude Max / ChatGPT subscription is what
 * pays for the work.
 */

// ─── Agents ─────────────────────────────────────────────────────────────────

/** Extensible: adding a kind means adding one adapter file. */
export type AgentKind = 'claude' | 'codex' | 'gemini' | 'shell'

/** How an agent session is being driven. */
export type SessionMode =
  /** Visible interactive TUI the human can watch and take over. */
  | 'interactive'
  /** Headless turn emitting structured events, for orchestrated runs. */
  | 'headless'

export type SessionStatus =
  | 'starting'
  | 'idle' // alive, waiting for input — safe for Brutus to type into
  | 'busy' // mid-turn — writes must queue
  | 'awaiting-approval' // blocked on a permission decision
  | 'exited'
  | 'failed'

/** A run mode offered by an adapter, surfaced in the node's setup card. */
export interface RunMode {
  id: string
  label: string
  blurb: string
  /** Renders in red and warns; never selected by default. */
  danger?: boolean
}

export interface SpawnOptions {
  kind: AgentKind
  cwd: string
  /** RunMode.id chosen in the setup card. */
  runMode: string
  cols: number
  rows: number
  /** Resume a prior CLI session where the adapter supports it. */
  resumeId?: string
}

// ─── PTY sessions ───────────────────────────────────────────────────────────

export interface PtySessionInfo {
  id: string
  kind: AgentKind
  pid: number | null
  cwd: string
  runMode: string
  status: SessionStatus
  /** The CLI's own session id, when it reports one (enables --resume). */
  agentSessionId?: string
  startedAt: number
  exitedAt?: number
  exitCode?: number
  cols: number
  rows: number
}

/**
 * Structured event decoded from an agent's output stream.
 * Adapters that expose JSON (Claude Code, Codex) produce these precisely;
 * pattern-based adapters produce a coarser subset.
 */
export interface AgentEvent {
  type:
    | 'session' // carries agentSessionId
    | 'assistant-text'
    | 'tool-use'
    | 'turn-complete'
    | 'error'
  text?: string
  toolName?: string
  agentSessionId?: string
  /** Raw line, kept for debugging in the activity log. */
  raw?: string
}

// ─── Canvas graph ───────────────────────────────────────────────────────────

export type NodeKind = 'agent' | 'shell' | 'note' | 'preview'

export interface StudioNode {
  id: string
  kind: NodeKind
  agentKind?: AgentKind
  /** Display name — "Apollo", "Atlas", "Orion". */
  title: string
  x: number
  y: number
  width: number
  height: number
  cwd?: string
  runMode?: string
  /** Free text for note nodes. */
  text?: string
  collapsed?: boolean
  /** Auto-reply to connected agents (per-node toggle in the footer). */
  autoReply?: boolean
  /**
   * Preview nodes only: the dev server this window is pointed at.
   *
   * Persisted so a workspace reopened later still shows the frontend beside the
   * agent that built it. The URL is re-validated as loopback on the way back in
   * (see `isPreviewUrl`) — a saved file is untrusted input like any other, and
   * this one ends up in a live frame.
   */
  previewUrl?: string
  /** Preview nodes only: the agent node whose server this is. */
  sourceNodeId?: string
}

/**
 * Is this a URL a preview window may load?
 *
 * Mirrors `dev-server.ts`'s loopback rule, and exists separately because that
 * check runs on freshly detected output while this one runs on anything a saved
 * or imported workspace claims. Both paths end in an iframe, so both need it.
 */
export function isPreviewUrl(raw: unknown): raw is string {
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

/**
 * An edge is real data flow, not decoration.
 *   handoff — upstream's finished output becomes downstream's next prompt
 *   branch  — same output fanned out to several downstreams
 *   loop    — feeds back upstream, e.g. "revise until green"
 */
export type EdgeKind = 'handoff' | 'branch' | 'loop'

export interface StudioEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  kind: EdgeKind
  /** Shown on the curve, e.g. "revise until green". */
  label?: string
  /** Loop safety: hard ceiling on how many times this edge may fire. */
  maxIterations?: number
  iterations?: number
}

export interface StudioWorkspace {
  id: string
  name: string
  /** Root folder agents open in by default. */
  rootDir: string
  nodes: StudioNode[]
  edges: StudioEdge[]
  backdrop: string
  viewport: { x: number; y: number; zoom: number }
  createdAt?: number
  updatedAt: number
}

// ─── Policy ─────────────────────────────────────────────────────────────────

/** Mirrors Claude Code's hook vocabulary so the mapping stays one-to-one. */
export type PolicyDecision = 'allow' | 'deny' | 'ask' | 'defer'

export interface PolicyRequest {
  sessionId: string
  nodeId?: string
  toolName: string
  toolInput: Record<string, unknown>
  cwd: string
  /** Present for Claude Code's hook; absent on the pattern track. */
  agentSessionId?: string
}

export interface PolicyResult {
  decision: PolicyDecision
  reason: string
  /** Rewrite the command before it runs (hook supports this). */
  updatedInput?: Record<string, unknown>
}

/** A prompt Brutus could not decide, raised to the canvas for the human. */
export interface StudioApproval {
  id: string
  nodeId: string
  sessionId: string
  toolName: string
  summary: string
  detail: Record<string, unknown>
  createdAt: number
  /** Pattern track only: the keys to write for yes / no. */
  answerKeys?: { yes: string; no: string }
}

// ─── Events to the renderer ─────────────────────────────────────────────────

export type StudioEvent =
  | { type: 'session-started'; session: PtySessionInfo }
  | { type: 'data'; sessionId: string; chunk: string }
  | { type: 'status'; sessionId: string; status: SessionStatus }
  | { type: 'agent-event'; sessionId: string; event: AgentEvent }
  | { type: 'session-exit'; sessionId: string; exitCode: number }
  | { type: 'approval-required'; approval: StudioApproval }
  | { type: 'approval-resolved'; approvalId: string; granted: boolean }
  | { type: 'routed'; edgeId: string; from: string; to: string; preview: string }
  /** An agent announced a dev server; the canvas opens a preview window on it. */
  | { type: 'preview-detected'; sessionId: string; nodeId: string; url: string; port: number }
  | { type: 'log'; line: string }
  | { type: 'telemetry'; event: TelemetryEvent }

/** Scrollback kept per session so a re-mounting node can replay without re-running. */
export const SCROLLBACK_LIMIT_BYTES = 256 * 1024
