/**
 * Desk store — persistence, and the ways it must not lose data.
 *
 * ── WHY ATOMICITY IS NOT PEDANTRY HERE ─────────────────────────────────────
 * This ledger records what Brutus sent on your behalf, and the dedupe rail
 * reads it. A truncated write is not merely "lost history": if the record of a
 * sent reply disappears, `lastAutoReplyAt` disappears with it, the cooldown
 * rail sees a thread that was never answered, and Brutus sends the same email
 * to the same client again. Corruption here becomes a duplicate message in
 * someone's inbox.
 *
 * Runs against a real temp directory — no mocked filesystem, per this project's
 * rule of not mocking the dangerous thing.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const store = require('./store.test.cjs')

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brutus-desk-test-'))
store.configureStore(DIR)

const fileFor = (name) => path.join(DIR, `${name}.json`)

// ═══ 1. Round-trip ════════════════════════════════════════════════════════

{
  store.writeJson('probe', { hello: 'world', n: 42 })
  const back = store.readJson('probe', null)
  ok('writes and reads back', back?.hello === 'world' && back?.n === 42)
  ok('the file really exists on disk', fs.existsSync(fileFor('probe')))
  ok('it is human-readable JSON', fs.readFileSync(fileFor('probe'), 'utf-8').includes('\n'))
}

// ═══ 2. Degrading instead of throwing ═════════════════════════════════════

ok(
  'a missing file returns the fallback',
  store.readJson('does-not-exist', 'fallback') === 'fallback'
)

{
  fs.writeFileSync(fileFor('corrupt'), '{"half":')
  ok(
    'a corrupt file returns the fallback rather than throwing',
    store.readJson('corrupt', 'safe') === 'safe',
    'a parse error here would take down the engine run or the settings panel'
  )
}

{
  fs.writeFileSync(fileFor('empty'), '')
  ok('an empty file returns the fallback', store.readJson('empty', 'safe') === 'safe')
}

{
  fs.writeFileSync(fileFor('nulled'), 'null')
  ok('a literal null returns the fallback', store.readJson('nulled', 'safe') === 'safe')
}

// ═══ 3. Atomic writes ═════════════════════════════════════════════════════

{
  store.writeJson('atomic', { v: 1 })
  store.writeJson('atomic', { v: 2 })
  ok('a rewrite fully replaces the previous contents', store.readJson('atomic', null)?.v === 2)

  const leftovers = fs.readdirSync(DIR).filter((f) => f.endsWith('.tmp'))
  ok('no .tmp files are left behind', leftovers.length === 0, `found: ${leftovers.join(', ')}`)
}

{
  // A partially-written file must never be readable as valid-but-truncated.
  // The temp+rename means a reader sees the OLD file until the new one is whole.
  store.writeJson('big', {
    rows: Array.from({ length: 2000 }, (_, i) => ({ i, pad: 'x'.repeat(50) }))
  })
  const read = store.readJson('big', { rows: [] })
  ok('a large write round-trips completely', read.rows.length === 2000)
  ok('the last row survived', read.rows[1999].i === 1999)
}

// ═══ 4. Config merges forward ═════════════════════════════════════════════

{
  const fresh = store.getConfig()
  ok('a fresh config has the shipped default', fresh.level === 'off')
  ok('autonomy ships OFF', fresh.level !== 'autonomous', 'this app is distributed to other people')
  ok('it has a confidence floor', typeof fresh.confidenceFloor === 'number')
  ok('the allowlist is on by default', fresh.allowlistOnly === true)

  // A config written by an older build must gain new keys rather than arriving
  // with `undefined` where a rail expects a number.
  fs.writeFileSync(fileFor('config'), JSON.stringify({ level: 'autonomous' }))
  const merged = store.getConfig()
  ok('a partial config keeps the stored value', merged.level === 'autonomous')
  ok('a partial config gains missing defaults', typeof merged.maxSendsPerDay === 'number')
  ok(
    'no key is undefined after the merge',
    Object.values(merged).every((v) => v !== undefined)
  )

  store.setConfig({ level: 'off' })
  ok('setConfig persists', store.getConfig().level === 'off')
}

// ═══ 5. Threads ═══════════════════════════════════════════════════════════

{
  const t = {
    threadId: 't1',
    subject: 'Hi',
    contact: 'a@b.com',
    lastMessageId: '<m1>',
    lastMessageAt: 1,
    awaitingUs: true,
    state: 'new'
  }
  store.upsertThread(t)
  ok('a thread is stored', store.getThreads().length === 1)

  store.upsertThread({ ...t, state: 'handled' })
  ok('upsert updates rather than duplicating', store.getThreads().length === 1)
  ok('the update took effect', store.getThread('t1')?.state === 'handled')
  ok('an unknown thread id is undefined', store.getThread('nope') === undefined)

  store.upsertThread({ ...t, threadId: 't2' })
  ok('a second thread is appended', store.getThreads().length === 2)
}

// ═══ 6. Commitments, and not repeating them ═══════════════════════════════

{
  const base = {
    id: 'c1',
    text: 'Send the quote',
    owedBy: 'us',
    dueAt: null,
    threadId: 't1',
    createdAt: 1
  }
  store.addCommitment(base)
  ok('a commitment is stored', store.getCommitments().length === 1)

  // The engine re-reads threads on every run. Without dedupe the same sentence
  // is added every ten minutes.
  store.addCommitment({ ...base, id: 'c2' })
  ok('the same promise on the same thread is not added twice', store.getCommitments().length === 1)

  store.addCommitment({ ...base, id: 'c3', text: 'SEND THE QUOTE' })
  ok('dedupe ignores case and spacing', store.getCommitments().length === 1)

  store.addCommitment({ ...base, id: 'c4', threadId: 't2' })
  ok(
    'the same text on a DIFFERENT thread is a separate promise',
    store.getCommitments().length === 2
  )

  store.addCommitment({ ...base, id: 'c5', dueAt: 999 })
  ok('the same text with a different due date is separate', store.getCommitments().length === 3)
}

// ═══ 7. Legacy migration ══════════════════════════════════════════════════
//
// `save_commitment` has been writing {text, due} for a while. Those are real
// promises; the Desk adopts them rather than showing a different answer.

{
  store.setCommitments([])
  const legacyPath = path.join(DIR, 'legacy-commitments.json')
  fs.writeFileSync(
    legacyPath,
    JSON.stringify([
      { text: 'Call the accountant', due: '2026-09-01' },
      { text: 'Renew the domain', due: null },
      { text: '   ' },
      { notText: 'junk' }
    ])
  )

  const imported = store.migrateLegacyCommitments(legacyPath)
  ok('valid legacy entries are imported', imported === 2, `imported ${imported}`)
  ok('blank and malformed entries are skipped', store.getCommitments().length === 2)
  ok('a legacy due date is parsed', store.getCommitments()[0].dueAt === Date.parse('2026-09-01'))
  ok('a missing due date becomes null', store.getCommitments()[1].dueAt === null)
  ok(
    'imported entries are tagged legacy',
    store.getCommitments().every((c) => c.legacy === true)
  )

  ok(
    'running the migration again imports nothing',
    store.migrateLegacyCommitments(legacyPath) === 0
  )
  ok('and does not duplicate', store.getCommitments().length === 2)

  ok(
    'a missing legacy file imports nothing',
    store.migrateLegacyCommitments(path.join(DIR, 'nope.json')) === 0
  )

  fs.writeFileSync(path.join(DIR, 'bad-legacy.json'), 'not json')
  ok(
    'a corrupt legacy file imports nothing rather than throwing',
    store.migrateLegacyCommitments(path.join(DIR, 'bad-legacy.json')) === 0
  )
}

// ═══ 8. Audit log ═════════════════════════════════════════════════════════

{
  store.recordAction({ id: 'a1', kind: 'auto-reply', at: 1, reason: 'first' })
  store.recordAction({ id: 'a2', kind: 'blocked', at: 2, reason: 'second' })
  const log = store.getAudit()
  ok('actions are recorded', log.length === 2)
  ok('newest is first', log[0].id === 'a2')

  for (let i = 0; i < 600; i++) {
    store.recordAction({ id: `bulk${i}`, kind: 'triaged', at: i, reason: 'x' })
  }
  ok('the log is bounded', store.getAudit().length === 500)
  ok('the bound keeps the NEWEST entries', store.getAudit()[0].id === 'bulk599')
}

// ═══ 9. Send-rate bookkeeping ═════════════════════════════════════════════

{
  store.setEngineState({ recentSends: [] })
  const now = Date.now()

  store.noteSend(now)
  store.noteSend(now)
  ok('sends are counted', store.recentSendsWithin(24, now).length === 2)

  store.setEngineState({ recentSends: [now - 25 * 3600_000, now - 1000] })
  ok(
    'sends older than the window are excluded',
    store.recentSendsWithin(24, now).length === 1,
    'otherwise the daily limit would never reset'
  )

  store.noteSend(now)
  ok('noteSend prunes stale entries as it appends', store.getEngineState().recentSends.length === 2)
}

// ═══ Cleanup ══════════════════════════════════════════════════════════════

try {
  fs.rmSync(DIR, { recursive: true, force: true })
} catch {
  /* a leftover temp dir is not a test failure */
}

for (const name of PASS) console.log(`  ✓ ${name}`)
for (const name of FAIL) console.error(`  ✗ ${name}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exitCode = FAIL.length ? 1 : 0
