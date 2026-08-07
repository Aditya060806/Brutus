/**
 * Worktree tests, run against real throwaway repositories.
 *
 * This is the only part of Studio that touches the user's git history, so it is
 * tested by actually creating repos, branching, committing and merging — not by
 * mocking git. The assertions that matter are the destructive ones: a conflict
 * must leave the working tree untouched, and closing an agent must never delete
 * a branch that still holds unmerged work.
 */
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const require = createRequire(import.meta.url)
const {
  createWorktree,
  commitAndMerge,
  removeWorktree,
  git,
  listOrphanedWorktrees
} = require('./worktree.test.cjs')

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })

/** A fresh repository with one commit. */
function makeRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `brutus-${name}-`))
  run(['init', '-q', '-b', 'main'], dir)
  run(['config', 'user.email', 'test@brutus.local'], dir)
  run(['config', 'user.name', 'Brutus Test'], dir)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n')
  run(['add', '-A'], dir)
  run(['commit', '-qm', 'init'], dir)
  return dir
}

const branches = (repo) =>
  run(['branch', '--list'], repo)
    .replace(/[*\s]+/g, ' ')
    .trim()

// ═══ 1. Isolation ═════════════════════════════════════════════════════════
{
  const repo = makeRepo('iso')
  const a = await createWorktree(repo, 'Apollo', 'sess-aaa111')
  const b = await createWorktree(repo, 'Vega', 'sess-bbb222')

  ok('a worktree is created', a.ok === true, a.ok ? '' : a.error)
  ok('a second worktree is created', b.ok === true, b.ok ? '' : b.error)
  ok('each agent gets its own branch', a.worktree.branch !== b.worktree.branch)
  ok('each agent gets its own directory', a.worktree.dir !== b.worktree.dir)
  ok(
    'both branch from the checked-out branch',
    a.worktree.base === 'main' && b.worktree.base === 'main'
  )
  ok('the worktree directory really exists', fs.existsSync(a.worktree.dir))
  ok(
    'the worktree lives outside the repository',
    !path.resolve(a.worktree.dir).startsWith(path.resolve(repo) + path.sep),
    a.worktree.dir
  )

  // Two agents editing the same file cannot see each other's work.
  fs.writeFileSync(path.join(a.worktree.dir, 'a.txt'), 'apollo\n')
  fs.writeFileSync(path.join(b.worktree.dir, 'a.txt'), 'vega\n')
  ok(
    'edits are genuinely isolated from each other',
    fs.readFileSync(path.join(a.worktree.dir, 'a.txt'), 'utf8').trim() === 'apollo'
  )
  ok(
    'and the real working tree is untouched',
    fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').trim() === 'base'
  )
}

// ═══ 2. Commit and merge ══════════════════════════════════════════════════
{
  const repo = makeRepo('merge')
  const w = await createWorktree(repo, 'Apollo', 'sess-ccc333')
  fs.writeFileSync(path.join(w.worktree.dir, 'feature.txt'), 'shipped\n')

  const res = await commitAndMerge(w.worktree, 'Apollo: add the feature')
  ok('a clean turn merges', res.status === 'merged', JSON.stringify(res))
  ok(
    'the merged file lands in the real working tree',
    fs.existsSync(path.join(repo, 'feature.txt'))
  )
  ok(
    'the merge is a real merge commit (--no-ff)',
    run(['log', '-1', '--pretty=%P'], repo).trim().split(/\s+/).length === 2
  )

  const again = await commitAndMerge(w.worktree, 'nothing new')
  ok(
    'a turn that changed nothing is a no-op',
    again.status === 'nothing-to-do',
    JSON.stringify(again)
  )
}

// ═══ 3. Conflicts leave everything alone ══════════════════════════════════
{
  const repo = makeRepo('conflict')
  const w = await createWorktree(repo, 'Apollo', 'sess-ddd444')

  // The agent edits a line; the human edits the same line differently.
  fs.writeFileSync(path.join(w.worktree.dir, 'a.txt'), 'agent version\n')
  await commitAndMerge(w.worktree, 'agent edit').catch(() => {})

  // Reset the scenario: make both sides diverge on the same line.
  const repo2 = makeRepo('conflict2')
  const w2 = await createWorktree(repo2, 'Apollo', 'sess-eee555')
  fs.writeFileSync(path.join(w2.worktree.dir, 'a.txt'), 'agent version\n')
  run(['add', '-A'], w2.worktree.dir)
  run(['commit', '-qm', 'agent edit'], w2.worktree.dir)

  fs.writeFileSync(path.join(repo2, 'a.txt'), 'human version\n')
  run(['add', '-A'], repo2)
  run(['commit', '-qm', 'human edit'], repo2)

  const before = fs.readFileSync(path.join(repo2, 'a.txt'), 'utf8')
  const res = await commitAndMerge(w2.worktree, 'agent turn')

  ok(
    'a conflicting merge is reported as a conflict',
    res.status === 'conflict',
    JSON.stringify(res)
  )
  ok('the conflict names the branch to resolve', String(res.branch || '').includes('brutus/'))
  // Compared on content, not bytes: this machine has core.autocrlf=true, so
  // git legitimately rewrites line endings when it restores a file.
  const norm = (s) => s.replace(/\r\n/g, '\n')
  ok(
    'the working tree content is unchanged',
    norm(fs.readFileSync(path.join(repo2, 'a.txt'), 'utf8')) === norm(before)
  )
  ok(
    'and git agrees the tree is clean',
    run(['status', '--porcelain'], repo2).trim() === '',
    run(['status', '--porcelain'], repo2)
  )
  ok(
    'no merge is left half-applied',
    !fs.existsSync(path.join(repo2, '.git', 'MERGE_HEAD')),
    'MERGE_HEAD still present'
  )
  ok('the agent branch still exists', branches(repo2).includes('brutus/'))
  void w
}

// ═══ 4. Cleanup keeps the work ════════════════════════════════════════════
{
  const repo = makeRepo('cleanup')
  const w = await createWorktree(repo, 'Vega', 'sess-fff666')
  fs.writeFileSync(path.join(w.worktree.dir, 'unmerged.txt'), 'not merged anywhere\n')
  run(['add', '-A'], w.worktree.dir)
  run(['commit', '-qm', 'unmerged work'], w.worktree.dir)

  await removeWorktree(w.worktree)

  ok('the worktree directory is removed', !fs.existsSync(w.worktree.dir))
  ok(
    'but the branch with unmerged work is KEPT',
    branches(repo).includes(w.worktree.branch),
    branches(repo)
  )
  const commits = run(['log', '--oneline', w.worktree.branch], repo)
  ok('and its commits are still reachable', commits.includes('unmerged work'))
}

// ═══ 5. Refusals ══════════════════════════════════════════════════════════
{
  /**
   * `os.tmpdir()` is not reliably outside a repository — on this machine it
   * resolves under the home directory, which has its own `.git`. So the
   * "not a repo" path is exercised with somewhere that definitely is not one.
   */
  const missing = path.join(os.tmpdir(), 'brutus-does-not-exist-' + Date.now())
  const res = await createWorktree(missing, 'Apollo', 'sess-ggg777')
  ok('a folder that is not a usable repository is refused', res.ok === false)
  ok('the refusal explains itself', (res.error ?? '').length > 0, res.error)

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'brutus-empty-'))
  run(['init', '-q'], empty)
  const res2 = await createWorktree(empty, 'Apollo', 'sess-hhh888')
  ok('a repository with no commits is refused', res2.ok === false)
  ok('and explains that too', /no commits/i.test(res2.error ?? ''), res2.error)
}

// ═══ 6. git() runs without a shell ════════════════════════════════════════
{
  const repo = makeRepo('shell')
  /**
   * Proven by side effect, not by output. `git rev-parse` echoes an argument it
   * cannot resolve, so searching stdout for the payload finds git quoting it
   * back and proves nothing. Whether a shell ran is answered by whether the
   * shell's command actually happened.
   */
  await git(['rev-parse', '--abbrev-ref', 'HEAD & echo pwned > pwned.txt'], repo)
  await git(['rev-parse', '--abbrev-ref', 'HEAD; touch pwned2.txt'], repo)
  ok(
    'a metacharacter in an argument runs no second command',
    !fs.existsSync(path.join(repo, 'pwned.txt'))
  )
  ok('and no shell-only builtin fires either', !fs.existsSync(path.join(repo, 'pwned2.txt')))
}

// ═══ 7. Orphaned worktrees ════════════════════════════════════════════════
//
// A crash or force-quit leaves the directory and the branch in place — the
// branch deliberately, because it may hold work that never merged. They are
// listed so a human can decide; nothing here acts on its own.

{
  const repo = makeRepo('orphans')
  const alive = await createWorktree(repo, 'Alive', 'sess-alive1')
  const dead = await createWorktree(repo, 'Dead', 'sess-dead01')

  // The dead one has unmerged work; the live one is still in use.
  fs.writeFileSync(path.join(dead.worktree.dir, 'wip.txt'), 'unmerged work\n')
  run(['add', '-A'], dead.worktree.dir)
  run(['commit', '-qm', 'wip'], dead.worktree.dir)

  const orphans = await listOrphanedWorktrees(repo, [alive.worktree.dir])

  ok(
    'an abandoned worktree is found',
    orphans.some((o) => o.branch === dead.worktree.branch)
  )
  ok(
    'a worktree still in use is not listed',
    !orphans.some((o) => o.branch === alive.worktree.branch),
    JSON.stringify(orphans.map((o) => o.branch))
  )
  ok('the main worktree is never an orphan', !orphans.some((o) => o.dir === path.resolve(repo)))

  const found = orphans.find((o) => o.branch === dead.worktree.branch)
  ok('unmerged commits are counted', found?.unmerged === 1, String(found?.unmerged))
  ok('an age is reported', typeof found?.ageMs === 'number' && found.ageMs >= 0)
  ok('and the directory is known to exist', found?.missing === false)
}

{
  // Only Brutus's own branches are Brutus's business.
  const repo = makeRepo('mine-only')
  const mine = await createWorktree(repo, 'Apollo', 'sess-mine01')
  const theirs = path.join(path.dirname(repo), 'their-worktree-' + Date.now())
  run(['worktree', 'add', '-q', '-b', 'feature/theirs', theirs], repo)

  const orphans = await listOrphanedWorktrees(repo, [])
  ok('a user-created worktree is left alone', !orphans.some((o) => o.branch === 'feature/theirs'))
  ok(
    'while a brutus worktree is listed',
    orphans.some((o) => o.branch === mine.worktree.branch)
  )
}

{
  // Removing an orphan must behave exactly as closing an agent does.
  const repo = makeRepo('reclaim')
  const w = await createWorktree(repo, 'Vega', 'sess-recl01')
  fs.writeFileSync(path.join(w.worktree.dir, 'keep.txt'), 'keep me\n')
  run(['add', '-A'], w.worktree.dir)
  run(['commit', '-qm', 'keep me'], w.worktree.dir)

  await removeWorktree(w.worktree)
  ok('reclaiming removes the directory', !fs.existsSync(w.worktree.dir))
  ok(
    'and still keeps the branch with its commits',
    run(['log', '--oneline', w.worktree.branch], repo).includes('keep me')
  )
  const after = await listOrphanedWorktrees(repo, [])
  ok('a removed worktree stops being listed', !after.some((o) => o.dir === w.worktree.dir))
}

console.log(`PASS ${PASS.length}`)
PASS.forEach((p) => console.log(`  ✓ ${p}`))
if (FAIL.length) {
  console.log(`\nFAIL ${FAIL.length}`)
  FAIL.forEach((f) => console.log(`  ✗ ${f}`))
}
process.exit(FAIL.length ? 1 : 0)
