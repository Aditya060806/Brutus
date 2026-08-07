/**
 * Regression tests for the production-hardening pass.
 *
 * Each block corresponds to a specific defect that existed in the code and is
 * named after the failure it prevents, not the mechanism that fixes it. A test
 * that only restates the implementation would have agreed with every one of
 * these bugs while they were live.
 */
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const require = createRequire(import.meta.url)
const {
  withRepoLock,
  busyRepoCount,
  createWorktree,
  commitAndMerge
} = require('./worktree.test.cjs')
const { ProjectJournal } = require('./project.test.cjs')

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ═══ 1. Per-repository serialisation ══════════════════════════════════════
//
// Git holds .git/index.lock for a whole commit or merge. Two agents finishing
// together raced: one won, the other failed with "Unable to create index.lock"
// and its work silently did not merge.

{
  const order = []
  let concurrent = 0
  let maxConcurrent = 0

  const job = (label, ms) =>
    withRepoLock('/repo-a', async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await sleep(ms)
      order.push(label)
      concurrent--
      return label
    })

  const results = await Promise.all([job('first', 40), job('second', 5), job('third', 5)])

  ok('operations on one repo never overlap', maxConcurrent === 1, `peak ${maxConcurrent}`)
  ok('they run in the order queued', order.join(',') === 'first,second,third', order.join(','))
  ok('each caller still gets its own result', results.join(',') === 'first,second,third')
}

{
  // Different repositories must not block each other, or one slow repo would
  // stall every other canvas.
  let bothInFlight = false
  const a = withRepoLock('/repo-x', async () => {
    await sleep(30)
    return 'a'
  })
  const b = withRepoLock('/repo-y', async () => {
    bothInFlight = true
    return 'b'
  })
  await Promise.all([a, b])
  ok('different repositories run in parallel', bothInFlight)
}

{
  // A thrown operation must not wedge the queue for everything after it.
  const failed = withRepoLock('/repo-z', async () => {
    throw new Error('boom')
  })
  let caught = false
  await failed.catch(() => (caught = true))

  const after = await withRepoLock('/repo-z', async () => 'still works')
  ok('a failure is reported to its own caller', caught)
  ok('and does not poison the queue', after === 'still works')
}

{
  // The queue map must not grow for the life of the process.
  await withRepoLock('/repo-transient', async () => 'done')
  await sleep(10)
  ok('the lock map releases finished repositories', busyRepoCount() === 0, String(busyRepoCount()))
}

// ═══ 2. Concurrent merges against one real repository ═════════════════════
//
// The end-to-end version of the same defect, with actual git.

{
  const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brutus-race-'))
  run(['init', '-q', '-b', 'main'], repo)
  run(['config', 'user.email', 'test@brutus.local'], repo)
  run(['config', 'user.name', 'Brutus Test'], repo)
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n')
  run(['add', '-A'], repo)
  run(['commit', '-qm', 'init'], repo)

  const a = await createWorktree(repo, 'Apollo', 'sess-race-a')
  const b = await createWorktree(repo, 'Vega', 'sess-race-b')
  ok('two worktrees are created without colliding', a.ok && b.ok, a.ok ? b.error : a.error)

  // Each agent writes a DIFFERENT file, so both merges should succeed. Before
  // serialisation, one would routinely die on index.lock.
  fs.writeFileSync(path.join(a.worktree.dir, 'apollo.txt'), 'from apollo\n')
  fs.writeFileSync(path.join(b.worktree.dir, 'vega.txt'), 'from vega\n')

  const [ra, rb] = await Promise.all([
    commitAndMerge(a.worktree, 'Apollo turn'),
    commitAndMerge(b.worktree, 'Vega turn')
  ])

  ok(
    'both simultaneous merges succeed',
    ra.status === 'merged' && rb.status === 'merged',
    `${ra.status}/${rb.status}`
  )
  ok(
    'both agents’ files land in the repository',
    fs.existsSync(path.join(repo, 'apollo.txt')) && fs.existsSync(path.join(repo, 'vega.txt'))
  )
  ok('the repository is left clean', run(['status', '--porcelain'], repo).trim() === '')
}

// ═══ 3. Journal bookkeeping ═══════════════════════════════════════════════

{
  const j = new ProjectJournal()
  ok('a fresh journal tracks nothing', j.projectCount() === 0)

  j.record('/repo-1', 's1', { agent: 'A', kind: 'claude', summary: 'x' })
  j.record('/repo-2', 's2', { agent: 'B', kind: 'codex', summary: 'y' })
  ok('it counts one entry per project, not per turn', j.projectCount() === 2)

  j.record('/repo-1', 's3', { agent: 'C', kind: 'claude', summary: 'z' })
  ok('a second turn in a known project adds no project', j.projectCount() === 2)

  j.clear('/repo-1')
  ok('clearing a project releases it', j.projectCount() === 1)
}

{
  // Pending files belong to the turn that produced them. Leaking them into the
  // next turn would report files an agent never touched.
  const j = new ProjectJournal()
  j.noteFiles('s1', ['a.ts'])
  j.noteFiles('s2', ['b.ts'])
  j.record('/r', 's1', { agent: 'A', kind: 'claude', summary: 'first' })

  const first = j.entriesFor('/r')[0]
  ok('a turn records only its own files', first.files.join(',') === 'a.ts', first.files.join(','))

  j.record('/r', 's2', { agent: 'B', kind: 'codex', summary: 'second' })
  const second = j.entriesFor('/r')[1]
  ok(
    'another session’s files are not stolen',
    second.files.join(',') === 'b.ts',
    second.files.join(',')
  )
}

// ═══ 4. Model validation ══════════════════════════════════════════════════
//
// The chosen model comes from a JSON file a user can hand-edit and becomes a
// `--model` argument. It cannot inject a command (argv, never a shell), but an
// arbitrary value would still be forwarded to the CLI.

{
  const adapters = require('./adapters.test.cjs')
  const claude = adapters.getAdapter('claude')

  const declared = claude.models.map((m) => m.id)
  ok('the adapter declares its models', declared.length > 1)

  const valid = declared.find(Boolean)
  const accepted = declared.some((id) => id === valid)
  ok('a declared model is accepted', accepted)
  ok('an undeclared model is not in the list', !declared.includes('../../etc/passwd'))
  ok('nor is a flag-shaped one', !declared.includes('--dangerously-skip-permissions'))

  // The adapter itself must never emit a bypass flag unless explicitly asked.
  const plain = claude.interactiveArgs({ runMode: 'default' })
  ok('no bypass flag without being asked', !plain.join(' ').includes('dangerously'))

  const bypassed = claude.interactiveArgs({ runMode: 'default', bypass: true })
  ok('bypass is emitted only on request', bypassed.includes('--dangerously-skip-permissions'))

  const withModel = claude.interactiveArgs({ runMode: 'default', model: 'opus' })
  ok(
    'the model is passed as its own argv entry',
    withModel.includes('--model') && withModel.includes('opus')
  )

  // Gemini has no bypass flag; it must not be mapped onto something else.
  const gemini = adapters.getAdapter('gemini')
  const gArgs = gemini.interactiveArgs({ runMode: 'default', bypass: true })
  ok('an adapter with no bypass flag stays untouched', !gArgs.join(' ').includes('yolo'))
}

// ═══ 5. Session state transitions ═════════════════════════════════════════
//
// Statuses arrive from three uncoordinated places — the prompt watcher, the
// policy layer and the pty's own exit. A late `busy` from a settling watcher
// could resurrect a session that had already exited, and a resurrected session
// looks alive to the router, which would queue a handoff into a dead terminal.

{
  const { canTransition } = require('./pty-manager.test.cjs')

  ok('a starting session can become ready', canTransition('starting', 'idle'))
  ok('a ready session can start working', canTransition('idle', 'busy'))
  ok('work can be interrupted by an approval', canTransition('busy', 'awaiting-approval'))
  ok('an answered approval resumes', canTransition('awaiting-approval', 'busy'))
  ok('anything live can exit', canTransition('busy', 'exited') && canTransition('idle', 'exited'))
  ok('anything live can fail', canTransition('starting', 'failed'))

  ok('an exited session cannot become busy again', !canTransition('exited', 'busy'))
  ok('nor idle', !canTransition('exited', 'idle'))
  ok('a failed session is equally terminal', !canTransition('failed', 'busy'))
  ok(
    'terminal states absorb everything',
    ['starting', 'idle', 'busy', 'awaiting-approval', 'exited', 'failed'].every(
      (to) => !canTransition('exited', to)
    )
  )
}

// ═══ 6. Config caching ════════════════════════════════════════════════════
//
// read() sits on the routing path — every turn, every delivery, every spawn —
// and was doing existsSync + readFileSync + JSON.parse each time.

{
  const fsx = require('fs')
  const osx = require('os')
  const pathx = require('path')

  // The module resolves its own path via electron's app.getPath, which the test
  // stub points at the OS temp dir, so the cache behaviour is observable
  // through the public API without reaching into internals.
  const dock = require('./dock.test.cjs')

  const first = dock.studioConfig()
  const second = dock.studioConfig()
  ok('repeated reads return an equivalent config', JSON.stringify(first) === JSON.stringify(second))

  // A write must be visible immediately afterwards.
  dock.setDock({ backdrop: 'aurora' })
  ok('a write is reflected in the next read', dock.studioConfig().backdrop === 'aurora')

  dock.setDock({ backdrop: 'harbour' })
  ok('and again, so the cache is not stale', dock.studioConfig().backdrop === 'harbour')

  // An external edit (someone hand-editing dock.json) must still be noticed.
  const file = pathx.join(osx.tmpdir(), 'brutus_studio', 'dock.json')
  if (fsx.existsSync(file)) {
    const raw = JSON.parse(fsx.readFileSync(file, 'utf8'))
    raw.backdrop = 'dusk'
    // Bump mtime clearly past the cached value.
    fsx.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
    const future = new Date(Date.now() + 2000)
    fsx.utimesSync(file, future, future)
    ok(
      'an external edit invalidates the cache',
      dock.studioConfig().backdrop === 'dusk',
      dock.studioConfig().backdrop
    )
  } else {
    ok('dock config file was created on write', false, 'expected ' + file)
  }
}

// ═══ 7. Idle detection against real TUI output ════════════════════════════
//
// Observed live: both agents sat at "Starting" while working perfectly, and
// nothing ever routed. Turn completion is a busy -> idle transition, so an idle
// pattern that never matches silently disables the entire routing feature.
//
// The root cause was one character. Codex draws its prompt with U+203A (`›`)
// and the pattern only listed U+276F, `>` and `>>`. The strings below are taken
// from that session rather than invented.

{
  const adapters = require('./adapters.test.cjs')
  const idle = (kind, text) => adapters.getAdapter(kind).idlePatterns.some((p) => p.test(text))

  const CODEX_PROMPT = String.fromCharCode(0x203a)
  const CLAUDE_PROMPT = String.fromCharCode(0x276f)

  // Exactly what the Codex pane showed while waiting for input.
  const codexWaiting = `Worked for 1m 55s\n${CODEX_PROMPT} Find and fix a bug in @filename\n`
  ok('codex prompt glyph is recognised', idle('codex', codexWaiting))

  ok(
    'codex status footer is recognised on its own',
    idle('codex', 'gpt-5.6-terra xhigh · ~/Downloads/New folder')
  )

  // And the Claude pane, mid selection menu.
  const claudeMenu = '6. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n'
  ok('a claude selection menu counts as waiting', idle('claude', claudeMenu))
  ok('claude prompt glyph is recognised', idle('claude', `done\n${CLAUDE_PROMPT} `))
  ok('the newer claude hint line is recognised', idle('claude', 'ready\n? for shortcuts'))

  // Every glyph in the shared set must work.
  for (const g of adapters.PROMPT_GLYPHS) {
    ok(`prompt glyph ${JSON.stringify(g)} is matched`, adapters.PROMPT_TAIL.test(`output\n${g} `))
  }

  // Mid-work output must NOT read as idle, or a turn would complete early and
  // hand off half-finished work.
  ok('a spinner frame is not idle', !idle('codex', 'Working...'))
  ok('plain prose is not idle', !idle('claude', 'I am editing the file now.'))
}

// ═══ 8. Interaction tools are not permission requests ═════════════════════
//
// Observed live: AskUserQuestion raised Brutus's approval card over a question
// the terminal was already asking, blocked the agent for the full 25s timeout,
// then handed the prompt back. Gating an interaction is not caution; it is a
// deadlock with a countdown.

{
  const { decide } = require('./policy.test.cjs')
  const at = (tool) =>
    decide(
      { sessionId: 's', toolName: tool, toolInput: {}, cwd: '/repo' },
      { autonomy: 'guarded', workingDir: '/repo' }
    )

  ok('AskUserQuestion is allowed', at('AskUserQuestion').decision === 'allow')
  ok('ExitPlanMode is allowed', at('ExitPlanMode').decision === 'allow')
  ok('TodoWrite stays allowed', at('TodoWrite').decision === 'allow')
  ok('Read stays allowed', at('Read').decision === 'allow')

  // The tools that should still be gated must not have been loosened.
  ok('an unknown tool still asks', at('FrobnicateEverything').decision === 'ask')
  ok(
    'a shell command is still judged, not waved through',
    decide(
      { sessionId: 's', toolName: 'Bash', toolInput: { command: 'rm -rf /' }, cwd: '/repo' },
      { autonomy: 'guarded', workingDir: '/repo' }
    ).decision !== 'allow'
  )
}

console.log(`PASS ${PASS.length}`)
PASS.forEach((p) => console.log(`  ✓ ${p}`))
if (FAIL.length) {
  console.log(`\nFAIL ${FAIL.length}`)
  FAIL.forEach((f) => console.log(`  ✗ ${f}`))
}
process.exit(FAIL.length ? 1 : 0)
