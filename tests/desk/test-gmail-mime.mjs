/**
 * Gmail wire-format tests: what actually reaches the recipient.
 *
 * ── WHY THESE MATTER MORE NOW ──────────────────────────────────────────────
 * Brutus is about to send email on its own. Every defect here lands in a
 * customer's inbox, is invisible from this side, and cannot be recalled:
 *
 *   • **Charset.** With no `Content-Type`, clients assume US-ASCII. An invoice
 *     for ₹45,000 arrives as mojibake — and the sender never sees it, because
 *     their own copy in Sent renders from the same broken bytes only if the
 *     client happens to guess right.
 *   • **Header encoding.** Non-ASCII in a header is invalid per RFC 5322.
 *   • **Threading.** Without `In-Reply-To`/`References`, a follow-up starts a
 *     NEW thread. To the client it reads as a cold email rather than a chase,
 *     which is precisely the wrong impression.
 *
 * The message is base64url, so every assertion decodes it and inspects the real
 * headers rather than trusting the builder's inputs.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const { makeEmail, encodeHeader, header } = require('./gmail-mime.test.cjs')

/** base64url → the raw RFC 5322 message. */
const decode = (raw) =>
  Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')

const headersOf = (raw) => decode(raw).split('\r\n\r\n')[0]
const bodyOf = (raw) => decode(raw).split('\r\n\r\n').slice(1).join('\r\n\r\n')

// ═══ 1. base64url ═════════════════════════════════════════════════════════

{
  const raw = makeEmail({ to: 'a@b.com', subject: 'Hi', body: 'Hello' })
  ok('output is base64url, not standard base64', !/[+/=]/.test(raw))
  ok('it decodes back to a message', decode(raw).includes('To: a@b.com'))
}

// ═══ 2. MIME headers ══════════════════════════════════════════════════════

{
  const h = headersOf(makeEmail({ to: 'a@b.com', subject: 'Hi', body: 'Hello' }))
  ok('declares MIME-Version', /^MIME-Version: 1\.0$/m.test(h))
  ok('declares a UTF-8 charset', /Content-Type: text\/plain; charset="UTF-8"/.test(h))
  ok('declares a transfer encoding', /Content-Transfer-Encoding:/.test(h))
  ok('sets To', /^To: a@b\.com$/m.test(h))
}

{
  // RFC 5322 requires CRLF. The original used bare LF.
  const raw = makeEmail({ to: 'a@b.com', subject: 'Hi', body: 'Line one\nLine two' })
  const message = decode(raw)
  const headerBlock = message.split('\r\n\r\n')[0]
  ok('header lines are CRLF-separated', headerBlock.includes('\r\n'))
  ok('headers and body are separated by a blank CRLF line', message.includes('\r\n\r\n'))
}

// ═══ 3. Non-ASCII — the ₹ case ════════════════════════════════════════════

{
  ok(
    'pure ASCII is left readable, not needlessly encoded',
    encodeHeader('Invoice 4500') === 'Invoice 4500'
  )
  ok('empty stays empty', encodeHeader('') === '')

  const encoded = encodeHeader('Invoice ₹45,000')
  ok('non-ASCII becomes an RFC 2047 encoded-word', /^=\?UTF-8\?B\?.+\?=$/.test(encoded))
  ok(
    'the encoded-word decodes back to the original',
    Buffer.from(encoded.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString(
      'utf-8'
    ) === 'Invoice ₹45,000'
  )
}

for (const [label, subject] of [
  ['rupee', 'Payment due: ₹45,000'],
  ['em dash', 'Follow-up — overdue'],
  ['devanagari', 'नमस्ते'],
  ['emoji', 'Thanks 🙏']
]) {
  const h = headersOf(makeEmail({ to: 'a@b.com', subject, body: 'x' }))
  const line = h.split('\r\n').find((l) => l.startsWith('Subject:'))
  ok(`${label} subject is encoded, not raw`, /=\?UTF-8\?B\?/.test(line), line)
  // eslint-disable-next-line no-control-regex
  ok(`${label} subject header is pure ASCII on the wire`, /^[\x00-\x7F]*$/.test(line))
}

{
  // The body may carry raw UTF-8 because the charset header declares it.
  const raw = makeEmail({ to: 'a@b.com', subject: 'x', body: 'Total: ₹45,000 — thanks, नमस्ते' })
  ok('the body round-trips non-ASCII intact', bodyOf(raw) === 'Total: ₹45,000 — thanks, नमस्ते')
}

// ═══ 4. Threading — why a follow-up joins the conversation ════════════════

{
  const h = headersOf(makeEmail({ to: 'a@b.com', subject: 'Re: Quote', body: 'x' }))
  ok('a plain message has no In-Reply-To', !/In-Reply-To:/.test(h))
  ok('a plain message has no References', !/References:/.test(h))
}

{
  const h = headersOf(
    makeEmail({
      to: 'a@b.com',
      subject: 'Re: Quote',
      body: 'x',
      inReplyTo: '<msg-2@mail.gmail.com>',
      references: '<msg-1@mail.gmail.com> <msg-2@mail.gmail.com>'
    })
  )
  ok('a reply sets In-Reply-To', /^In-Reply-To: <msg-2@mail\.gmail\.com>$/m.test(h))
  ok(
    'a reply keeps the whole References chain',
    /^References: <msg-1@mail\.gmail\.com> <msg-2@mail\.gmail\.com>$/m.test(h),
    'dropping earlier ids loses the middle of the conversation in some clients'
  )
}

// ═══ 5. Header lookup is case-insensitive ═════════════════════════════════

{
  const hs = [
    { name: 'Message-ID', value: '<a@b>' },
    { name: 'message-id', value: '<lower@b>' },
    { name: 'Subject', value: 'Hello' },
    { name: null, value: 'junk' }
  ]
  ok('finds a header by exact case', header(hs, 'Message-ID') === '<a@b>')
  ok('finds a header by different case', header(hs, 'MESSAGE-ID') === '<a@b>')
  ok('finds a lowercase-declared header', header([hs[1]], 'Message-ID') === '<lower@b>')
  ok('a missing header is an empty string, never undefined', header(hs, 'Nope') === '')
  ok('survives a null header name', header(hs, 'Subject') === 'Hello')
  ok('survives an empty header list', header([], 'Subject') === '')
}

// ═══ Report ═══════════════════════════════════════════════════════════════

for (const name of PASS) console.log(`  ✓ ${name}`)
for (const name of FAIL) console.error(`  ✗ ${name}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exitCode = FAIL.length ? 1 : 0
