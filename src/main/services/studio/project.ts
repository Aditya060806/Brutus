/**
 * BRUTUS Studio — the project
 * ----------------------------
 * What turns a folder into a shared workspace that several agents can work in
 * at once without treading on each other.
 *
 * Two jobs:
 *
 *  1. **Resolve the real project root.** Pick any folder inside a repository —
 *     `src/renderer`, say — and every agent still opens at the repository root.
 *     Without this, two agents pointed at different subfolders of the same
 *     project would look like two unrelated projects and share nothing.
 *
 *  2. **Keep a shared journal.** Each agent's finished turn is recorded against
 *     its project root, along with the files it touched (harvested from the
 *     tool calls the policy layer already inspects). When Brutus hands work
 *     from one agent to another it includes a digest, so Codex knows what Claude
 *     just changed and both can push forward instead of duplicating or undoing
 *     each other's work.
 *
 * ── WHY THE JOURNAL IS NOT A FILE IN THE REPO ──────────────────────────────
 * It would be easy to drop a `.brutus/journal.md` into the user's project, and
 * tempting, because agents could then read it themselves. It lives in memory
 * instead. Writing into someone's repository is a side effect they did not ask
 * for, it shows up in their `git status`, and this feature already had one
 * incident from writing a file into a folder that turned out to be the wrong
 * scope. Context reaches the agents through the prompt, which is the path
 * Brutus already controls end to end.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

/** How far up the tree to look for a repository root. */
const MAX_WALK_DEPTH = 12
/** Entries kept per project. Old ones fall off. */
const MAX_JOURNAL_ENTRIES = 40
/** Entries included in a digest — recent work is what matters. */
const DIGEST_ENTRIES = 6
/** Hard ceiling on the digest, so it can never dominate a reframe prompt. */
const MAX_DIGEST_CHARS = 1200

export interface ProjectInfo {
  /** Repository root if there is one, else the folder that was chosen. */
  root: string
  /** Display name — the folder's own name. */
  name: string
  /** Did we find a repository, or is this a loose folder? */
  isRepo: boolean
}

/**
 * Canonical absolute path.
 *
 * `realpathSync.native` matters on Windows: the same folder can be spelled
 * `C:\Users\Aditya Pandey` or `C:\Users\ADITYA~1` (the 8.3 short name), and
 * plain string comparison says those are different directories. `os.tmpdir()`
 * returns the short form while `os.homedir()` returns the long one, so a naive
 * comparison silently fails exactly where it matters most.
 */
function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Walk up from a folder to the repository root.
 *
 * **The home directory is never a project**, even when it contains a `.git` —
 * and it often does, from dotfile repositories. Without that rule a stray `.git`
 * in `~` makes every unrelated folder on the machine resolve to the same
 * "project": agents would all open at the home directory and share one journal,
 * which is both wrong and the exact over-broad scope this feature has to avoid.
 */
export function resolveProjectRoot(dir: string): ProjectInfo {
  const fallback = (d: string): ProjectInfo => ({
    root: d,
    name: path.basename(d) || d,
    isRepo: false
  })

  try {
    if (!dir || !fs.existsSync(dir)) return fallback(path.resolve(dir || ''))

    const home = canonical(os.homedir())
    let current = canonical(dir)

    for (let i = 0; i < MAX_WALK_DEPTH; i++) {
      // Checked before the `.git` test, so a repository in the home directory
      // is not mistaken for the project.
      if (current === home) break

      if (fs.existsSync(path.join(current, '.git'))) {
        return { root: current, name: path.basename(current) || current, isRepo: true }
      }
      const parent = path.dirname(current)
      // dirname of a filesystem root returns the root itself.
      if (parent === current) break
      current = parent
    }
  } catch {
    /* fall through */
  }
  return fallback(canonical(dir))
}

// ─── Shared journal ─────────────────────────────────────────────────────────

export interface JournalEntry {
  /** Node title, e.g. "Apollo". */
  agent: string
  /** Agent kind, e.g. "claude". */
  kind: string
  /** One line about what the turn accomplished. */
  summary: string
  /** Repo-relative paths this agent touched. */
  files: string[]
  at: number
}

/** Tool inputs that name a file, across the CLIs we support. */
const FILE_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file']

/**
 * Pull file paths out of a tool call.
 *
 * The policy layer already sees every tool call, so this is free information —
 * no extra prompting, no asking the agent what it did.
 */
export function filesFromToolInput(
  toolName: string,
  input: Record<string, unknown>,
  root: string
): string[] {
  const found = new Set<string>()

  const add = (raw: unknown): void => {
    if (typeof raw !== 'string' || !raw.trim()) return
    try {
      const abs = path.isAbsolute(raw) ? raw : path.join(root, raw)
      const rel = path.relative(root, abs)
      // Anything outside the project is not this project's business.
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
      found.add(rel.split(path.sep).join('/'))
    } catch {
      /* not a usable path */
    }
  }

  for (const key of FILE_KEYS) add(input[key])

  // Edits arrive in batches on some CLIs.
  const edits = input.edits
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e && typeof e === 'object')
        for (const key of FILE_KEYS) add((e as Record<string, unknown>)[key])
    }
  }

  // A shell command is not structured, but the common file-touching shapes are
  // worth catching so a `git mv` or a redirect still registers.
  if (/^bash$|^shell$|^run/i.test(toolName)) {
    const command = typeof input.command === 'string' ? input.command : ''
    for (const m of command.matchAll(/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|css|json|md)\b/g)) {
      add(m[0])
    }
  }

  return Array.from(found).slice(0, 12)
}

/**
 * What every agent in a project can see about the others.
 *
 * Keyed by project root, so two agents opened in the same repository share one
 * journal and two agents in different repositories share nothing.
 */
export class ProjectJournal {
  private entries = new Map<string, JournalEntry[]>()
  /** Files touched during the turn currently in flight, per session. */
  private pending = new Map<string, Set<string>>()

  /** Record files as the policy layer sees them, before the turn ends. */
  noteFiles(sessionId: string, files: string[]): void {
    if (!files.length) return
    const set = this.pending.get(sessionId) ?? new Set<string>()
    for (const f of files) set.add(f)
    this.pending.set(sessionId, set)
  }

  /** Close a turn: fold the pending files into a journal entry. */
  record(
    root: string,
    sessionId: string,
    entry: Omit<JournalEntry, 'files' | 'at'> & { files?: string[] }
  ): void {
    if (!root) return
    const pending = Array.from(this.pending.get(sessionId) ?? [])
    this.pending.delete(sessionId)

    const list = this.entries.get(root) ?? []
    list.push({
      ...entry,
      summary: entry.summary.replace(/\s+/g, ' ').trim().slice(0, 200),
      files: Array.from(new Set([...(entry.files ?? []), ...pending])).slice(0, 12),
      at: Date.now()
    })
    // Keep it bounded; a long session must not grow without limit.
    this.entries.set(root, list.slice(-MAX_JOURNAL_ENTRIES))
  }

  entriesFor(root: string): JournalEntry[] {
    return this.entries.get(root) ?? []
  }

  /**
   * The block handed to the next agent.
   *
   * `exclude` drops the agent's own entries — it already knows what it did, and
   * repeating it back wastes context and invites it to redo the work.
   */
  digest(root: string, exclude?: string): string {
    const list = this.entriesFor(root).filter((e) => e.agent !== exclude)
    if (!list.length) return ''

    const recent = list.slice(-DIGEST_ENTRIES)
    const lines = recent.map((e) => {
      const files = e.files.length ? ` [${e.files.slice(0, 4).join(', ')}]` : ''
      return `- ${e.agent} (${e.kind}): ${e.summary}${files}`
    })

    const touched = Array.from(new Set(recent.flatMap((e) => e.files))).slice(0, 10)

    const block = [
      'PROJECT CONTEXT — other agents are working in this same repository.',
      ...lines,
      touched.length ? `Files already changed by others: ${touched.join(', ')}` : '',
      'Do not redo their work. If you must touch the same file, read it first.'
    ]
      .filter(Boolean)
      .join('\n')

    return block.length > MAX_DIGEST_CHARS ? block.slice(0, MAX_DIGEST_CHARS) + '…' : block
  }

  /** How many projects this journal is tracking. For the health panel. */
  projectCount(): number {
    return this.entries.size
  }

  /** Forget a session's in-flight files, e.g. when its terminal dies. */
  forgetSession(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  /** Forget a project entirely. */
  clear(root: string): void {
    this.entries.delete(root)
  }
}
