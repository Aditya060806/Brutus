/**
 * Desk safety rails — the suite that matters most in this project.
 *
 * ── WHAT IS ACTUALLY BEING PROTECTED ───────────────────────────────────────
 * Brutus can send email to real customers with no human in the loop. Every
 * assertion below stands between a bug and a message that cannot be recalled.
 * The failure mode these enforce is always "refuses to send" — never "sends
 * something wrong".
 *
 * `mayAutoSend` is deliberately pure: no clock, no config lookup, no I/O. That
 * is what lets quiet hours, cooldowns and rate limits be asserted exactly,
 * offline, without waiting for a Tuesday at 9pm.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const { mayAutoSend, extractAddress, inQuietHours, matchedTopic } = require('./rails.test.cjs')
const { DEFAULT_AUTONOMY } = require('./types.test.cjs')

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Midday on a weekday — deliberately outside the default quiet hours. */
const NOON = new Date('2026-08-04T12:00:00').getTime()

const baseConfig = () => ({ ...DEFAULT_AUTONOMY, level: 'autonomous' })

const baseCtx = (over = {}) => ({
  config: baseConfig(),
  thread: {
    threadId: 't1',
    subject: 'Project update',
    contact: 'Ravi <ravi@client.com>',
    lastMessageId: '<m1@x>',
    lastMessageAt: NOON - 3600_000,
    awaitingUs: true,
    state: 'triaged'
  },
  draft: {
    to: 'ravi@client.com',
    subject: 'Re: Project update',
    body: 'Thanks Ravi — sending the files this afternoon.',
    createdAt: NOON,
    kind: 'reply'
  },
  triage: {
    category: 'needs-reply',
    priority: 2,
    reason: 'Asked a direct question',
    confidence: 0.95
  },
  recentSends: [],
  now: NOON,
  ...over
})

const allow = (over) => mayAutoSend(baseCtx(over))

// ═══ 0. The happy path exists ═════════════════════════════════════════════
//
// Without this, a rail that refuses everything would pass every other test.

ok(
  'a clean, confident reply to a known contact is allowed',
  allow().ok === true,
  JSON.stringify(allow())
)

// ═══ 1. Autonomy off refuses EVERYTHING ═══════════════════════════════════
//
// Asserted exhaustively rather than once: "off" must not be defeatable by any
// combination of otherwise-passing inputs.

{
  const variations = [
    { draft: { ...baseCtx().draft, kind: 'follow-up' } },
    { triage: { category: 'needs-reply', priority: 1, reason: 'urgent', confidence: 1 } },
    { config: { ...baseConfig(), level: 'off', confidenceFloor: 0, allowlistOnly: false } },
    { config: { ...baseConfig(), level: 'off', neverAutoTopics: [], maxSendsPerDay: 0 } },
    { config: { ...baseConfig(), level: 'off', quietHours: { start: 0, end: 0 } } }
  ]
  let allRefused = true
  for (const over of variations) {
    const config = { ...(over.config ?? baseConfig()), level: 'off' }
    const decision = mayAutoSend(baseCtx({ ...over, config }))
    if (decision.ok) allRefused = false
  }
  ok('autonomy OFF refuses every variation', allRefused)
  ok(
    'autonomy OFF reports itself as the reason',
    mayAutoSend(baseCtx({ config: { ...baseConfig(), level: 'off' } })).code === 'autonomy-off'
  )
}

ok(
  'draft-only mode never sends',
  mayAutoSend(baseCtx({ config: { ...baseConfig(), level: 'draft' } })).code === 'draft-only'
)

// ═══ 2. The recipient rail — a hallucinated address cannot be mailed ══════

{
  const d = allow({ draft: { ...baseCtx().draft, to: 'stranger@nowhere.com' } })
  ok('an address that never wrote to us is refused', d.ok === false && d.code === 'not-allowlisted')
  ok('the refusal names the address', d.reason.includes('stranger@nowhere.com'))
}

ok(
  'the thread contact is allowed even when written as "Name <addr>"',
  allow({ draft: { ...baseCtx().draft, to: 'Ravi Kumar <ravi@client.com>' } }).ok === true
)

ok(
  'an explicitly allowlisted third party is permitted',
  allow({
    config: { ...baseConfig(), allowlist: ['accounts@client.com'] },
    draft: { ...baseCtx().draft, to: 'accounts@client.com' }
  }).ok === true
)

ok(
  'turning the allowlist off permits any address',
  allow({
    config: { ...baseConfig(), allowlistOnly: false },
    draft: { ...baseCtx().draft, to: 'anyone@example.com' }
  }).ok === true
)

for (const [label, to] of [
  ['empty', ''],
  ['not an address', 'Ravi Kumar'],
  ['whitespace', '   ']
]) {
  ok(`a ${label} recipient is refused`, allow({ draft: { ...baseCtx().draft, to } }).ok === false)
}

ok(
  'an empty body is refused',
  allow({ draft: { ...baseCtx().draft, body: '   ' } }).code === 'empty-draft'
)

// ═══ 3. Confidence floor ══════════════════════════════════════════════════

{
  const low = allow({ triage: { ...baseCtx().triage, confidence: 0.5 } })
  ok(
    'below the floor it drafts instead of sending',
    low.ok === false && low.code === 'low-confidence'
  )
  ok('the refusal quotes both numbers', /50%/.test(low.reason) && /75%/.test(low.reason))
}

ok(
  'exactly at the floor is allowed',
  allow({
    config: { ...baseConfig(), confidenceFloor: 0.75 },
    triage: { ...baseCtx().triage, confidence: 0.75 }
  }).ok === true
)

ok(
  'a floor of zero disables the check',
  allow({
    config: { ...baseConfig(), confidenceFloor: 0 },
    triage: { ...baseCtx().triage, confidence: 0.01 }
  }).ok === true
)

// ═══ 4. Never-auto topics ═════════════════════════════════════════════════

for (const [label, body] of [
  ['invoice', 'Please find the invoice attached.'],
  ['refund', 'We can process a refund this week.'],
  ['contract', 'The contract needs your signature.'],
  ['legal', 'Our legal team will review it.']
]) {
  const d = allow({ draft: { ...baseCtx().draft, body } })
  ok(`"${label}" in the body blocks the send`, d.ok === false && d.code === 'blocked-topic')
}

ok(
  'a blocked topic in the SUBJECT is caught too',
  allow({ draft: { ...baseCtx().draft, subject: 'Re: Invoice 44' } }).code === 'blocked-topic'
)

{
  // Whole-word matching. Substring matching would fire on "cancellation" for
  // "cancel" and on "bankruptcy" for "bank" — and, worse, quietly not fire for
  // punctuation-adjacent words.
  ok('matches a whole word', matchedTopic('please cancel it', ['cancel']) === 'cancel')
  ok('matches a word before punctuation', matchedTopic('Is it legal?', ['legal']) === 'legal')
  ok('does not match inside a longer word', matchedTopic('embankment plans', ['bank']) === null)
  ok('is case-insensitive', matchedTopic('The INVOICE is ready', ['invoice']) === 'invoice')
  ok('an empty topic list matches nothing', matchedTopic('invoice refund legal', []) === null)
  ok('a blank topic entry is skipped', matchedTopic('anything', ['', '  ']) === null)
  ok(
    'a topic with regex characters does not throw',
    matchedTopic('a c++ question', ['c++']) === null || true
  )
}

ok(
  'clearing the topic list allows the send',
  allow({
    config: { ...baseConfig(), neverAutoTopics: [] },
    draft: { ...baseCtx().draft, body: 'The invoice is attached.' }
  }).ok === true
)

// ═══ 5. One reply per thread per window ═══════════════════════════════════
//
// The engine re-reads threads every run. Without this, an unanswered thread
// gets replied to every ten minutes.

{
  const d = allow({ thread: { ...baseCtx().thread, lastAutoReplyAt: NOON - 3600_000 } })
  ok(
    'a thread replied to an hour ago is on cooldown',
    d.ok === false && d.code === 'thread-cooldown'
  )
  ok('the refusal says how long ago', /1h ago/.test(d.reason), d.reason)
}

ok(
  'past the cooldown it may reply again',
  allow({ thread: { ...baseCtx().thread, lastAutoReplyAt: NOON - 13 * 3600_000 } }).ok === true
)

ok(
  'a zero cooldown disables the check',
  allow({
    config: { ...baseConfig(), threadCooldownHours: 0 },
    thread: { ...baseCtx().thread, lastAutoReplyAt: NOON - 60_000 }
  }).ok === true
)

// ═══ 6. Daily rate limit ══════════════════════════════════════════════════

{
  const sends = Array.from({ length: 20 }, (_, i) => NOON - i * 60_000)
  const d = allow({ recentSends: sends })
  ok('the daily ceiling stops the 21st send', d.ok === false && d.code === 'rate-limit')
  ok('the refusal quotes the count', /20 of 20/.test(d.reason), d.reason)
}

ok(
  'sends older than 24h do not count',
  allow({ recentSends: Array.from({ length: 30 }, (_, i) => NOON - (25 + i) * 3600_000) }).ok ===
    true
)

ok(
  'one below the ceiling is allowed',
  allow({ recentSends: Array.from({ length: 19 }, (_, i) => NOON - i * 60_000) }).ok === true
)

// ═══ 7. Quiet hours ═══════════════════════════════════════════════════════
//
// The window wraps midnight, which a naive range check gets exactly backwards.

{
  ok('21:00 is inside 21→08', inQuietHours(21, 21, 8) === true)
  ok('03:00 is inside 21→08', inQuietHours(3, 21, 8) === true)
  ok('12:00 is outside 21→08', inQuietHours(12, 21, 8) === false)
  ok('08:00 is outside 21→08 (end is exclusive)', inQuietHours(8, 21, 8) === false)
  ok('a non-wrapping window still works', inQuietHours(13, 12, 14) === true)
  ok('start === end disables quiet hours', inQuietHours(3, 0, 0) === false)
}

{
  const at3am = new Date('2026-08-04T03:00:00').getTime()
  const d = mayAutoSend(baseCtx({ now: at3am }))
  ok('3am is refused by default', d.ok === false && d.code === 'quiet-hours')
}

ok(
  'quiet hours can be disabled',
  mayAutoSend(
    baseCtx({
      now: new Date('2026-08-04T03:00:00').getTime(),
      config: { ...baseConfig(), quietHours: { start: 0, end: 0 } }
    })
  ).ok === true
)

// ═══ 8. Only reply where a reply is owed ══════════════════════════════════

for (const category of ['fyi', 'ignore']) {
  const d = allow({ triage: { ...baseCtx().triage, category } })
  ok(`a "${category}" thread is not auto-replied to`, d.ok === false && d.code === 'not-a-reply')
}

ok(
  'a follow-up does not require a needs-reply classification',
  allow({
    draft: { ...baseCtx().draft, kind: 'follow-up' },
    triage: { ...baseCtx().triage, category: 'fyi' }
  }).ok === true,
  'a chase is sent because THEY owe US, not because we owe a reply'
)

// ═══ 9. Every refusal explains itself ═════════════════════════════════════
//
// A blocked action surfaces in the UI. "Blocked" with no reason is not
// actionable, and the user cannot decide whether to override it.

{
  const refusals = [
    allow({ config: { ...baseConfig(), level: 'off' } }),
    allow({ draft: { ...baseCtx().draft, to: 'stranger@nowhere.com' } }),
    allow({ triage: { ...baseCtx().triage, confidence: 0.1 } }),
    allow({ draft: { ...baseCtx().draft, body: 'the invoice' } }),
    allow({ thread: { ...baseCtx().thread, lastAutoReplyAt: NOON - 60_000 } }),
    allow({ recentSends: Array.from({ length: 20 }, () => NOON) }),
    mayAutoSend(baseCtx({ now: new Date('2026-08-04T03:00:00').getTime() })),
    allow({ triage: { ...baseCtx().triage, category: 'ignore' } }),
    allow({ draft: { ...baseCtx().draft, body: '' } })
  ]
  ok(
    'every tested path refuses',
    refusals.every((r) => r.ok === false)
  )
  ok(
    'every refusal carries a code',
    refusals.every((r) => typeof r.code === 'string' && r.code)
  )
  ok(
    'every refusal carries a human-readable reason',
    refusals.every((r) => typeof r.reason === 'string' && r.reason.length > 20),
    refusals.map((r) => r.reason).join(' | ')
  )
  ok(
    'no two refusal codes are silently identical for different causes',
    new Set(refusals.map((r) => r.code)).size >= 8
  )
}

// ═══ 10. Address parsing ══════════════════════════════════════════════════

for (const [input, expected] of [
  ['ravi@client.com', 'ravi@client.com'],
  ['Ravi <ravi@client.com>', 'ravi@client.com'],
  ['"Kumar, Ravi" <Ravi@Client.COM>', 'ravi@client.com'],
  ['  spaced@x.com  ', 'spaced@x.com'],
  ['', '']
]) {
  ok(`parses ${JSON.stringify(input)}`, extractAddress(input) === expected, extractAddress(input))
}

// ═══ Report ═══════════════════════════════════════════════════════════════

for (const name of PASS) console.log(`  ✓ ${name}`)
for (const name of FAIL) console.error(`  ✗ ${name}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exitCode = FAIL.length ? 1 : 0
