/**
 * Orchestrator engine tests. Covers the parts that must not be wrong:
 * plan validation, DAG parallelism/ordering, retry/degrade, the approval gate,
 * and Groq key-pool rotation.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { validatePlan } = require('./planner.test.cjs')
const bus = require('./bus.test.cjs')
const { KeyPool } = require('./keypool.test.cjs')
const { runPlan, planToTasks } = require('./scheduler.test.cjs')

// ═══ 1. Plan validation ═══════════════════════════════════════════════════
const good = validatePlan({
  objective: 'test',
  tasks: [
    { id: 't1', agent: 'researcher', goal: 'find X', dependsOn: [] },
    { id: 't2', agent: 'analyst', goal: 'compare X', dependsOn: ['t1'] }
  ]
})
ok('valid plan accepted', good.ok === true)
ok('topological order correct', good.ok && good.order[0] === 't1' && good.order[1] === 't2')

const cyclic = validatePlan({
  tasks: [
    { id: 'a', agent: 'analyst', goal: 'g', dependsOn: ['b'] },
    { id: 'b', agent: 'analyst', goal: 'g', dependsOn: ['a'] }
  ]
})
ok('cycle rejected', cyclic.ok === false && /cycle/i.test(cyclic.error), cyclic.error)

const selfLoop = validatePlan({ tasks: [{ id: 'a', agent: 'analyst', goal: 'g', dependsOn: ['a'] }] })
ok('self-dependency rejected', selfLoop.ok === false)

const dangling = validatePlan({ tasks: [{ id: 'a', agent: 'analyst', goal: 'g', dependsOn: ['zz'] }] })
ok('dangling dependency rejected', dangling.ok === false && /unknown task/i.test(dangling.error))

const badAgent = validatePlan({ tasks: [{ id: 'a', agent: 'wizard', goal: 'g', dependsOn: [] }] })
ok('unknown agent rejected', badAgent.ok === false && /unknown agent/i.test(badAgent.error))

const dupe = validatePlan({
  tasks: [
    { id: 'a', agent: 'analyst', goal: 'g', dependsOn: [] },
    { id: 'a', agent: 'analyst', goal: 'g2', dependsOn: [] }
  ]
})
ok('duplicate id rejected', dupe.ok === false)
ok('empty plan rejected', validatePlan({ tasks: [] }).ok === false)

// ═══ 2. Approval gate (safety-critical) ═══════════════════════════════════
bus._resetRegistryForTests()
let sendCount = 0
bus.defineCapability(
  { name: 'send-thing', tags: ['external'], description: 'sends' },
  async () => {
    sendCount++
    return 'sent'
  }
)
bus.defineCapability({ name: 'read-thing', tags: ['read'], description: 'reads' }, async () => 'data')

const r1 = await bus.runCapability('read-thing', {}, { autonomy: 'guarded' })
ok('read capability runs without approval', r1.ok === true)

const r2 = await bus.runCapability('send-thing', { to: 'a@b.c' }, { autonomy: 'guarded' })
ok('external capability BLOCKED without token', r2.ok === false && r2.needsApproval === true)
ok('blocked capability did not execute', sendCount === 0)

const r3 = await bus.runCapability('send-thing', { to: 'a@b.c' }, {
  autonomy: 'guarded',
  approvalToken: 'forged-token'
})
ok('forged token rejected', r3.ok === false && r3.needsApproval === true && sendCount === 0)

bus.grantApproval('tok1', 'send-thing', { to: 'a@b.c' })
const r4 = await bus.runCapability('send-thing', { to: 'a@b.c' }, {
  autonomy: 'guarded',
  approvalToken: 'tok1'
})
ok('valid token permits execution', r4.ok === true && sendCount === 1)

const r5 = await bus.runCapability('send-thing', { to: 'a@b.c' }, {
  autonomy: 'guarded',
  approvalToken: 'tok1'
})
ok('token is SINGLE USE', r5.ok === false && sendCount === 1)

// Token bound to args: approving one email must not authorise a different one.
bus.grantApproval('tok2', 'send-thing', { to: 'alice@x.com' })
const r6 = await bus.runCapability('send-thing', { to: 'EVIL@attacker.com' }, {
  autonomy: 'guarded',
  approvalToken: 'tok2'
})
ok('token bound to exact args (cannot swap recipient)', r6.ok === false && sendCount === 1)

// Arg order must not matter for a legitimate match.
bus.grantApproval('tok3', 'send-thing', { to: 'a@b.c', subject: 's' })
const r7 = await bus.runCapability('send-thing', { subject: 's', to: 'a@b.c' }, {
  autonomy: 'guarded',
  approvalToken: 'tok3'
})
ok('arg order does not break a valid token', r7.ok === true && sendCount === 2)

const r8 = await bus.runCapability('send-thing', { to: 'x' }, { autonomy: 'autonomous' })
ok('autonomous mode skips the gate', r8.ok === true && sendCount === 3)

const r9 = await bus.runCapability('read-thing', {}, { autonomy: 'strict' })
ok('strict mode still allows reads', r9.ok === true)

// ═══ 3. Key pool rotation ═════════════════════════════════════════════════
const pool = new KeyPool(['ka', 'kb', 'kc'], 0) // pacing off: isolating rotation/429 semantics
ok('pool reports size', pool.size === 3 && pool.available === true)

const l1 = pool.acquire()
const l2 = pool.acquire()
ok('round-robins across keys', l1.key !== l2.key, `${l1.key} vs ${l2.key}`)
pool.release(l1)
pool.release(l2)

const rl = pool.acquire()
const retry = pool.reportFailure(rl, { status: 429, message: 'rate limit reached' })
pool.release(rl)
ok('429 asks caller to retry on another key', retry === true)
ok('rate-limited key is cooling', pool.status().cooling === 1)

const next = pool.acquire()
ok('cooling key is not handed out', next && next.key !== rl.key)
pool.release(next)

const auth = pool.acquire()
pool.reportFailure(auth, { status: 401, message: 'invalid api key' })
pool.release(auth)
ok('bad key is permanently disabled', pool.status().dead === 1)

const exhausted = new KeyPool(['only'], 0)
const el = exhausted.acquire()
exhausted.reportFailure(el, { status: 429, message: 'rate limit' })
exhausted.release(el)
ok('single exhausted key reports unavailable', exhausted.available === false)
ok('acquire returns null when all cooling', exhausted.acquire() === null)
ok('keys are masked in status', /···/.test(pool.status().keys[0].label))

// A rate limit is temporary: the pool must say WHEN it frees up, not just "no".
const waitPool = new KeyPool(['solo'], 0)
const wl = waitPool.acquire()
waitPool.reportFailure(wl, { message: 'rate limit reached, try again in 2s' })
waitPool.release(wl)
const waitMs = waitPool.msUntilAvailable()
ok('reports ms until a key frees up', waitMs !== null && waitMs > 0 && waitMs < 5000, `${waitMs}ms`)
ok(
  'unavailable reason names the real cause',
  /rate-limited/i.test(waitPool.unavailableReason()),
  waitPool.unavailableReason()
)
await sleep(waitMs + 300)
ok('key recovers after its cooldown', waitPool.available === true && waitPool.acquire() !== null)

const deadPool = new KeyPool(['bad'], 0)
const dl = deadPool.acquire()
deadPool.reportFailure(dl, { status: 401, message: 'invalid api key' })
deadPool.release(dl)
ok('dead pool reports null wait (never recovers)', deadPool.msUntilAvailable() === null)
ok(
  'dead pool reason says invalid, not rate-limited',
  /invalid/i.test(deadPool.unavailableReason()),
  deadPool.unavailableReason()
)

// ═══ 4. Scheduler: parallelism, ordering, degradation ═════════════════════
function makeRun(tasks) {
  return { id: 'r1', request: 'q', status: 'running', tasks: planToTasks({ objective: 'o', tasks }), startedAt: Date.now() }
}
const noopHooks = () => ({
  onTaskUpdate: () => {},
  onLog: () => {},
  requestApproval: async () => true
})

// Stub the agent runner + critic via the injected router: the scheduler calls
// runAgentTask, so we test timing through a router whose completions sleep.
const timeline = []
const fakeRouter = {
  complete: async () => ({ text: 'done', provider: 'test', model: 'test', attempts: [], elapsedMs: 1 }),
  completeJson: async () => ({ data: { pass: true, reason: 'ok' }, meta: {} })
}

// Independent tasks must overlap in wall-clock time.
const parallelRun = makeRun([
  { id: 'a', agent: 'analyst', goal: 'A', dependsOn: [] },
  { id: 'b', agent: 'analyst', goal: 'B', dependsOn: [] }
])
const cfg = { concurrency: 3, autonomy: 'guarded', maxToolIterations: 2, groqKeys: [], tavilyKey: '', hfKey: '', modelOverrides: {} }

const slowRouter = {
  complete: async (req) => {
    const tag = req.messages?.[0]?.content?.slice(0, 40) || ''
    timeline.push({ ev: 'start', tag, t: Date.now() })
    await sleep(120)
    timeline.push({ ev: 'end', tag, t: Date.now() })
    // Long enough to clear the critic's minimum-substance guard.
    return { text: JSON.stringify({ final: 'A complete and substantive answer to the task.' }), provider: 'test', model: 'test', attempts: [], elapsedMs: 120 }
  },
  completeJson: async () => ({ data: { pass: true, reason: 'ok' }, meta: {} })
}

const t0 = Date.now()
await runPlan(parallelRun, slowRouter, cfg, noopHooks())
const parallelMs = Date.now() - t0
ok('both independent tasks completed', parallelRun.tasks.every((t) => t.status === 'done'))
ok(
  'independent tasks ran in PARALLEL',
  parallelMs < 220,
  `${parallelMs}ms for 2x120ms tasks (serial would be ~240ms)`
)

// Dependent tasks must be strictly ordered.
timeline.length = 0
const chainRun = makeRun([
  { id: 'a', agent: 'analyst', goal: 'FIRST', dependsOn: [] },
  { id: 'b', agent: 'analyst', goal: 'SECOND', dependsOn: ['a'] }
])
await runPlan(chainRun, slowRouter, cfg, noopHooks())
const firstEnd = timeline.find((e) => e.ev === 'end' && e.tag.includes('FIRST'))
const secondStart = timeline.find((e) => e.ev === 'start' && e.tag.includes('SECOND'))
ok('dependent task waited for its parent', firstEnd && secondStart && secondStart.t >= firstEnd.t)
ok('chained tasks both done', chainRun.tasks.every((t) => t.status === 'done'))

// A failing task must not kill the run; its dependents are skipped.
const failRouter = {
  complete: async (req) => {
    if ((req.messages?.[0]?.content || '').includes('BOOM')) throw new Error('agent exploded')
    return { text: JSON.stringify({ final: 'A complete and substantive answer to the task.' }), provider: 'test', model: 'test', attempts: [], elapsedMs: 1 }
  },
  completeJson: async () => ({ data: { pass: true, reason: 'ok' }, meta: {} })
}
const degradeRun = makeRun([
  { id: 'a', agent: 'analyst', goal: 'BOOM', dependsOn: [] },
  { id: 'b', agent: 'analyst', goal: 'needs a', dependsOn: ['a'] },
  { id: 'c', agent: 'analyst', goal: 'independent', dependsOn: [] }
])
await runPlan(degradeRun, failRouter, cfg, noopHooks())
const ta = degradeRun.tasks.find((t) => t.id === 'a')
const tb = degradeRun.tasks.find((t) => t.id === 'b')
const tc = degradeRun.tasks.find((t) => t.id === 'c')
ok('failing task marked failed', ta.status === 'failed')
ok('failing task was retried before giving up', ta.attempts >= 2, `attempts=${ta.attempts}`)
ok('dependent of a failed task is SKIPPED, not run', tb.status === 'skipped')
ok('unrelated task still succeeded (graceful degradation)', tc.status === 'done')

// ═══ 5. Search-query derivation (the Tavily 400-char failure) ═════════════
const { toSearchQuery, truncateQuery } = require('./runner.test.cjs')

// The exact goal from the failing run.
const realGoal =
  'Search the web for current open-source large language models, evaluate them based on performance, size, community support, and licensing, and provide a concise ranked list with brief descriptions and citations.'
const q1 = toSearchQuery(realGoal)
ok('strips the "search the web for" lead-in', !/^search the web/i.test(q1), q1)
ok('strips trailing format instructions', !/provide|citations/i.test(q1), q1)
ok('keeps the actual subject', /open-source large language models/i.test(q1), q1)
ok('query is under Tavily 400-char limit', q1.length < 400, `${q1.length} chars`)

// The retry case that actually broke: feedback appended to the goal.
const pollutedGoal = `${realGoal}\n\n(Your previous attempt was rejected: The response contains obvious fabrications, including non-existent future models (e.g., Gemma 4, DeepSeek-V4-Pro) and fabricated 2026 sources and benchmark metrics.. Fix that.)`
const q2 = toSearchQuery(pollutedGoal)
ok('retry feedback never reaches the query', !/previous attempt|rejected|fabricat/i.test(q2), q2)
ok('polluted goal still under limit', q2.length < 400, `${q2.length} chars`)

const q3 = toSearchQuery('Find and summarize the best open-source LLMs and include citations')
ok('handles "find and summarize" lead-in', !/^find and/i.test(q3), q3)

const long = 'a'.repeat(900)
ok('hard truncation respects the cap', truncateQuery(long).length <= 380)
ok(
  'truncation prefers a word boundary',
  !truncateQuery(`${'word '.repeat(200)}end`).endsWith('wor'),
  truncateQuery(`${'word '.repeat(200)}end`).slice(-12)
)
ok('short queries pass through untouched', toSearchQuery('best open source LLMs 2026').length > 0)

// ═══ 6. Proactive rate limiting ═══════════════════════════════════════════
// A key must not be reused until its interval elapses — this is what keeps us
// UNDER the limit instead of discovering it via 429s.
const paced = new KeyPool(['k1', 'k2'], 300)
const p1 = paced.acquire()
paced.release(p1)
const p2 = paced.acquire()
paced.release(p2)
ok('pacing rotates to a different key', p1.key !== p2.key, `${p1.key} then ${p2.key}`)
ok('both keys used → none ready yet', paced.acquire() === null)
const pw = paced.msUntilAvailable()
ok('reports the pacing wait', pw !== null && pw > 0 && pw <= 300, `${pw}ms`)
ok('pacing is not reported as an error', /throttl/i.test(paced.unavailableReason()), paced.unavailableReason())
await sleep(pw + 60)
ok('key becomes reusable after the interval', paced.acquire() !== null)

// Sustained rate must respect the interval.
const solo = new KeyPool(['only'], 200)
let grants = 0
const rateStart = Date.now()
while (Date.now() - rateStart < 1000) {
  const l = solo.acquire()
  if (l) {
    grants++
    solo.release(l)
  } else {
    await sleep(20)
  }
}
ok('sustained rate respects the interval', grants <= 7, `${grants} grants in 1s at 200ms spacing`)

// ═══ 7. Run call budget ═══════════════════════════════════════════════════
const { createCallBudget } = require('./types.test.cjs')
const b = createCallBudget(3)
ok('budget allows up to its limit', b.consume() && b.consume() && b.consume())
ok('budget blocks past the limit', b.consume() === false)
ok('budget reports remaining', createCallBudget(5).remaining() === 5)
ok('budget tracks usage', b.used === 3)

// End to end: a plan whose agents would loop forever must stop at the budget.
let callCount = 0
const greedyRouter = {
  complete: async () => {
    callCount++
    // Never returns "final", so the agent would loop until its cap every time.
    return {
      text: JSON.stringify({ thought: 'again', action: { capability: 'nope', args: {} } }),
      provider: 'test',
      model: 'test',
      attempts: [],
      elapsedMs: 1
    }
  },
  completeJson: async () => ({ data: { pass: true, reason: 'ok' }, meta: {} })
}
const budgetRun = makeRun([
  { id: 'a', agent: 'analyst', goal: 'loop forever', dependsOn: [] },
  { id: 'b', agent: 'analyst', goal: 'loop forever too', dependsOn: [] },
  { id: 'c', agent: 'analyst', goal: 'and again', dependsOn: [] }
])
const runBudget = createCallBudget(5)
await runPlan(
  budgetRun,
  greedyRouter,
  { ...cfg, concurrency: 1, maxToolIterations: 6 },
  noopHooks(),
  undefined,
  runBudget
)
ok(
  'budget caps total LLM calls for the run',
  callCount <= 5,
  `${callCount} calls made against a budget of 5`
)
ok('run still terminates when budget is spent', budgetRun.tasks.every((t) => ['done', 'failed', 'skipped'].includes(t.status)))

console.log(`PASS ${PASS.length}`)
PASS.forEach((p) => console.log(`  ✓ ${p}`))
if (FAIL.length) {
  console.log(`\nFAIL ${FAIL.length}`)
  FAIL.forEach((f) => console.log(`  ✗ ${f}`))
}
process.exit(FAIL.length ? 1 : 0)
