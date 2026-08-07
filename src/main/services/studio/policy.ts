/**
 * BRUTUS Studio — the policy engine
 * ----------------------------------
 * Decides whether an agent's tool call runs, is refused, or is raised to the
 * human. This is the piece that makes Brutus the brain rather than a window
 * manager, and it is the most safety-critical code in the feature.
 *
 * Three principles, in priority order:
 *
 *  1. **Never auto-approve something we did not positively recognise.** An
 *     unknown tool or an unparseable command escalates to the human. Silence is
 *     never taken as consent.
 *  2. **Containment beats intent.** A write inside the agent's working folder
 *     is ordinary work; the same write outside it is a different act entirely,
 *     regardless of how reasonable the agent's explanation sounds.
 *  3. **Some things are never auto-approved at any autonomy level.** Wiping a
 *     disk, curl-piping a script into a shell, force-pushing over history: the
 *     blast radius is unbounded and irreversible, so a human looks at it even
 *     in the most permissive mode.
 *
 * The tag vocabulary matches the orchestrator's capability bus on purpose, so
 * one mental model covers both agent systems.
 */
import path from 'path'
import type { PolicyRequest, PolicyResult } from './types'

export type Autonomy = 'guarded' | 'strict' | 'autonomous'

/**
 * Tools that only observe, or that talk to the human. Always free.
 *
 * `AskUserQuestion` is here for a reason worth stating: it is the agent asking
 * *you* something, and it touches nothing. Treating it as an unrecognised tool
 * meant Brutus raised its own approval card over a question the terminal was
 * already asking, blocked the agent for the full 25s timeout, and then handed
 * the prompt back — observed live, twice, in one short session. Gating an
 * interaction is not caution, it is a deadlock with a countdown.
 */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebSearch',
  'TodoWrite', // writes only to the agent's own scratch list
  'Task',
  // Human-interaction tools: they change nothing on the machine.
  'AskUserQuestion',
  'ExitPlanMode',
  'TodoRead',
  'SlashCommand'
])

/** Tools that modify files. Free inside the working folder, gated outside it. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update'])

/** Tools that reach the network. Reads, but they leave the machine. */
const NETWORK_TOOLS = new Set(['WebFetch'])

/**
 * Commands that are never auto-approved, at any autonomy level.
 *
 * Deliberately conservative and unbounded-blast-radius only: this is not a
 * general "looks scary" list, it is the set where a wrong call cannot be undone.
 */
const NEVER_AUTO: { pattern: RegExp; why: string }[] = [
  {
    pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+\/(?:\s|$)/i,
    why: 'recursive delete of the filesystem root'
  },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: 'recursive force delete' },
  { pattern: /\b(mkfs|fdisk|diskpart|format)\b/i, why: 'disk formatting' },
  { pattern: /\bdd\s+.*\bof=\/dev\//i, why: 'raw write to a block device' },
  { pattern: /:\(\)\s*\{.*\}\s*;?\s*:/, why: 'fork bomb' },
  {
    pattern: /\b(curl|wget|iwr|invoke-webrequest)\b[^|;]*[|]\s*(ba|z|k)?sh\b/i,
    why: 'piping a downloaded script into a shell'
  },
  {
    pattern: /\bgit\s+push\b[^\n]*--force(?!-with-lease)/i,
    why: 'force push that can destroy remote history'
  },
  { pattern: /\bgit\s+reset\s+--hard\b/i, why: 'discards uncommitted work irreversibly' },
  { pattern: /\bgit\s+clean\s+-[a-z]*[fd]/i, why: 'deletes untracked files irreversibly' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, why: 'shuts down the machine' },
  { pattern: /\bchmod\s+(-R\s+)?777\b/i, why: 'makes files world-writable' },
  { pattern: /\b(sudo|runas|Start-Process\s+.*-Verb\s+RunAs)\b/i, why: 'privilege escalation' },
  {
    pattern: /\b(Remove-Item|ri|del|rmdir)\b[^\n]*\s-Recurse[^\n]*\s-Force/i,
    why: 'recursive force delete'
  },
  { pattern: /\bnpm\s+publish\b|\byarn\s+publish\b/i, why: 'publishes a package publicly' }
]

/**
 * Shell commands safe enough to run unattended: they read, build, or test, and
 * none of them mutate anything outside the project or leave the machine.
 */
const SAFE_COMMANDS: RegExp[] = [
  /^\s*(ls|dir|pwd|cd|echo|cat|type|head|tail|wc|which|where|find|grep|rg|fd)\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|rev-parse|describe|blame|stash list)\b/i,
  /^\s*(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|typecheck|build|format)|ls|list|why|outdated)\b/i,
  /^\s*(node|python3?|tsx?|deno)\s+--version\b/i,
  /^\s*(tsc|eslint|prettier|vitest|jest|pytest|cargo\s+(check|test|clippy))\b/i,
  /^\s*(docker\s+ps|kubectl\s+get)\b/i
]

/** Does `target` resolve inside `root`? Symlink-agnostic prefix containment. */
export function isInside(root: string, target: string): boolean {
  if (!root || !target) return false
  try {
    const r = path.resolve(root)
    const t = path.resolve(root, target)
    const rel = path.relative(r, t)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  } catch {
    return false
  }
}

/** Pull a filesystem path out of a tool's arguments, whatever it calls it. */
function pathFromInput(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'path', 'filePath', 'notebook_path', 'target', 'file']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function commandFromInput(input: Record<string, unknown>): string | null {
  for (const key of ['command', 'cmd', 'script']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

/** Split a shell line on separators so `safe && dangerous` is not read as safe. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface PolicyOptions {
  autonomy: Autonomy
  /** The folder this agent was launched in. Containment is measured from here. */
  workingDir: string
}

/**
 * Decide a single tool call.
 *
 * Returns `allow` only when the call is positively recognised as safe;
 * `deny` only for things that should never happen; and `ask` for everything
 * else, which surfaces on the canvas.
 */
export function decide(req: PolicyRequest, opts: PolicyOptions): PolicyResult {
  const tool = String(req.toolName || '').trim()
  const input = req.toolInput ?? {}
  const root = opts.workingDir || req.cwd || ''

  if (!tool) return { decision: 'ask', reason: 'Unnamed tool call.' }

  // ── Catastrophic first: checked before autonomy, so even "autonomous" stops
  //
  // Checked against BOTH the whole command and each segment. Segments catch
  // `git status && rm -rf /`, where a safe prefix would otherwise launder a
  // dangerous suffix. The whole command catches constructs that ARE the pipe —
  // `curl x | sh` is only dangerous when read intact, and splitting on `|`
  // would hide it as the harmless pair "curl x" and "sh".
  const command = commandFromInput(input)
  if (command) {
    for (const candidate of [command, ...segments(command)]) {
      for (const rule of NEVER_AUTO) {
        if (rule.pattern.test(candidate)) {
          return {
            decision: 'ask',
            reason: `Needs your approval — ${rule.why}.`
          }
        }
      }
    }
  }

  // Fully autonomous: everything else goes through.
  if (opts.autonomy === 'autonomous') {
    return { decision: 'allow', reason: 'Autonomous mode.' }
  }

  // ── Read-only tools ──
  if (READ_ONLY_TOOLS.has(tool)) {
    return { decision: 'allow', reason: 'Read-only.' }
  }

  // ── Network reads ──
  if (NETWORK_TOOLS.has(tool)) {
    return opts.autonomy === 'strict'
      ? { decision: 'ask', reason: 'Strict mode gates anything that leaves the machine.' }
      : { decision: 'allow', reason: 'Read-only network fetch.' }
  }

  // ── File writes: containment decides ──
  if (WRITE_TOOLS.has(tool)) {
    const target = pathFromInput(input)
    if (!target) {
      return { decision: 'ask', reason: 'Write with no resolvable path.' }
    }
    if (!isInside(root, target)) {
      return {
        decision: 'ask',
        reason: `Writes outside the working folder (${target}).`
      }
    }
    if (opts.autonomy === 'strict') {
      return { decision: 'ask', reason: 'Strict mode gates every write.' }
    }
    return { decision: 'allow', reason: 'Edit inside the working folder.' }
  }

  // ── Shell ──
  if (tool === 'Bash' || tool === 'Shell' || tool === 'Terminal') {
    if (!command) return { decision: 'ask', reason: 'Shell call with no command.' }
    if (opts.autonomy === 'strict') {
      return { decision: 'ask', reason: 'Strict mode gates every command.' }
    }
    const parts = segments(command)
    const allSafe = parts.length > 0 && parts.every((p) => SAFE_COMMANDS.some((r) => r.test(p)))
    return allSafe
      ? { decision: 'allow', reason: 'Recognised read-only or build command.' }
      : { decision: 'ask', reason: 'Command is not on the recognised-safe list.' }
  }

  // ── Anything we do not recognise ──
  // This is the important default: a tool Brutus has never seen is never
  // waved through on the assumption it is probably fine.
  return { decision: 'ask', reason: `Unrecognised tool "${tool}".` }
}

/** One-line human summary for the approval card. */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  const brief = (v: unknown, n = 120): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? '')
    return s.length > n ? `${s.slice(0, n)}…` : s
  }
  const cmd = commandFromInput(input)
  if (cmd) return `Run: ${brief(cmd)}`
  const p = pathFromInput(input)
  if (p) return `${toolName}: ${brief(p)}`
  return `${toolName} ${brief(input)}`
}
