/**
 * BRUTUS Studio — agent adapter registry
 * ---------------------------------------
 * Agents are DATA, not branches. Everything that differs between Claude Code,
 * Codex, Gemini and a plain shell lives in an adapter object, so adding Cursor
 * or Hermes later is one new file rather than edits scattered through the
 * spawn path, the prompt watcher and the router.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AgentEvent, AgentKind, RunMode } from '../types'

/** A prompt an agent shows that expects a single-key answer. */
export interface ApprovalPattern {
  /** Matched against the ANSI-stripped tail of the stream. */
  match: RegExp
  /** Keys to write for each meaning, e.g. '1' for yes, '3' for no. */
  yes: string
  no: string
  /** Human-readable summary builder for the approval card. */
  describe?: (tail: string) => string
}

export interface AgentAdapter {
  kind: AgentKind
  label: string
  /** Tailwind text colour used for the node's kind subtitle. */
  accent: string
  /** Binary name looked up on PATH. */
  bin: string
  /** Install hint shown when the binary is missing. */
  install: string

  runModes: RunMode[]
  defaultRunMode: string

  /** Args for the visible interactive TUI. */
  interactiveArgs(o: { runMode: string; model?: string; bypass?: boolean }): string[]

  /**
   * Models this CLI can be pointed at.
   *
   * Only listed where the CLI takes a `--model` flag we can actually pass. An
   * adapter with no entry gets no dropdown rather than a dropdown that does
   * nothing.
   */
  models?: { id: string; label: string }[]

  /**
   * Where this CLI keeps its credentials, relative to the home directory.
   *
   * Presence is a heuristic for "signed in" — it is not a verified session, and
   * the UI says "credentials found" rather than claiming authentication.
   */
  credentialPath?: string
  /** Args for a headless turn that emits structured events. */
  headlessArgs?(o: { prompt: string; runMode: string; resumeId?: string }): string[]

  /** Claude Code has real hooks; others do not. */
  supportsHook: boolean
  /** Adapters with structured output parse it here. */
  parseEvent?(line: string): AgentEvent | null
  /** Fallback completion detection for the visible terminal. */
  idlePatterns: RegExp[]
  approvalPatterns?: ApprovalPattern[]

  /**
   * Carve this agent's actual answer out of a rendered screen.
   *
   * The screen reconstruction is exact, but "exact" still includes the echoed
   * prompt, the welcome banner, the input box and the status footer. Only the
   * adapter knows which of those belong to its own CLI, so each one strips its
   * own chrome instead of a shared regex trying to guess for all of them.
   *
   * Returning the input unchanged is a fine implementation — it just means the
   * next agent sees a little more context than it strictly needs.
   */
  extractResponse?(screen: string): string
}

/**
 * Every glyph a CLI might draw its input prompt with.
 *
 * Written out because getting this wrong is silent and total. Codex draws `›`
 * (U+203A); the pattern only listed `❯` (U+276F), `>` and `»`, so the prompt
 * never matched, the session never reported idle, and — since turn completion
 * is a busy→idle transition — **nothing ever routed**. The agents simply sat at
 * "Starting" while working perfectly, which is exactly the kind of failure that
 * looks like the feature was never wired up at all.
 */
export const PROMPT_GLYPHS = '❯›»▸▶⏵>#$'

/**
 * A prompt line as the last line of the buffer.
 *
 * Note the `[^\n]*`: a real prompt is rarely bare. Codex shows
 * `› Find and fix a bug in @filename` — the glyph followed by placeholder or
 * typed text — so a pattern anchored as "glyph then end of buffer" matches the
 * idealised case and misses the actual one. The glyph must still start the
 * line, which is what keeps ordinary prose ending in `>` from reading as a
 * prompt.
 */
export const PROMPT_TAIL = new RegExp(`\\n\\s*[${PROMPT_GLYPHS}][^\\n]*\\s*$`)

/**
 * Drop leading and trailing lines that match a predicate.
 *
 * Chrome clusters at the edges of a turn — banner at the top, prompt at the
 * bottom — while the answer sits in the middle. Filtering the whole screen
 * would delete matching lines out of the answer itself.
 */
export function trimEdges(screen: string, isChrome: (line: string) => boolean): string {
  const lines = screen.split('\n')
  let start = 0
  let end = lines.length
  while (start < end && (!lines[start].trim() || isChrome(lines[start]))) start++
  while (end > start && (!lines[end - 1].trim() || isChrome(lines[end - 1]))) end--
  return lines.slice(start, end).join('\n').trim()
}

// ─── Binary detection ───────────────────────────────────────────────────────

const detectCache = new Map<string, string | null>()
/** Why a binary that exists on PATH still cannot be launched. */
const issueCache = new Map<string, string>()

/**
 * Extensions Windows can actually hand to CreateProcess, best first.
 *
 * `.exe` is a real executable; `.cmd` and `.bat` are batch files that ConPTY
 * launches through the command processor for us — both verified working. `.ps1`
 * and extensionless files are absent on purpose: they are scripts, not
 * programs, and CreateProcess rejects them.
 */
const WINDOWS_EXEC_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com']

/**
 * Choose which of `where`'s results can actually be spawned.
 *
 * This exists because of a real failure. An npm-installed CLI on Windows lays
 * down two files next to each other:
 *
 *     C:\...\npm\claude        ← a POSIX shell script, for Git Bash
 *     C:\...\npm\claude.cmd    ← the Windows shim
 *
 * `where claude` lists the extensionless one FIRST. Taking the first result
 * therefore handed node-pty a shell script, and Windows answered with
 * `CreateProcess ... error code: 193` (ERROR_BAD_EXE_FORMAT) — an error that
 * says nothing about the actual problem. Every npm-installed agent CLI hits
 * this, so the fix is to rank by extension rather than trust the ordering.
 */
export function pickExecutable(candidates: string[], platform = process.platform): string | null {
  const cleaned = candidates.map((c) => c.trim()).filter(Boolean)
  if (!cleaned.length) return null
  if (platform !== 'win32') return cleaned[0]

  for (const ext of WINDOWS_EXEC_EXTENSIONS) {
    const hit = cleaned.find((c) => c.toLowerCase().endsWith(ext))
    if (hit) return hit
  }
  return null
}

/**
 * Resolve a binary on PATH.
 *
 * Uses `where`/`which` rather than attempting a spawn, because spawning an
 * agent CLI just to see if it exists can start a real session, print a banner,
 * or prompt for login.
 */
export function detectBinary(bin: string): string | null {
  if (detectCache.has(bin)) return detectCache.get(bin) ?? null
  let resolved: string | null = null
  issueCache.delete(bin)

  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const res = spawnSync(cmd, [bin], { encoding: 'utf8', timeout: 4000, shell: false })
    if (res.status === 0 && res.stdout) {
      const candidates = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      resolved = pickExecutable(candidates)
      if (!resolved && candidates.length) {
        // On PATH, but only in a form Windows cannot launch. Say so, rather
        // than reporting it as missing and suggesting a reinstall that would
        // change nothing.
        issueCache.set(
          bin,
          `Found "${bin}" at ${candidates[0]}, but that is a script rather than a Windows executable. ` +
            `Reinstall it with npm so the ${bin}.cmd shim is created, or add the folder containing ${bin}.cmd to PATH.`
        )
      }
    }
  } catch {
    resolved = null
  }

  detectCache.set(bin, resolved)
  return resolved
}

/** A specific explanation for an unlaunchable binary, when there is one. */
export function binaryIssue(bin: string): string | null {
  return issueCache.get(bin) ?? null
}

export function clearDetectCache(): void {
  detectCache.clear()
  issueCache.clear()
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Strip ANSI/CSI/OSC so patterns match on what the user actually sees.
 *
 * `no-control-regex` is disabled deliberately for this function: matching the
 * ESC (\x1b) and BEL (\x07) control characters IS the job here. Every approval
 * and idle pattern runs against this output, so getting it wrong would mean
 * Brutus reading a prompt that is half escape codes.
 */
/* eslint-disable no-control-regex */
export function stripAnsi(s: string): string {
  return (
    s
      // OSC sequences (title changes etc.), terminated by BEL or ST
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CSI sequences
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // Remaining single-char escapes
      .replace(/\x1b[@-Z\\-_]/g, '')
  )
}
/* eslint-enable no-control-regex */

const registry = new Map<AgentKind, AgentAdapter>()

export function registerAdapter(a: AgentAdapter): void {
  registry.set(a.kind, a)
}

export function getAdapter(kind: AgentKind): AgentAdapter | null {
  return registry.get(kind) ?? null
}

export function listAdapters(): AgentAdapter[] {
  return Array.from(registry.values())
}

/** Has this CLI been signed into on this machine, as far as we can tell? */
export function hasCredentials(a: AgentAdapter): boolean {
  if (!a.credentialPath) return true
  try {
    return fs.existsSync(path.join(os.homedir(), a.credentialPath))
  } catch {
    return false
  }
}

export interface AdapterAvailability {
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

/** What the picker renders: everything, with missing binaries greyed out. */
export function adapterAvailability(): AdapterAvailability[] {
  return listAdapters().map((a) => {
    const path = detectBinary(a.bin)
    return {
      kind: a.kind,
      label: a.label,
      accent: a.accent,
      bin: a.bin,
      install: a.install,
      path,
      available: !!path,
      runModes: a.runModes,
      defaultRunMode: a.defaultRunMode,
      models: a.models ?? [],
      signedIn: hasCredentials(a)
    }
  })
}
