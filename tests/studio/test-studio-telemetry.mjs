/**
 * Telemetry: structured events, spans and metrics.
 *
 * The clock is injected, so durations are asserted exactly rather than
 * approximately — a timing test that allows a tolerance is a timing test that
 * passes when the maths is wrong.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const { Telemetry, parseLegacyLine } = require('./telemetry.test.cjs')

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

/** A clock the test drives by hand. */
function fakeClock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

// ═══ 1. Events ════════════════════════════════════════════════════════════

{
  const t = new Telemetry(() => 42)
  t.info('policy', 'allow', 'Allowed git status', { tool: 'Bash' })

  const [e] = t.snapshot()
  ok('an event records its level', e.level === 'info')
  ok('and its scope and name', e.scope === 'policy' && e.event === 'allow')
  ok('and a human message', e.message === 'Allowed git status')
  ok('and structured fields', e.fields?.tool === 'Bash')
  ok('and the injected timestamp', e.ts === 42)
  ok('sequence numbers start at 1', e.seq === 1)
}

{
  const t = new Telemetry()
  t.info('a', 'x', 'one')
  t.warn('b', 'y', 'two')
  const seqs = t.snapshot().map((e) => e.seq)
  ok('sequence numbers increase', seqs.join(',') === '1,2')
  ok('since() returns only what is newer', t.snapshot(1).length === 1)
  ok('and since(latest) returns nothing', t.snapshot(2).length === 0)
}

{
  // The buffer must be bounded, or a long session grows without limit.
  const t = new Telemetry()
  for (let i = 0; i < 700; i++) t.info('bulk', 'tick', `event ${i}`)
  const all = t.snapshot()
  ok('the event log is bounded', all.length <= 500, String(all.length))
  ok('and keeps the newest, not the oldest', all[all.length - 1].message === 'event 699')
}

{
  // A subscriber that throws must not stop the operation being logged, nor the
  // other subscribers.
  const t = new Telemetry()
  const seen = []
  t.onEvent(() => {
    throw new Error('bad sink')
  })
  const off = t.onEvent((e) => seen.push(e.message))
  t.info('scope', 'evt', 'still delivered')
  ok('a throwing sink does not break the stream', seen.join(',') === 'still delivered')

  off()
  t.info('scope', 'evt', 'after unsubscribe')
  ok('unsubscribing stops delivery', seen.length === 1)
}

// ═══ 2. Spans ═════════════════════════════════════════════════════════════

{
  const clock = fakeClock()
  const t = new Telemetry(clock.now)

  const span = t.startSpan('router', 'reframe', { from: 'Apollo' }, 'csc_1')
  clock.advance(250)
  span.end('ok', { chars: 40 })

  const events = t.snapshot()
  const start = events.find((e) => e.event === 'reframe.start')
  const done = events.find((e) => e.event === 'reframe.ok')

  ok('a span opens and closes', !!start && !!done)
  ok('the duration is measured exactly', done.durationMs === 250, String(done.durationMs))
  ok('both ends share a span id', start.spanId === done.spanId)
  ok('and carry the trace id', done.traceId === 'csc_1')
  ok('start fields survive to the end', done.fields?.from === 'Apollo')
  ok('end fields are merged in', done.fields?.chars === 40)
}

{
  const clock = fakeClock()
  const t = new Telemetry(clock.now)
  const span = t.startSpan('git', 'merge')
  clock.advance(10)
  span.fail(new Error('index.lock'))

  const failed = t.snapshot().find((e) => e.event === 'merge.error')
  ok('a failed span is recorded at error level', failed?.level === 'error')
  ok('and carries the reason', String(failed?.fields?.error).includes('index.lock'))
}

{
  // Closing twice must not double-count. A promise that both resolves and
  // rejects is exactly when metrics are easiest to corrupt.
  const clock = fakeClock()
  const t = new Telemetry(clock.now)
  const span = t.startSpan('git', 'merge')
  clock.advance(30)
  span.end('ok')
  clock.advance(500)
  span.end('ok')
  span.fail(new Error('late'))

  const h = t.metrics().durations['git.merge']
  ok('a span is only counted once', h.count === 1, String(h.count))
  ok('and keeps the first duration', h.totalMs === 30, String(h.totalMs))
}

{
  // A non-ok outcome is meaningful, not just "error".
  const t = new Telemetry(fakeClock().now)
  t.startSpan('git', 'merge').end('conflict', { branch: 'brutus/x' })
  const e = t.snapshot().find((x) => x.event === 'merge.conflict')
  ok('a domain-specific outcome is preserved', !!e)
  ok('and recorded at warn, not error', e.level === 'warn')
}

// ═══ 3. Metrics ═══════════════════════════════════════════════════════════

{
  const t = new Telemetry()
  t.observe('router.turn', 100)
  t.observe('router.turn', 300)
  t.observe('router.turn', 200)

  const h = t.metrics().durations['router.turn']
  ok('a histogram counts', h.count === 3)
  ok('sums', h.totalMs === 600)
  ok('tracks the fastest', h.minMs === 100)
  ok('tracks the slowest', h.maxMs === 300)
  ok('and precomputes the mean', h.avgMs === 200)
}

{
  const t = new Telemetry()
  t.info('policy', 'deny', 'no')
  t.info('policy', 'deny', 'no again')
  t.info('policy', 'allow', 'yes')
  const c = t.metrics().counters
  ok('events are counted by scope and name', c['policy.deny'] === 2, JSON.stringify(c))
  ok('separately per name', c['policy.allow'] === 1)
}

{
  const t = new Telemetry()
  t.info('a', 'b', 'c')
  t.observe('x.y', 5)
  t.clear()
  ok('clear empties the event log', t.snapshot().length === 0)
  ok('and the counters', Object.keys(t.metrics().counters).length === 0)
  ok('and the histograms', Object.keys(t.metrics().durations).length === 0)
  t.info('a', 'b', 'c')
  ok('and sequence numbers restart cleanly', t.snapshot()[0].seq === 1)
}

// ═══ 4. Legacy line parsing ═══════════════════════════════════════════════
//
// Dozens of call sites already write `[scope] message`. Rewriting them would be
// churn with no behavioural gain, so the existing shape is read into structure.

{
  ok(
    'a scoped line is split',
    JSON.stringify(parseLegacyLine('[policy] ALLOW Bash — recognised')) ===
      JSON.stringify({ scope: 'policy', message: 'ALLOW Bash — recognised' })
  )
  ok('an unscoped line still parses', parseLegacyLine('something happened').scope === 'studio')
  ok(
    'and keeps its message',
    parseLegacyLine('something happened').message === 'something happened'
  )
  ok('a bracket mid-line is not a scope', parseLegacyLine('see [here] for more').scope === 'studio')
  ok('an empty line does not throw', parseLegacyLine('').message === '')
}

console.log(`PASS ${PASS.length}`)
PASS.forEach((p) => console.log(`  ✓ ${p}`))
if (FAIL.length) {
  console.log(`\nFAIL ${FAIL.length}`)
  FAIL.forEach((f) => console.log(`  ✗ ${f}`))
}
process.exit(FAIL.length ? 1 : 0)
