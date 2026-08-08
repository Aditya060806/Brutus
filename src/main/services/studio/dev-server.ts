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
 * Files worth opening a window on.
 *
 * HTML only. A preview frame renders a page; pointing it at a `.ts` or a `.json`
 * shows the browser's idea of plain text, which is worse than showing nothing
 * because it looks like the feature is broken.
 */
const PREVIEWABLE_FILE = /\.html?$/i

/**
 * Is this a file the canvas can show as a page?
 *
 * Used for the other half of "show me what was built": an agent asked for one
 * static page starts no server at all, so there is no URL to catch. The policy
 * layer already sees every file an agent writes, and that is what feeds this.
 */
export function isPreviewableFile(relPath: string): boolean {
  return PREVIEWABLE_FILE.test(String(relPath ?? '').trim())
}

/**
 * Tool calls that CREATE or CHANGE a file, as opposed to reading one.
 *
 * The distinction matters: an agent reads a dozen HTML files while working out
 * what to do, and opening a window on each would bury the canvas. Only a write
 * means "this is the thing I made".
 */
const WRITE_TOOLS = /^(write|edit|multiedit|create|notebookedit|str_replace|apply_patch)/i

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.test(String(toolName ?? '').trim())
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

// ─── Static pages an agent wrote ────────────────────────────────────────────

/**
 * Words that mean the agent CHANGED the file rather than looked at it.
 *
 * Required on the same line as the path. An agent reads a dozen HTML files
 * working out what to do, and opening a window on each would bury the canvas —
 * so a bare path is not enough, something has to say it was written.
 *
 * The vocabulary covers what the three CLIs actually print: Claude Code renders
 * `● Write(index.html)` and `● Update(index.html)`, Codex says `applied patch to`,
 * Gemini says `WriteFile` / `Wrote`.
 */
const WROTE_CONTEXT =
  /\b(wrote|written|writing|write|writefile|created?|creating|saved?|saving|updated?|update|generated?|applied|patch|new file|modified)\b/i

/**
 * Path-shaped tokens ending in .html or .htm.
 *
 * Both separators, optional drive letter, and a stop at the characters a TUI
 * uses to wrap a path — quotes, brackets, parentheses. Claude Code prints
 * `Write(index.html)`, so the closing paren must not become part of the name.
 */
const PAGE_PATH_RE = /(?:[A-Za-z]:)?[^\s"'`<>()[\],;:]*\.html?\b/gi

/**
 * Pull the pages an agent just wrote out of its terminal output.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE POLICY HOOK ──────────────────────────────
 * The policy layer already sees every tool call and knows exactly which file is
 * being written — it is the precise source, and it is used first. But it only
 * exists for Claude Code, because `PreToolUse` is a Claude Code feature:
 * `supportsHook` is false for Codex, Gemini and the shell node. A crew where
 * Codex builds the page and Gemini checks it would never open a preview at all.
 *
 * It also fires BEFORE the tool runs, so the file named by the hook does not
 * exist yet at the moment the hook reports it.
 *
 * Reading the stream is less precise and covers everything: every CLI prints
 * what it wrote, after writing it. The existence check in `PageWatcher` is what
 * makes the imprecision safe.
 */
export function detectWrittenPages(raw: string): string[] {
  const text = stripAnsi(String(raw ?? ''))
  const found: string[] = []

  for (const line of text.split(/[\r\n]+/)) {
    if (!WROTE_CONTEXT.test(line)) continue
    for (const match of line.matchAll(PAGE_PATH_RE)) {
      const candidate = match[0].trim()
      // A bare extension, or a URL fragment that slipped through.
      if (!candidate || /^\.html?$/i.test(candidate)) continue
      if (!found.includes(candidate)) found.push(candidate)
    }
  }

  return found
}

/**
 * Per-session detector for static pages.
 *
 * Separate from `DevServerWatcher` because the two answer different questions —
 * "is something serving?" versus "did something get written?" — and because a
 * page has to be checked against the disk while a URL does not.
 *
 * `exists` is injected so the whole thing is testable without a filesystem, and
 * so the caller decides how a relative path resolves against a session's cwd.
 */
export class PageWatcher {
  private tails = new Map<string, string>()
  private seen = new Map<string, Set<string>>()

  constructor(private exists: (absPath: string) => boolean) {}

  /**
   * Feed a chunk. Returns absolute paths of pages seen for the first time.
   *
   * `resolve` turns a printed path — which may be relative, or already absolute
   * — into the absolute one to check and announce.
   */
  push(sessionId: string, chunk: string, resolve: (p: string) => string): string[] {
    const tail = this.tails.get(sessionId) ?? ''
    const window = tail + String(chunk ?? '')
    this.tails.set(sessionId, window.slice(-TAIL_BYTES))

    const candidates = detectWrittenPages(window)
    if (!candidates.length) return []

    let reported = this.seen.get(sessionId)
    if (!reported) {
      reported = new Set()
      this.seen.set(sessionId, reported)
    }

    const hits: string[] = []
    for (const candidate of candidates) {
      let abs: string
      try {
        abs = resolve(candidate)
      } catch {
        continue
      }
      if (reported.has(abs)) continue
      /**
       * The check that makes stream-reading safe.
       *
       * Terminal output is untrusted and imprecise: it contains file names from
       * READMEs, from error messages, from the agent thinking out loud. A path
       * that is not actually on disk is not a page anyone can preview, so it is
       * simply dropped — and a name is only ever marked seen once it resolved,
       * so a file mentioned before it exists is still caught when it appears.
       */
      if (!this.exists(abs)) continue
      reported.add(abs)
      hits.push(abs)
    }

    return hits
  }

  /** Has this session already announced this page? Shared with the hook path. */
  markSeen(sessionId: string, absPath: string): boolean {
    let reported = this.seen.get(sessionId)
    if (!reported) {
      reported = new Set()
      this.seen.set(sessionId, reported)
    }
    if (reported.has(absPath)) return false
    reported.add(absPath)
    return true
  }

  forget(sessionId: string): void {
    this.tails.delete(sessionId)
    this.seen.delete(sessionId)
  }
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
