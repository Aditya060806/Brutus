/**
 * BRUTUS Studio — spotting a dev server in an agent's output
 * -----------------------------------------------------------
 * An agent told to build a frontend will, sooner or later, start one:
 *
 *     VITE v8.0.8  ready in 340 ms
 *     ➜  Local:   http://localhost:5173/
 *
 * When that happens the canvas opens a preview window next to the agent, so the
 * thing being built is visible beside the terminal building it. This module is
 * the detector — pure string work, no Electron, no network, so every awkward
 * case below is a test rather than a guess.
 *
 * ── WHY IT READS THE STREAM RATHER THAN SCANNING PORTS ─────────────────────
 * Probing localhost would find every unrelated service on the machine — the
 * user's own work, a database admin panel, another project's server — and
 * putting any of those on the canvas would be both wrong and intrusive. The
 * agent announcing its own URL is the only evidence that ties a server to the
 * agent that started it.
 *
 * ── WHY ONLY LOOPBACK ──────────────────────────────────────────────────────
 * The output is untrusted: it contains whatever the agent just read, including
 * file contents and web pages. A URL harvested from that stream is loaded in a
 * frame inside Brutus, so anything but a loopback host is refused outright. A
 * README mentioning `https://evil.example` must never become a live frame.
 */

import { stripAnsi } from './adapters/registry'

/** Hosts that may be previewed. Nothing else is ever accepted. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'])

/**
 * Ports that are never a frontend worth showing.
 *
 * These are the ones a coding agent's own tooling routinely mentions —
 * inspectors, language servers, the policy hook Brutus itself runs — and
 * opening a frame on any of them shows a blank page at best.
 */
const IGNORED_PORTS = new Set([
  9229, // node --inspect
  9230,
  5858, // legacy node debug
  6006 // storybook is fine, but announced too early to be loadable
])

/**
 * How much of the tail to keep per session between chunks.
 *
 * A pty delivers output in arbitrary slices, so `http://localho` and
 * `st:5173/` routinely arrive as two chunks. Without an overlap the URL is
 * split down the middle and never matches. 256 bytes is far more than the
 * longest line this needs to see.
 */
export const TAIL_BYTES = 256

/**
 * `http://host:port` — port required.
 *
 * Deliberately strict. A bare `http://localhost` with no port is far more often
 * prose in a README than a running server, and guessing 80 would open a frame on
 * whatever else happens to be listening.
 */
const URL_RE = /https?:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{2,5})(\/[^\s"'`<>)\]]*)?/gi

export interface DevServerHit {
  /** Normalised origin plus path, ready to load. */
  url: string
  port: number
}

/**
 * Find the last dev-server URL in a piece of terminal output.
 *
 * The *last* one, because a framework that prints both a Local and a Network
 * address prints Local first, and a server that restarts on a new port prints
 * the new one last. The most recent line is the one that is true now.
 */
export function detectDevServerUrl(raw: string): DevServerHit | null {
  const text = stripAnsi(String(raw ?? ''))
  let found: DevServerHit | null = null

  for (const match of text.matchAll(URL_RE)) {
    const host = match[1].toLowerCase()
    if (!LOOPBACK.has(host)) continue

    const port = Number(match[2])
    if (!Number.isFinite(port) || port < 10 || port > 65535) continue
    if (IGNORED_PORTS.has(port)) continue

    // 0.0.0.0 means "every interface"; it is not loadable as a host.
    const display = host === '0.0.0.0' || host === '::1' ? 'localhost' : host
    const path = (match[3] ?? '').replace(/[.,;:]+$/, '')

    found = { url: `http://${display}:${port}${path || '/'}`, port }
  }

  return found
}

/**
 * Per-session detector.
 *
 * Holds the overlap tail so a URL split across chunks is still found, and
 * remembers what it has already reported so a server that keeps re-printing its
 * banner — or a page reload that echoes the URL — does not open a second
 * preview window every time.
 */
export class DevServerWatcher {
  private tails = new Map<string, string>()
  private seen = new Map<string, Set<string>>()

  /** Feed a chunk. Returns a hit only the first time each URL is seen. */
  push(sessionId: string, chunk: string): DevServerHit | null {
    const tail = this.tails.get(sessionId) ?? ''
    const window = tail + String(chunk ?? '')
    this.tails.set(sessionId, window.slice(-TAIL_BYTES))

    const hit = detectDevServerUrl(window)
    if (!hit) return null

    let reported = this.seen.get(sessionId)
    if (!reported) {
      reported = new Set()
      this.seen.set(sessionId, reported)
    }
    if (reported.has(hit.url)) return null
    reported.add(hit.url)
    return hit
  }

  /** Drop a session's state when its terminal dies. */
  forget(sessionId: string): void {
    this.tails.delete(sessionId)
    this.seen.delete(sessionId)
  }
}
