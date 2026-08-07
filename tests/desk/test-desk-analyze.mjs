/**
 * Desk analysis — parsing what the model actually returns.
 *
 * ── WHY THIS IS NOT PARANOIA ───────────────────────────────────────────────
 * A model asked for JSON returns JSON most of the time. The rest of the time it
 * returns a ```json fence, prose wrapped around the object, a trailing comma,
 * or `"confidence": "high"` where a number was specified. Every one of those
 * appears here because every one of them happens.
 *
 * The rule that matters: **an unparseable response must never become a
 * confident action.** It has to degrade to zero confidence, which the rails
 * then turn into a draft for a human. A parser that guessed 0.9 on malformed
 * input would send email based on nothing.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const {
  extractJson,
  toConfidence,
  parseTriage,
  parseCommitments,
  threadToPrompt,
  cleanDraft,
  triageThread,
  extractCommitments,
  UNKNOWN_TRIAGE
} = require('./analyze.test.cjs')

// ═══ 1. Getting JSON out of a model response ══════════════════════════════

{
  ok('parses a bare object', extractJson('{"a":1}')?.a === 1)
  ok('parses a bare array', Array.isArray(extractJson('[1,2]')))
  ok(
    'parses a ```json fence',
    extractJson('Here you go:\n```json\n{"a":2}\n```\nHope that helps')?.a === 2
  )
  ok('parses an unlabelled fence', extractJson('```\n{"a":3}\n```')?.a === 3)
  ok('parses an object buried in prose', extractJson('Sure! {"a":4} — done.')?.a === 4)
  ok('tolerates a trailing comma', extractJson('{"a":5,}')?.a === 5)
  ok('tolerates a trailing comma in an array', Array.isArray(extractJson('[1,2,]')))
}

for (const [label, input] of [
  ['empty string', ''],
  ['null', null],
  ['undefined', undefined],
  ['pure prose', 'I think this needs a reply, honestly.'],
  ['broken json', '{"a": }'],
  ['just a brace', '{']
]) {
  ok(`returns null for ${label} rather than throwing`, extractJson(input) === null)
}

// ═══ 2. Confidence coercion — the safety-critical direction ═══════════════

{
  ok('passes a normal 0-1 value', toConfidence(0.85) === 0.85)
  ok('rescales a percentage', toConfidence(85) === 0.85)
  ok('clamps above 1', toConfidence(5) === 0.05 || toConfidence(5) <= 1)
  ok('clamps negatives to 0', toConfidence(-3) === 0)
  ok('maps "high"', toConfidence('high') === 0.9)
  ok('maps "medium"', toConfidence('medium') === 0.6)
  ok('maps "low"', toConfidence('low') === 0.3)
  ok('parses a numeric string', toConfidence('0.7') === 0.7)
}

for (const [label, input] of [
  ['undefined', undefined],
  ['null', null],
  ['an object', {}],
  ['gibberish', 'quite sure probably'],
  ['empty string', '']
]) {
  ok(
    `unrecognised confidence (${label}) becomes 0, not high`,
    toConfidence(input) === 0,
    'anything else would let malformed output produce a real email'
  )
}

// ═══ 3. Triage parsing ════════════════════════════════════════════════════

{
  const t = parseTriage('{"category":"needs-reply","priority":1,"reason":"Asked for a quote","confidence":0.9}')
  ok('reads the category', t.category === 'needs-reply')
  ok('reads the priority', t.priority === 1)
  ok('reads the reason', t.reason === 'Asked for a quote')
  ok('reads the confidence', t.confidence === 0.9)
}

ok('accepts fyi', parseTriage('{"category":"fyi","confidence":0.8}').category === 'fyi')
ok('accepts ignore', parseTriage('{"category":"ignore","confidence":0.8}').category === 'ignore')

for (const [label, raw] of [
  ['empty', ''],
  ['prose only', 'This one seems important to me'],
  ['broken json', '{"category":'],
  ['missing category', '{"confidence":0.9}'],
  ['unknown category', '{"category":"maybe","confidence":0.99}']
]) {
  const t = parseTriage(raw)
  ok(`${label} → zero confidence`, t.confidence === 0, `got ${t.confidence}`)
  ok(
    `${label} → routed to a human, not dropped`,
    t.category === 'needs-reply',
    'silently classifying an unreadable thread as "ignore" would lose real mail'
  )
}

{
  const t = parseTriage('{"category":"needs-reply","priority":9,"confidence":0.9}')
  ok('an out-of-range priority falls back to 3', t.priority === 3)
  ok('a missing reason still yields text', t.reason.length > 0)
}

ok('the unknown fallback is itself zero-confidence', UNKNOWN_TRIAGE.confidence === 0)

// ═══ 4. Commitment parsing ════════════════════════════════════════════════

{
  const list = parseCommitments(
    '[{"text":"Send the quote","owedBy":"us","due":"2026-08-10"},{"text":"Pay invoice 12","owedBy":"them","due":null}]',
    { threadId: 't1', contact: 'ravi@client.com', now: 1000 }
  )
  ok('parses both entries', list.length === 2)
  ok('keeps the text', list[0].text === 'Send the quote')
  ok('reads owedBy us', list[0].owedBy === 'us')
  ok('reads owedBy them', list[1].owedBy === 'them')
  ok('parses a due date', list[0].dueAt === Date.parse('2026-08-10'))
  ok('accepts a null due date', list[1].dueAt === null)
  ok('carries the thread context', list[0].threadId === 't1' && list[0].contact === 'ravi@client.com')
  ok('gives every entry a distinct id', list[0].id !== list[1].id)
}

for (const [label, raw] of [
  ['empty', ''],
  ['an empty array', '[]'],
  ['an object rather than an array', '{"text":"x"}'],
  ['prose', 'They promised to pay soon'],
  ['broken', '[{"text":']
]) {
  ok(`${label} yields no commitments`, parseCommitments(raw).length === 0)
}

{
  const list = parseCommitments('[{"text":"  ","owedBy":"us"},{"text":"Real one","owedBy":"???"}]')
  ok('entries with no text are dropped', list.length === 1)
  ok(
    'an unrecognised owedBy defaults to us',
    list[0].owedBy === 'us',
    'defaulting to "them" would mean chasing a client over something they never agreed to'
  )
}

{
  // A single-element array is the common "one commitment found" case, and the
  // one a naive brace-first extractor silently turns into a bare object.
  const single = parseCommitments('[{"text":"Send the quote","owedBy":"us","due":null}]')
  ok('a SINGLE-element array parses', single.length === 1, `got ${single.length}`)
  ok('its fields survive', single[0]?.text === 'Send the quote')

  const vague = parseCommitments('[{"text":"x","due":"next Thursdayish"}]')
  ok('an unparseable due date becomes null, not NaN', vague[0]?.dueAt === null)
}

// ═══ 5. Thread rendering ══════════════════════════════════════════════════

{
  const messages = [
    { from: 'a@x.com', date: 1000, body: 'First message', subject: 'S' },
    { from: 'b@x.com', date: 2000, body: 'Second message', subject: 'S' }
  ]
  const prompt = threadToPrompt(messages)
  ok('includes every message', prompt.includes('First message') && prompt.includes('Second message'))
  ok('preserves order', prompt.indexOf('First') < prompt.indexOf('Second'))
  ok('labels the sender', prompt.includes('From: a@x.com'))
}

{
  // Truncation keeps the TAIL: the newest message is what a decision hinges on.
  const long = [{ from: 'a@x.com', date: 1, body: 'x'.repeat(500) + 'ENDMARKER', subject: 'S' }]
  const prompt = threadToPrompt(long, 200)
  ok('long threads are truncated', prompt.length < 400)
  ok('truncation keeps the newest content', prompt.includes('ENDMARKER'))
}

ok('an empty thread renders to an empty string', threadToPrompt([]) === '')

// ═══ 6. Draft cleaning ════════════════════════════════════════════════════

{
  ok('strips a code fence', !cleanDraft('```\nhello\n```').includes('```'))
  ok('strips a subject line', !cleanDraft('Subject: Re: x\n\nHello there').toLowerCase().includes('subject:'))
  ok('keeps a greeting', cleanDraft('Hi Ravi,\n\nAll set.').includes('Hi Ravi'))
  ok('trims surrounding whitespace', cleanDraft('   hello   ') === 'hello')
  ok('handles empty input', cleanDraft('') === '')
  ok('handles null input', cleanDraft(null) === '')
}

// ═══ 7. The seam degrades safely ══════════════════════════════════════════
//
// The model is a network call. When it fails, a background run must continue —
// and must not produce a confident result.

{
  const boom = async () => {
    throw new Error('model unavailable')
  }
  const t = await triageThread([{ from: 'a', date: 1, body: 'x', subject: 's' }], boom)
  ok('a model failure yields zero confidence', t.confidence === 0)
  ok('a model failure still returns a usable result', t.category === 'needs-reply')

  const c = await extractCommitments([{ from: 'a', date: 1, body: 'x', subject: 's' }], boom)
  ok('a model failure yields no commitments rather than throwing', Array.isArray(c) && c.length === 0)
}

{
  const empty = async () => ''
  const t = await triageThread([], empty)
  ok('an empty thread is not triaged confidently', t.confidence === 0)
}

// ═══ Report ═══════════════════════════════════════════════════════════════

for (const name of PASS) console.log(`  ✓ ${name}`)
for (const name of FAIL) console.error(`  ✗ ${name}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exitCode = FAIL.length ? 1 : 0
