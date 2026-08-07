import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { studio } from '@renderer/services/studio-client'

/**
 * One xterm per pty session, owned for the session's lifetime.
 *
 * ── WHY A POOL AND NOT ONE PER MOUNT ───────────────────────────────────────
 * Disposing an xterm is not safe against its own scheduled work. `Viewport`
 * queues a refresh on an animation frame and — confirmed in xterm 5.3's source
 * — only cancels it inside `_refresh(immediate)`, never in `dispose()`. Worse,
 * the queued callback is often `syncScrollArea`, which *queues another frame*
 * for `_innerRefresh`. So a disposed terminal can reach forward two frames and
 * then dereference a torn-down renderer:
 *
 *   Cannot read properties of undefined (reading 'dimensions')
 *     at get dimensions        // this._renderer.value is gone
 *     at Viewport._innerRefresh
 *
 * Deferring disposal by a frame does not win that race, and no fixed delay
 * truly can. Two things made it constant rather than occasional: virtualisation
 * unmounts terminals on every pan, and React StrictMode mounts-unmounts-remounts
 * every component in development.
 *
 * So the terminal is never disposed on unmount. Each session's terminal is
 * opened once into a div this module owns, and that div is moved in and out of
 * whichever React container is showing it. Culling a node detaches the element
 * — the browser stops painting it, which was the expensive part — while the
 * Terminal object stays intact and keeps consuming its stream.
 *
 * The trade is honest: memory is one terminal per *live session* rather than
 * per *visible node*. In exchange the crash is gone by construction, scrolling
 * back to a node is instant with its history already there, and StrictMode's
 * double-mount costs nothing.
 */

interface Entry {
  term: Terminal
  fit: FitAddon
  /** Owned by this module; moved between React containers. */
  host: HTMLDivElement
  offData: (() => void) | null
  disposed: boolean
}

const pool = new Map<string, Entry>()

const THEME = {
  background: '#09090b',
  foreground: '#d4d4d8',
  cursor: '#ef4444',
  cursorAccent: '#09090b',
  selectionBackground: 'rgba(239,68,68,0.25)',
  black: '#18181b',
  red: '#ef4444',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#6ee7b7',
  brightYellow: '#fcd34d',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa'
}

function create(sessionId: string): Entry {
  const host = document.createElement('div')
  host.style.width = '100%'
  host.style.height = '100%'
  host.style.overflow = 'hidden'

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: '"Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.25,
    letterSpacing: 0,
    scrollback: 5000,
    allowProposedApi: true,
    theme: THEME
  })

  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)

  const entry: Entry = { term, fit, host, offData: null, disposed: false }

  // ── Frame-batched writes ──────────────────────────────────────────────────
  // A pty emits many tiny chunks; writing per chunk thrashes the renderer.
  let queue = ''
  let raf = 0
  const flush = (): void => {
    raf = 0
    if (!queue || entry.disposed) return
    term.write(queue)
    queue = ''
  }
  const push = (chunk: string): void => {
    queue += chunk
    if (!raf) raf = requestAnimationFrame(flush)
  }

  // Replay history once, then follow the live stream for the rest of the
  // session. Because the terminal outlives any single mount, this happens
  // exactly once — re-entering a culled node needs no replay at all.
  void studio.scrollback(sessionId).then((history) => {
    if (entry.disposed) return
    if (history) term.write(history)
    entry.offData = studio.onData(sessionId, push)
  })

  term.onData((d) => studio.write(sessionId, d))

  pool.set(sessionId, entry)
  return entry
}

/**
 * Show this session's terminal inside `container`.
 *
 * Creates the terminal on first use. Safe to call repeatedly.
 */
export function attachTerminal(sessionId: string, container: HTMLElement): Entry {
  const entry = pool.get(sessionId) ?? create(sessionId)
  if (entry.host.parentElement !== container) container.appendChild(entry.host)
  return entry
}

/**
 * Take the terminal off-screen without destroying it.
 *
 * A detached element is not painted, so this recovers the cost that matters
 * while leaving the session's scrollback, selection and scroll position exactly
 * where the user left them.
 */
export function detachTerminal(sessionId: string): void {
  const entry = pool.get(sessionId)
  entry?.host.remove()
}

/** Resize to fit the container it is currently in. */
export function fitTerminal(sessionId: string): void {
  const entry = pool.get(sessionId)
  if (!entry || entry.disposed) return
  const parent = entry.host.parentElement
  // A zero-sized parent means collapsed, culled, or mid-layout — fitting to
  // nothing just makes xterm recompute against a 0x0 viewport.
  if (!parent || !parent.clientWidth || !parent.clientHeight) return
  try {
    entry.fit.fit()
    studio.resize(sessionId, entry.term.cols, entry.term.rows)
  } catch {
    /* not laid out yet */
  }
}

export function focusTerminal(sessionId: string): void {
  pool.get(sessionId)?.term.focus()
}

export function writeToTerminal(sessionId: string, data: string): void {
  const entry = pool.get(sessionId)
  if (entry && !entry.disposed) entry.term.write(data)
}

/**
 * Really destroy a session's terminal. Call when the pty is gone for good.
 *
 * Detaching first stops any scroll or resize work, and the delay lets an
 * already-queued `syncScrollArea` → `_innerRefresh` chain finish while the
 * renderer is still alive. This runs once per closed node rather than on every
 * pan, so the wait costs nothing.
 */
export function destroyTerminal(sessionId: string): void {
  const entry = pool.get(sessionId)
  if (!entry) return
  pool.delete(sessionId)
  entry.disposed = true
  entry.offData?.()
  entry.host.remove()
  setTimeout(() => {
    try {
      entry.term.dispose()
    } catch {
      /* already gone */
    }
  }, 250)
}

/** Tear down everything — used when the Studio view itself unmounts. */
export function destroyAllTerminals(): void {
  for (const id of Array.from(pool.keys())) destroyTerminal(id)
}
