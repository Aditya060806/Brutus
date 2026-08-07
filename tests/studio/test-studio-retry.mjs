/**
 * Retry and cancellation.
 *
 * The clock is injected, so this suite exercises real backoff arithmetic
 * without sleeping — a retry suite that actually waits is one nobody runs, and
 * one nobody runs is one that stops being true.
 *
 * The important assertions are about what is *not* retried. Re-running a merge
 * that hit a genuine conflict would produce the same conflict; re-running a
 * partially applied command can double its side effects. Retrying the wrong
 * thing is worse than not retrying at all.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const { withRetry, backoffDelay, isTransientGitFailure, AbortError } = require('./retry.test.cjs')
const { StudioRouter } = require('./router.test.cjs')

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Records the delays asked for and returns instantly. */
function fakeClock() {
  const waits = []
  return { waits, sleep: async (ms) => void waits.push(ms) }
}

// ═══ 1. Retry loop ════════════════════════════════════════════════════════

{
  let calls = 0
  const clock = fakeClock()
  const result = await withRetry(
    async () => {
      calls++
      if (calls < 3) throw new Error('index.lock: File exists')
      return 'succeeded'
    },
    { isRetryable: isTransientGitFailure, sleep: clock.sleep, random: () => 0.5 }
  )
  ok('a transient failure is retried until it succeeds', result === 'succeeded')
  ok('it stops as soon as it works', calls === 3, `${calls} calls`)
  ok('it waited between attempts', clock.waits.length === 2, JSON.stringify(clock.waits))
}

{
  let calls = 0
  const clock = fakeClock()
  let threw = null
  try {
    await withRetry(
      async () => {
        calls++
        throw new Error('index.lock: File exists')
      },
      { attempts: 3, isRetryable: isTransientGitFailure, sleep: clock.sleep, random: () => 0.5 }
    )
  } catch (e) {
    threw = e
  }
  ok('a persistent failure stops at the attempt ceiling', calls === 3, `${calls} calls`)
  ok('and rethrows the underlying error, not a wrapper', /index\.lock/.test(String(threw)))
  ok('with one wait fewer than attempts', clock.waits.length === 2)
}

{
  let calls = 0
  const clock = fakeClock()
  await withRetry(
    async () => {
      calls++
      throw new Error('CONFLICT (content): Merge conflict in a.txt')
    },
    { isRetryable: isTransientGitFailure, sleep: clock.sleep }
  ).catch(() => {})
  ok('a merge conflict is never retried', calls === 1, `${calls} calls`)
  ok('and nothing waited', clock.waits.length === 0)
}

{
  let calls = 0
  await withRetry(
    async () => {
      calls++
      throw new Error('fatal: not a git repository')
    },
    { isRetryable: isTransientGitFailure, sleep: async () => {} }
  ).catch(() => {})
  ok('an ordinary failure is not retried', calls === 1)
}

{
  const calls = []
  await withRetry(
    async () => {
      calls.push(1)
      throw new Error('EBUSY: resource busy or locked')
    },
    { attempts: 5, isRetryable: isTransientGitFailure, sleep: async () => {} }
  ).catch(() => {})
  ok('a Windows EBUSY is treated as transient', calls.length === 5, `${calls.length}`)
}

// ═══ 2. Backoff shape ═════════════════════════════════════════════════════

{
  const noJitter = () => 1 // maps to the top of the jitter range
  const d1 = backoffDelay(1, 100, 5000, noJitter)
  const d2 = backoffDelay(2, 100, 5000, noJitter)
  const d3 = backoffDelay(3, 100, 5000, noJitter)
  ok('backoff grows exponentially', d1 < d2 && d2 < d3, `${d1},${d2},${d3}`)
  ok('and is clamped by the ceiling', backoffDelay(20, 100, 500, noJitter) <= 500)

  const low = backoffDelay(3, 100, 5000, () => 0)
  const high = backoffDelay(3, 100, 5000, () => 1)
  ok('jitter spreads collided retries apart', low < high, `${low} vs ${high}`)
  ok('and never produces a negative delay', backoffDelay(1, 100, 5000, () => 0) >= 0)
}

// ═══ 3. Cancellation of the retry loop ════════════════════════════════════

{
  const controller = new AbortController()
  let calls = 0
  let threw = null
  try {
    await withRetry(
      async () => {
        calls++
        controller.abort() // aborted while the first attempt is in flight
        throw new Error('index.lock: File exists')
      },
      {
        isRetryable: isTransientGitFailure,
        signal: controller.signal,
        sleep: async () => {}
      }
    )
  } catch (e) {
    threw = e
  }
  ok('an abort stops the retry loop immediately', calls === 1, `${calls} calls`)
  ok('and reports a failure rather than hanging', threw !== null)
}

{
  const controller = new AbortController()
  controller.abort()
  let ran = false
  let threw = null
  try {
    await withRetry(
      async () => {
        ran = true
        return 'x'
      },
      { isRetryable: () => true, signal: controller.signal }
    )
  } catch (e) {
    threw = e
  }
  ok('an already-aborted signal runs nothing at all', !ran)
  ok('and raises AbortError', threw instanceof AbortError || threw?.name === 'AbortError')
}

// ═══ 4. Cascade cancellation ══════════════════════════════════════════════
//
// The user-visible property: saying stop actually stops chains already running,
// rather than merely declining to start new ones.

const node = (id, title) => ({
  id,
  kind: 'agent',
  agentKind: 'claude',
  title,
  x: 0,
  y: 0,
  width: 400,
  height: 300
})

function makeRouter(reframe) {
  const delivered = []
  const logs = []
  const r = new StudioRouter({
    deliver: (sessionId, text) => delivered.push({ sessionId, text }),
    emit: () => {},
    log: (l) => logs.push(l),
    reframe
  })
  r.setGraph({
    nodes: [node('n1', 'Apollo'), node('n2', 'Vega')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }],
    autoRoute: true
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)
  return { r, delivered, logs }
}

{
  // A reframe still in flight when the user cancels must deliver nothing.
  let sawSignal = null
  const slowReframe = async (input) => {
    sawSignal = input.signal
    await sleep(120)
    return 'go do the thing'
  }
  const { r, delivered } = makeRouter(slowReframe)

  r.onStatus('s1', 'busy')
  r.observe('s1', 'finished some work')
  r.onStatus('s1', 'idle')

  await sleep(30) // reframe is in flight
  const cancelled = r.cancelAll('test')
  await sleep(200) // let the reframe resolve after cancellation

  ok('cancelling reports what it stopped', cancelled === 1, String(cancelled))
  ok('a cancelled cascade delivers nothing', delivered.length === 0, JSON.stringify(delivered))
  ok('the reframe was given a signal to cancel on', sawSignal !== null)
  ok('and that signal is aborted', sawSignal?.aborted === true)
}

{
  // Turning auto-route off is a cancel, not just a gate on new work.
  const { r, delivered } = makeRouter(async () => {
    await sleep(120)
    return 'instruction'
  })
  r.onStatus('s1', 'busy')
  r.observe('s1', 'work')
  r.onStatus('s1', 'idle')
  await sleep(30)

  r.setGraph({ autoRoute: false })
  await sleep(200)
  ok('switching auto-route off stops work already running', delivered.length === 0)
}

{
  // And cancelling must not wedge the router for the next prompt.
  const { r, delivered } = makeRouter(async () => 'next instruction')
  r.cancelAll('test')
  r.setGraph({ autoRoute: true })
  r.onStatus('s1', 'busy')
  r.observe('s1', 'fresh work')
  r.onStatus('s1', 'idle')
  await sleep(120)
  ok('routing works again after a cancellation', delivered.length === 1, JSON.stringify(delivered))
}

console.log(`PASS ${PASS.length}`)
PASS.forEach((p) => console.log(`  ✓ ${p}`))
if (FAIL.length) {
  console.log(`\nFAIL ${FAIL.length}`)
  FAIL.forEach((f) => console.log(`  ✗ ${f}`))
}
process.exit(FAIL.length ? 1 : 0)
