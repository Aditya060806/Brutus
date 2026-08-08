/**
 * BRUTUS Studio — PTY manager
 * ----------------------------
 * Owns every real pseudo-terminal on the canvas. One session per agent window.
 *
 * Why a pty and not `child_process.spawn` (which `run-shell-command` uses):
 * Claude Code and Codex are full TUIs. They need a real terminal to render
 * into, they emit ANSI, and they expect resize events. A pipe gets you none of
 * that, which is why the existing shell handler cannot drive them.
 *
 * node-pty is built on node-addon-api (N-API), so its prebuilt binary is
 * ABI-stable across Node and Electron versions. Verified loading unmodified
 * under Electron 41 / Node 24 — no electron-rebuild step, and users need no
 * Visual Studio toolchain.
 *
 * The renderer never touches a pty. Output flows out over IPC into xterm.js;
 * keystrokes flow back in. Every session keeps a bounded scrollback ring so a
 * node that unmounts (pan, zoom, collapse, virtualisation) can replay its
 * history without re-running anything.
 */
import type { BrowserWindow } from 'electron'
import type { IPty } from 'node-pty'
import {
  SCROLLBACK_LIMIT_BYTES,
  type AgentKind,
  type PtySessionInfo,
  type SessionStatus,
  type StudioEvent
} from './types'

/**
 * Loaded lazily and defensively. A native module that fails to load must
 * degrade to "Studio unavailable" rather than taking the whole app down at
 * startup, since everything else in Brutus works fine without it.
 */
type PtyModule = typeof import('node-pty')
let ptyModule: PtyModule | null = null
let ptyLoadError: string | null = null

function loadPty(): PtyModule | null {
  if (ptyModule || ptyLoadError) return ptyModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require('node-pty') as PtyModule
  } catch (err) {
    ptyLoadError = String((err as { message?: string })?.message || err)
    console.error('[Studio] node-pty unavailable:', ptyLoadError)
  }
  return ptyModule
}

export function ptyAvailable(): { ok: boolean; error?: string } {
  const mod = loadPty()
  return mod ? { ok: true } : { ok: false, error: ptyLoadError ?? 'unknown' }
}

/**
 * Which status changes are possible.
 *
 * `exited` and `failed` are terminal: a dead process cannot become busy again,
 * and a session that reports otherwise is a bug somewhere upstream rather than
 * a state to honour. Everything else may move freely between the live states,
 * because a turn can end, an approval can interrupt it, and work can resume.
 */
/**
 * One queued write.
 *
 * `submit` distinguishes a prompt — which needs an Enter afterwards, sent as its
 * own keystroke — from a raw sequence that must go through untouched.
 */
interface PendingWrite {
  text: string
  submit: boolean
}

/**
 * Gap between typing a prompt and pressing Enter.
 *
 * Long enough that the CLI reads them as two separate input events, short
 * enough to be invisible. See `submit()` for why one write does not work.
 */
const SUBMIT_DELAY_MS = 120

/** Settling time after an agent reports idle, before Brutus types into it. */
const DRAIN_DELAY_MS = 120

const ALLOWED_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  starting: ['idle', 'busy', 'awaiting-approval', 'exited', 'failed'],
  idle: ['busy', 'awaiting-approval', 'exited', 'failed'],
  busy: ['idle', 'awaiting-approval', 'exited', 'failed'],
  'awaiting-approval': ['idle', 'busy', 'exited', 'failed'],
  exited: [],
  failed: []
}

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

/** Default shell per platform, used by the `shell` node kind. */
export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

interface Session {
  info: PtySessionInfo
  pty: IPty
  /** Bounded scrollback so replay is possible without unbounded memory. */
  scrollback: string
  /** Writes queued because the agent is mid-turn. */
  pending: PendingWrite[]
  disposed: boolean
}

export interface PtyManagerOpts {
  getWindow: () => BrowserWindow | null
}

export class PtyManager {
  private sessions = new Map<string, Session>()
  private seq = 0
  /** In-main listeners (the policy layer), separate from the renderer stream. */
  private dataHooks = new Set<(sessionId: string, chunk: string) => void>()
  private exitHooks = new Set<(sessionId: string, exitCode: number) => void>()
  private statusHooks = new Set<(sessionId: string, status: SessionStatus) => void>()
  constructor(private opts: PtyManagerOpts) {}

  /**
   * Observe output inside the main process. The prompt watcher needs the raw
   * stream, and routing it through the renderer and back would add a round
   * trip to something that must react within a few hundred milliseconds.
   */
  onData(fn: (sessionId: string, chunk: string) => void): () => void {
    this.dataHooks.add(fn)
    return () => this.dataHooks.delete(fn)
  }

  onExit(fn: (sessionId: string, exitCode: number) => void): () => void {
    this.exitHooks.add(fn)
    return () => this.exitHooks.delete(fn)
  }

  /**
   * Observe status transitions in the main process.
   *
   * The router's whole notion of "a turn ended" is a busy→idle transition, so
   * it needs these at the source rather than reconstructing them from the byte
   * stream a second time.
   */
  onStatus(fn: (sessionId: string, status: SessionStatus) => void): () => void {
    this.statusHooks.add(fn)
    return () => this.statusHooks.delete(fn)
  }

  private emit(event: StudioEvent): void {
    const win = this.opts.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('studio-event', event)
  }

  list(): PtySessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info)
  }

  get(id: string): PtySessionInfo | null {
    return this.sessions.get(id)?.info ?? null
  }

  scrollbackOf(id: string): string {
    return this.sessions.get(id)?.scrollback ?? ''
  }

  /**
   * Spawn a real terminal.
   *
   * `env` deliberately inherits the user's environment: that is what lets the
   * agent CLIs find their own credentials from a prior `claude login` /
   * `codex login`, which is the whole point of running the real binary.
   */
  spawn(opts: {
    kind: AgentKind
    file: string
    args: string[]
    cwd: string
    runMode: string
    cols?: number
    rows?: number
  }): PtySessionInfo {
    const mod = loadPty()
    if (!mod) throw new Error(`Terminal engine unavailable: ${ptyLoadError}`)

    const id = `pty_${Date.now()}_${++this.seq}`
    const cols = Math.max(20, opts.cols ?? 100)
    const rows = Math.max(5, opts.rows ?? 30)

    const term = mod.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: {
        ...process.env,
        // Agent CLIs render better when they know the terminal is capable.
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // Mark the session so a hook or shim can identify which node called it.
        BRUTUS_STUDIO_SESSION: id
      } as Record<string, string>
    })

    const info: PtySessionInfo = {
      id,
      kind: opts.kind,
      pid: term.pid ?? null,
      cwd: opts.cwd,
      runMode: opts.runMode,
      status: 'starting',
      startedAt: Date.now(),
      cols,
      rows
    }

    const session: Session = { info, pty: term, scrollback: '', pending: [], disposed: false }
    this.sessions.set(id, session)

    term.onData((chunk: string) => {
      session.scrollback += chunk
      if (session.scrollback.length > SCROLLBACK_LIMIT_BYTES) {
        // Trim from the front; the tail is what matters for replay and for
        // prompt detection.
        session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT_BYTES)
      }
      this.emit({ type: 'data', sessionId: id, chunk })
      // Never let one bad listener break the stream for the terminal.
      this.dataHooks.forEach((fn) => {
        try {
          fn(id, chunk)
        } catch (err) {
          console.error('[Studio] data hook threw:', err)
        }
      })
    })

    term.onExit(({ exitCode }) => {
      session.info.status = 'exited'
      session.info.exitCode = exitCode
      session.info.exitedAt = Date.now()
      session.disposed = true
      this.emit({ type: 'session-exit', sessionId: id, exitCode })
      this.exitHooks.forEach((fn) => {
        try {
          fn(id, exitCode)
        } catch (err) {
          console.error('[Studio] exit hook threw:', err)
        }
      })
    })

    this.emit({ type: 'session-started', session: { ...info } })
    return { ...info }
  }

  /** Type into the terminal exactly as a human would. */
  write(id: string, data: string): boolean {
    const s = this.sessions.get(id)
    if (!s || s.disposed) return false
    try {
      s.pty.write(data)
      return true
    } catch (err) {
      console.error(`[Studio] write to ${id} failed:`, err)
      return false
    }
  }

  /**
   * Type a prompt, then press Enter — as two separate keystrokes.
   *
   * ── WHY NOT ONE WRITE OF `text\r` ─────────────────────────────────────────
   * That is what this used to do, and it did not submit. Claude Code and Codex
   * are Ink applications: Ink hands its `useInput` handler whatever arrived in
   * one read of the pty as a SINGLE event. A write of `"do the thing\r"` is one
   * read, so the handler sees one keypress whose text happens to end in a
   * carriage return — and appends the lot to the input box instead of
   * submitting. The prompt then sits there, typed but never sent, waiting for a
   * human to press Enter. Which is exactly what it looked like.
   *
   * Written separately, the `\r` lands in its own read and therefore its own
   * input event, which every one of these CLIs reads as the Enter key.
   */
  submit(id: string, text: string): void {
    const s = this.sessions.get(id)
    if (!s || s.disposed) return
    if (s.info.status === 'idle') {
      this.deliver(id, { text, submit: true })
      return
    }
    s.pending.push({ text, submit: true })
  }

  /**
   * Queue a raw write until the agent is free.
   *
   * Typing into a CLI that is mid-turn corrupts its input buffer, so Brutus
   * never does it; the write lands the moment the adapter reports idle. Unlike
   * `submit`, whatever is passed here is sent verbatim — control characters
   * included — so it stays available for keystrokes that are not a prompt.
   */
  enqueue(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (!s || s.disposed) return
    if (s.info.status === 'idle') {
      this.write(id, data)
      return
    }
    s.pending.push({ text: data, submit: false })
  }

  /** Send one queued item, pressing Enter afterwards when it is a prompt. */
  private deliver(id: string, item: PendingWrite): void {
    if (!this.write(id, item.text)) return
    if (!item.submit) return
    // Unref'd: a pending Enter must never hold the process open at quit.
    const timer = setTimeout(() => this.write(id, '\r'), SUBMIT_DELAY_MS)
    timer.unref?.()
  }

  /**
   * Called by the adapter layer when a session's status changes.
   *
   * Transitions are checked rather than assumed. Statuses arrive from three
   * independent places — the prompt watcher, the policy layer and the pty's own
   * exit — and nothing coordinated them, so a late `busy` from a settling
   * watcher could resurrect a session that had already exited. A resurrected
   * session looks alive to the router, which would then queue a handoff into a
   * terminal that no longer exists.
   *
   * Invalid transitions are dropped and logged rather than thrown: a status
   * update is advisory, and crashing the manager over one would be a worse
   * outcome than ignoring it.
   */
  setStatus(id: string, status: SessionStatus): void {
    const s = this.sessions.get(id)
    if (!s || s.info.status === status) return

    if (!canTransition(s.info.status, status)) {
      console.warn(`[Studio] ignored ${s.info.status} → ${status} for ${id}`)
      return
    }

    s.info.status = status
    this.emit({ type: 'status', sessionId: id, status })
    this.statusHooks.forEach((fn) => {
      try {
        fn(id, status)
      } catch (err) {
        console.error('[Studio] status hook threw:', err)
      }
    })

    // Drain anything Brutus queued while the agent was busy.
    if (status === 'idle' && s.pending.length) {
      const next = s.pending.shift()!
      const timer = setTimeout(() => this.deliver(id, next), DRAIN_DELAY_MS)
      timer.unref?.()
    }
  }

  setAgentSessionId(id: string, agentSessionId: string): void {
    const s = this.sessions.get(id)
    if (s) s.info.agentSessionId = agentSessionId
  }

  /** Resize so the CLI's TUI reflows. Debounced by the caller. */
  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s || s.disposed) return
    const c = Math.max(20, Math.floor(cols))
    const r = Math.max(5, Math.floor(rows))
    if (s.info.cols === c && s.info.rows === r) return
    try {
      s.pty.resize(c, r)
      s.info.cols = c
      s.info.rows = r
    } catch (err) {
      console.warn(`[Studio] resize ${id} failed:`, err)
    }
  }

  /**
   * Kill a session.
   *
   * The spike surfaced a real teardown hazard: on Windows, node-pty's
   * conpty_console_list helper throws `AttachConsole failed` when the host has
   * no attached console, and that surfaces as an uncaught error on close.
   * Killing inside try/catch and marking the session disposed first keeps that
   * from ever reaching the user as a crash.
   */
  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.disposed = true
    s.pending = []
    try {
      s.pty.kill()
    } catch (err) {
      console.warn(`[Studio] kill ${id}:`, err)
    }
    this.sessions.delete(id)
  }

  /** Called on app quit so no orphaned agent process survives the window. */
  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.kill(id)
  }
}
