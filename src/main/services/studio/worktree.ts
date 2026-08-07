/**
 * BRUTUS Studio — per-agent git worktrees
 * ----------------------------------------
 * Isolation for parallel work. With this on, each agent gets its own `git
 * worktree` on its own branch, so two agents editing the same repository at the
 * same time cannot overwrite each other — they are literally in different
 * directories, sharing one object store.
 *
 * This is also what makes autonomous mode defensible. Letting an agent skip
 * permission prompts inside your working tree is reckless; letting it do so
 * inside a scratch branch it owns, that you merge deliberately, is a different
 * proposition. The two settings are coupled in the UI for that reason.
 *
 * ── WHAT THIS WILL NOT DO ──────────────────────────────────────────────────
 * It never force-pushes, never resets, never discards. Merges are `--no-ff` and
 * only attempted when the merge is clean; a conflict aborts and hands the
 * branch back to you by name. Nothing here can lose committed work — the worst
 * case is a branch left behind for you to look at.
 */
import { spawn } from 'child_process'
import { isTransientGitFailure, withRetry } from './retry'
import fs from 'fs'
import path from 'path'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

/**
 * Run git once. No retrying, no interpretation — just the process.
 *
 * Kept separate from `git()` so the retry policy lives in exactly one place and
 * callers cannot accidentally opt out of it.
 */
function runGitOnce(args: string[], cwd: string, timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      resolve({ ok: code === 0, stdout, stderr, code })
    }

    try {
      const child = spawn('git', args, { cwd, shell: false })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        stderr += '\ngit timed out'
        finish(null)
      }, timeoutMs)

      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', (err) => {
        clearTimeout(timer)
        stderr += String((err as { message?: string }).message ?? err)
        finish(null)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish(code)
      })
    } catch (err) {
      stderr += String(err)
      finish(null)
    }
  })
}

/**
 * Run git, retrying only transient failures.
 *
 * Lock contention is the case this exists for, and it is not hypothetical even
 * with the per-repository queue below: that queue serialises *Brutus*, while
 * editors, shell prompts and git hooks on the same machine take the same lock
 * without asking us. Retrying a handful of times over a couple of hundred
 * milliseconds turns "the merge failed" into "the merge waited".
 *
 * The result is returned rather than thrown, so retry is driven by inspecting
 * stderr — which is where git reports lock contention.
 */
export async function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<GitResult> {
  let last: GitResult = { ok: false, stdout: '', stderr: '', code: null }

  try {
    return await withRetry(
      async () => {
        last = await runGitOnce(args, cwd, timeoutMs)
        // Turn a retryable failure into a throw so `withRetry` can see it; any
        // other failure is returned as-is for the caller to interpret.
        if (!last.ok && isTransientGitFailure(last.stderr)) throw new Error(last.stderr.trim())
        return last
      },
      {
        isRetryable: isTransientGitFailure,
        attempts: 4,
        baseDelayMs: 80,
        maxDelayMs: 1_000
      }
    )
  } catch {
    // Exhausted the retries. The last real result is more useful to the caller
    // than the synthetic error used to drive the loop.
    return last
  }
}

/**
 * One operation at a time per repository.
 *
 * Git takes `.git/index.lock` for the whole of a commit or a merge, and refuses
 * outright while another process holds it — verified directly:
 *
 *   fatal: Unable to create '…/.git/index.lock': File exists.
 *
 * Worktrees share the parent repository's index when merging, so two agents
 * finishing a turn together contend for exactly that lock, and the loser's work
 * silently fails to merge. The window is proportional to how much the merge
 * touches: a synthetic two-file repo completes too fast to collide reliably,
 * which is precisely why this must not be left to timing on a real one.
 *
 * Operations are therefore chained per repository. Different repositories still
 * run in parallel, which is where the useful concurrency was anyway.
 */
const repoQueues = new Map<string, Promise<unknown>>()

export async function withRepoLock<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(repo)
  // `.catch` on the predecessor so one failed operation never poisons the queue.
  const previous = repoQueues.get(key) ?? Promise.resolve()
  const tail = previous.then(work, work)
  // Store a swallowed copy: the queue only needs ordering, not outcomes.
  const guarded = tail.then(
    () => undefined,
    () => undefined
  )
  repoQueues.set(key, guarded)

  try {
    return await tail
  } finally {
    // Release the map entry when this was the last operation queued, so a long
    // session across many repositories does not accumulate them.
    if (repoQueues.get(key) === guarded) repoQueues.delete(key)
  }
}

/** How many repositories currently have work queued. For the health panel. */
export function busyRepoCount(): number {
  return repoQueues.size
}

export interface Worktree {
  /** Directory the agent actually runs in. */
  dir: string
  /** Branch it owns. */
  branch: string
  /** Branch it was cut from and merges back into. */
  base: string
  /** The repository this belongs to. */
  repo: string
}

/** Branch/dir-safe slug from an agent's display name. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'agent'
  )
}

async function currentBranch(repo: string): Promise<string> {
  const res = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)
  const name = res.stdout.trim()
  return res.ok && name && name !== 'HEAD' ? name : 'main'
}

/**
 * Give an agent its own worktree.
 *
 * Worktrees live beside the repository in `<repo>/../.brutus-worktrees/<repo>/`
 * rather than inside it: a worktree nested in its own repository confuses both
 * git status and every file watcher in the project.
 */
export function createWorktree(
  repo: string,
  agentName: string,
  sessionId: string
): Promise<{ ok: true; worktree: Worktree } | { ok: false; error: string }> {
  // `git worktree add` writes to the repository, so it queues like everything
  // else — two agents launching together would otherwise collide.
  return withRepoLock(repo, async () => {
    try {
      const inside = await git(['rev-parse', '--is-inside-work-tree'], repo)
      if (!inside.ok || inside.stdout.trim() !== 'true') {
        return { ok: false, error: 'That folder is not a git repository.' }
      }

      // A repo with no commits has no branch to cut from.
      const head = await git(['rev-parse', '--verify', 'HEAD'], repo)
      if (!head.ok) {
        return { ok: false, error: 'This repository has no commits yet — make one first.' }
      }

      const base = await currentBranch(repo)
      const short = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-6)
      const branch = `brutus/${slug(agentName)}-${short}`
      const dir = path.join(
        path.dirname(repo),
        '.brutus-worktrees',
        path.basename(repo),
        branch.replace(/\//g, '_')
      )

      fs.mkdirSync(path.dirname(dir), { recursive: true })

      const add = await git(['worktree', 'add', '-b', branch, dir, base], repo)
      if (!add.ok) {
        return {
          ok: false,
          error: add.stderr.trim().split('\n').slice(-2).join(' ') || 'git worktree add failed'
        }
      }

      return { ok: true, worktree: { dir, branch, base, repo } }
    } catch (err) {
      return { ok: false, error: String((err as { message?: string })?.message ?? err) }
    }
  })
}

export type MergeOutcome =
  | { status: 'merged'; commit: string }
  | { status: 'nothing-to-do' }
  | { status: 'conflict'; branch: string; detail: string }
  | { status: 'failed'; detail: string }

/**
 * Commit whatever the agent changed and merge it back.
 *
 * Deliberately conservative at every step:
 *   • nothing staged and nothing changed → say so and stop;
 *   • the merge is `--no-ff`, so the branch stays legible in history;
 *   • a conflict is aborted immediately and reported with the branch name, so
 *     the work is intact and yours to resolve rather than half-applied.
 */
export function commitAndMerge(wt: Worktree, message: string): Promise<MergeOutcome> {
  return withRepoLock(wt.repo, async () => {
    try {
      const status = await git(['status', '--porcelain'], wt.dir)
      if (status.ok && !status.stdout.trim()) {
        // Nothing changed in the worktree; there may still be earlier commits on
        // the branch worth merging, so fall through rather than returning.
        const ahead = await git(['rev-list', '--count', `${wt.base}..${wt.branch}`], wt.repo)
        if (!ahead.ok || ahead.stdout.trim() === '0') return { status: 'nothing-to-do' }
      } else {
        const add = await git(['add', '-A'], wt.dir)
        if (!add.ok) return { status: 'failed', detail: add.stderr.trim() }
        const commit = await git(
          ['commit', '-m', message.replace(/\s+/g, ' ').slice(0, 200) || 'Brutus agent turn'],
          wt.dir
        )
        // "nothing to commit" is a normal outcome, not a failure.
        if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
          return { status: 'failed', detail: commit.stderr.trim() || commit.stdout.trim() }
        }
      }

      const merge = await git(['merge', '--no-ff', '--no-edit', wt.branch], wt.repo)
      if (merge.ok) {
        const rev = await git(['rev-parse', '--short', 'HEAD'], wt.repo)
        return { status: 'merged', commit: rev.stdout.trim() }
      }

      if (/conflict/i.test(merge.stdout + merge.stderr)) {
        // Leave the repository exactly as it was; the branch keeps the work.
        await git(['merge', '--abort'], wt.repo)
        return {
          status: 'conflict',
          branch: wt.branch,
          detail: 'Merge conflict — the branch is intact and waiting for you.'
        }
      }

      return { status: 'failed', detail: merge.stderr.trim().split('\n').slice(-2).join(' ') }
    } catch (err) {
      return { status: 'failed', detail: String((err as { message?: string })?.message ?? err) }
    }
  })
}

/**
 * Compare paths the way the filesystem does, not the way strings do.
 *
 * Git reports its own resolved, forward-slashed path; Brutus builds worktree
 * directories with `path.join` from wherever the repo came from. On Windows
 * those can be the same directory spelled two ways — the 8.3 short form against
 * the long one — and a plain comparison says they are different. Getting that
 * wrong here would list a **running** agent's worktree as an orphan and offer
 * to remove it.
 */
function canonicalPath(p: string): string {
  try {
    return fs.realpathSync.native(p).toLowerCase()
  } catch {
    return path.resolve(p).toLowerCase()
  }
}

export interface OrphanedWorktree {
  dir: string
  branch: string
  /** Commits on this branch that are not on the branch it was cut from. */
  unmerged: number
  /** Milliseconds since the directory was last written to. */
  ageMs: number
  /** True when the directory is gone but git still lists the worktree. */
  missing: boolean
}

/**
 * Worktrees Brutus left behind.
 *
 * A crash, a force-quit or a killed process leaves the directory and the branch
 * in place — deliberately, because the branch may hold work that never merged.
 * The cost is that they accumulate silently, so they are listed here and shown
 * in Settings for a human to decide about.
 *
 * Only `brutus/*` branches are considered. A worktree the user created for
 * their own reasons is none of Brutus's business, and offering to delete it
 * would be exactly the kind of overreach this feature has to avoid.
 */
export async function listOrphanedWorktrees(
  repo: string,
  liveDirs: Iterable<string> = []
): Promise<OrphanedWorktree[]> {
  const live = new Set(Array.from(liveDirs, canonicalPath))
  const out: OrphanedWorktree[] = []

  const listed = await git(['worktree', 'list', '--porcelain'], repo)
  if (!listed.ok) return out

  // Porcelain output is blank-line separated records of `key value` lines.
  for (const block of listed.stdout.split(/\r?\n\r?\n/)) {
    const dir = block.match(/^worktree (.+)$/m)?.[1]?.trim()
    const ref = block.match(/^branch (.+)$/m)?.[1]?.trim() ?? ''
    if (!dir) continue

    const branch = ref.replace(/^refs\/heads\//, '')
    if (!branch.startsWith('brutus/')) continue

    const resolved = path.resolve(dir)
    const key = canonicalPath(dir)
    // The main worktree is the repository itself and is never an orphan.
    if (key === canonicalPath(repo)) continue
    if (live.has(key)) continue

    let unmerged = 0
    const base = await git(['rev-list', '--count', `HEAD..${branch}`], repo)
    if (base.ok) unmerged = Number(base.stdout.trim()) || 0

    let ageMs = 0
    let missing = false
    try {
      ageMs = Date.now() - fs.statSync(resolved).mtimeMs
    } catch {
      missing = true
    }

    out.push({ dir: resolved, branch, unmerged, ageMs, missing })
  }

  return out.sort((a, b) => b.unmerged - a.unmerged || b.ageMs - a.ageMs)
}

/**
 * Remove a worktree once its agent is gone.
 *
 * The branch is deliberately kept. Deleting it would throw away commits that
 * never merged — exactly the situation where you most want them back.
 */
export function removeWorktree(wt: Worktree): Promise<void> {
  return withRepoLock(wt.repo, async () => {
    try {
      await git(['worktree', 'remove', '--force', wt.dir], wt.repo)
      // Clear the administrative entry too, so a directory deleted out from
      // under git does not leave `git worktree list` reporting a ghost.
      await git(['worktree', 'prune'], wt.repo)
    } catch {
      /* best effort — the branch is what matters and it is untouched */
    }
  })
}
