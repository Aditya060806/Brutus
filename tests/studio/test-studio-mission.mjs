/**
 * The Dashboard mission: validation, and the live state machine.
 *
 * These are the assertions standing between a hallucinated plan and several
 * real coding-agent CLIs being launched against the user's repository. The
 * validator is pure, so it is tested exhaustively; the tracker takes the
 * terminal and the clock as callbacks, so a whole multi-agent run is driven
 * here in microseconds with no processes and no model.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const {
  MAX_STEPS,
  MissionTracker,
  STALL_AFTER_MS,
  missionEdges,
  missionPrompt,
  validateMission,
  MISSION_SYSTEM
} = require('./mission.test.cjs')

const KINDS = ['claude', 'codex', 'gemini', 'shell']
const V = (raw, over = {}) =>
  validateMission(raw, { availableKinds: KINDS, task: 'do the thing', id: 'msn_test', ...over })

// ═══ 1. Validation — the shape ════════════════════════════════════════════

{
  const { plan, skipped } = V({
    summary: 'Build it and check it',
    steps: [
      { ref: 'a', agentKind: 'claude', title: 'Apollo', role: 'Build', brief: 'Do the work' },
      {
        ref: 'b',
        agentKind: 'codex',
        title: 'Atlas',
        role: 'Verify',
        brief: 'Run the tests',
        dependsOn: 'a'
      }
    ]
  })
  ok('a well-formed plan validates', !!plan)
  ok('both steps survive', plan?.steps.length === 2)
  ok('nothing is reported as adjusted', skipped.length === 0, skipped.join('; '))
  ok('the summary is carried through', plan?.summary === 'Build it and check it')
  ok('the task is the human’s words, not the model’s', plan?.task === 'do the thing')
  ok('a root step has no dependency', plan?.steps[0].dependsOn === null)
  ok('a backwards dependency is kept', plan?.steps[1].dependsOn === 'a')
}

{
  // The model is allowed to reply with a bare array, as command.ts permits.
  const { plan } = V([{ agentKind: 'shell', brief: 'ls', title: 'T', role: 'Look' }])
  ok('a bare array is accepted', plan?.steps.length === 1)
  ok('a missing ref is generated', plan?.steps[0].ref === 's1')
}

ok('no steps means no plan', V({ steps: [] }).plan === null)
ok('a non-object means no plan', V(null).plan === null)
ok('a string means no plan', V('sure thing').plan === null)
ok('missing steps means no plan', V({ summary: 'hi' }).plan === null)

// ═══ 2. Validation — what gets dropped ════════════════════════════════════

{
  const { plan, skipped } = V({
    steps: [
      { ref: 'a', agentKind: 'cursor', title: 'X', role: 'Build', brief: 'go' },
      { ref: 'b', agentKind: 'claude', title: 'Y', role: 'Build', brief: 'go' }
    ]
  })
  ok('an agent that is not installed is dropped', plan?.steps.length === 1)
  ok('the surviving step is the installed one', plan?.steps[0].agentKind === 'claude')
  ok('the drop is explained', skipped.some((s) => s.includes('cursor')), skipped.join('; '))
}

{
  const { plan, skipped } = V({
    steps: [
      { ref: 'a', agentKind: 'claude', title: 'X', role: 'Build', brief: '   ' },
      { ref: 'b', agentKind: 'claude', title: 'Y', role: 'Build', brief: 'real work' }
    ]
  })
  ok('a step with no instruction is dropped', plan?.steps.length === 1)
  ok('an empty brief is explained', skipped.some((s) => /no instruction/i.test(s)))
}

{
  const { plan, skipped } = V({
    steps: [
      { ref: 'a', agentKind: 'claude', title: 'X', role: 'B', brief: 'go', dependsOn: 'b' },
      { ref: 'b', agentKind: 'claude', title: 'Y', role: 'B', brief: 'go' }
    ]
  })
  ok('a forward reference is refused', plan?.steps[0].dependsOn === null)
  ok('the forward reference is explained', skipped.some((s) => s.includes('"b"')))
}

{
  const { plan } = V({
    steps: [{ ref: 'a', agentKind: 'claude', title: 'X', role: 'B', brief: 'go', dependsOn: 'a' }]
  })
  ok('a step cannot depend on itself', plan?.steps[0].dependsOn === null)
}

{
  const { plan } = V({
    steps: [{ ref: 'a', agentKind: 'claude', title: 'X', role: 'B', brief: 'go', dependsOn: 'ghost' }]
  })
  ok('an unknown dependency becomes a root', plan?.steps[0].dependsOn === null)
}

{
  // A cycle is only expressible through a forward reference, and those are
  // already refused — so this asserts the property rather than the mechanism.
  const { plan } = V({
    steps: [
      { ref: 'a', agentKind: 'claude', title: 'X', role: 'B', brief: 'go', dependsOn: 'b' },
      { ref: 'b', agentKind: 'claude', title: 'Y', role: 'B', brief: 'go', dependsOn: 'a' }
    ]
  })
  const seen = new Set()
  let acyclic = true
  for (const s of plan.steps) {
    if (s.dependsOn && !seen.has(s.dependsOn)) acyclic = false
    seen.add(s.ref)
  }
  ok('no plan can contain a cycle', acyclic)
}

{
  const { plan, skipped } = V({
    steps: [
      { ref: 'a', agentKind: 'claude', title: 'X', role: 'B', brief: 'go' },
      { ref: 'b', agentKind: 'claude', title: 'Y', role: 'B', brief: 'go' },
      { ref: 'c', agentKind: 'claude', title: 'Z', role: 'B', brief: 'go', dependsOn: ['a', 'b'] }
    ]
  })
  ok('a join keeps only the first dependency', plan?.steps[2].dependsOn === 'a')
  ok('dropping the join is explained', skipped.some((s) => /several steps/i.test(s)))
}

{
  const { plan, skipped } = V({
    steps: [
      { ref: 'a', agentKind: 'claude', title: 'X', role: 'B', brief: 'one' },
      { ref: 'a', agentKind: 'claude', title: 'Y', role: 'B', brief: 'two' }
    ]
  })
  ok('a duplicate ref is renamed rather than dropped', plan?.steps.length === 2)
  ok('the refs end up distinct', plan?.steps[0].ref !== plan?.steps[1].ref)
  ok('the rename is explained', skipped.some((s) => /both called themselves/i.test(s)))
}

{
  const many = Array.from({ length: MAX_STEPS + 4 }, (_, i) => ({
    ref: `s${i}`,
    agentKind: 'claude',
    title: `T${i}`,
    role: 'B',
    brief: 'go'
  }))
  const { plan, skipped } = V({ steps: many })
  ok(`the crew is capped at ${MAX_STEPS}`, plan?.steps.length === MAX_STEPS)
  ok('the cap is explained', skipped.some((s) => s.includes(String(MAX_STEPS))))
}

{
  const { plan } = V({
    steps: [
      { ref: 'a', agentKind: 'claude', title: 'x'.repeat(500), role: 'y'.repeat(500), brief: 'z'.repeat(9000) }
    ]
  })
  ok('an over-long title is clamped', plan.steps[0].title.length <= 40)
  ok('an over-long role is clamped', plan.steps[0].role.length <= 40)
  ok('an over-long brief is clamped', plan.steps[0].brief.length <= 1500)
}

ok(
  'with no agents installed nothing validates',
  validateMission(
    { steps: [{ ref: 'a', agentKind: 'claude', title: 'X', role: 'B', brief: 'go' }] },
    { availableKinds: [], task: 't' }
  ).plan === null
)

// ═══ 3. Derived edges ═════════════════════════════════════════════════════

{
  const { plan } = V({
    steps: [
      { ref: 'a', agentKind: 'claude', title: 'A', role: 'Build', brief: 'go' },
      { ref: 'b', agentKind: 'codex', title: 'B', role: 'Review', brief: 'go', dependsOn: 'a' },
      { ref: 'c', agentKind: 'gemini', title: 'C', role: 'Test', brief: 'go', dependsOn: 'a' }
    ]
  })
  const edges = missionEdges(plan)
  ok('one edge per dependency', edges.length === 2)
  ok('fan-out points away from the shared parent', edges.every((e) => e.from === 'a'))
  ok('the edge is labelled with the role', edges[0].label === 'Review')
  ok('a root contributes no edge', !edges.some((e) => e.to === 'a'))
}

// ═══ 4. The prompt ════════════════════════════════════════════════════════

{
  const p = missionPrompt('fix the tests', ['claude', 'codex'], {
    projectName: 'Brutus-AI',
    rootDir: 'D:/x'
  })
  ok('the prompt lists only installed agents', p.includes('claude, codex') && !p.includes('gemini,'))
  ok('the prompt carries the request', p.includes('fix the tests'))
  ok('the prompt names the project', p.includes('Brutus-AI'))
  ok(
    'with no project it says so',
    missionPrompt('x', ['claude']).includes('no folder chosen')
  )
  ok('the system prompt demands JSON', /JSON only/i.test(MISSION_SYSTEM))
  ok('the system prompt requires a verification step', /verify/i.test(MISSION_SYSTEM))
}

// ═══ 5. The tracker — a clean run ═════════════════════════════════════════

/** Drive a tracker with a controllable clock and a fake terminal. */
function rig(plan, { sessions = null } = {}) {
  const delivered = []
  const records = []
  let clock = 1_000_000
  const bindings = plan.steps.map((s) => ({ ref: s.ref, nodeId: `node_${s.ref}` }))
  const tracker = new MissionTracker(plan, bindings, {
    sessionForNode: (nodeId) =>
      sessions ? (sessions[nodeId] ?? null) : `sess_${nodeId}`,
    deliver: (sessionId, text) => delivered.push({ sessionId, text }),
    record: (level, event, message, fields) => records.push({ level, event, message, fields }),
    now: () => clock
  })
  return {
    tracker,
    delivered,
    records,
    tick: (ms) => (clock += ms),
    node: (ref) => `node_${ref}`
  }
}

const chain = V({
  summary: 'Build then verify',
  steps: [
    { ref: 'a', agentKind: 'claude', title: 'Apollo', role: 'Build', brief: 'Write the feature' },
    {
      ref: 'b',
      agentKind: 'codex',
      title: 'Atlas',
      role: 'Verify',
      brief: 'Run the tests',
      dependsOn: 'a'
    }
  ]
}).plan

{
  const r = rig(chain)
  ok('the mission starts running', r.tracker.snapshot().status === 'running')
  ok('the start is recorded', r.records.some((x) => x.event === 'mission.start'))

  // The session exists the moment the spawn returns, so the root brief goes out
  // straight away. It does not reach the terminal yet: `deliver` is enqueue,
  // which holds it until the CLI reports idle.
  ok('the root brief is sent as soon as it has a session', r.delivered.length === 1)
  ok('only the root is sent', r.delivered.length === 1)
  ok('a dependent step starts pending', r.tracker.snapshot().steps[1].status === 'pending')
  ok('the brief is what was planned', r.delivered[0].text.startsWith('Write the feature'))
  ok('the brief is submitted with a carriage return', r.delivered[0].text.endsWith('\r'))
  ok('it went to the root’s own session', r.delivered[0].sessionId === 'sess_node_a')
  ok('the root is now running', r.tracker.snapshot().steps[0].status === 'running')
  ok('the dispatch is recorded', r.records.some((x) => x.event === 'step.dispatch'))

  // Idle is also the retry path for a step whose session was not up yet, so it
  // must be safe to hit repeatedly on one that already went out.
  r.tracker.noteStatus(r.node('a'), 'idle')
  r.tracker.noteStatus(r.node('a'), 'idle')
  ok('a later idle does not re-send the brief', r.delivered.length === 1)

  // The downstream agent booting must not be dispatched by the tracker — the
  // router delivers that one along the edge.
  r.tracker.noteStatus(r.node('b'), 'idle')
  ok('a dependent step is never dispatched by the tracker', r.delivered.length === 1)
  ok('a dependent step is still pending', r.tracker.snapshot().steps[1].status === 'pending')

  r.tick(4000)
  r.tracker.noteTurn(r.node('a'), 'Feature written in src/x.ts')
  const afterA = r.tracker.snapshot()
  ok('finishing a turn marks the step done', afterA.steps[0].status === 'done')
  ok('the output is kept for the board', afterA.steps[0].output?.includes('src/x.ts'))
  ok('the duration is recorded', afterA.steps[0].finishedAt - afterA.steps[0].startedAt === 4000)
  ok('one done, one to go', afterA.totals.done === 1 && afterA.totals.total === 2)
  ok('the mission is still running', afterA.status === 'running')

  // The router prompts the dependent; it goes busy.
  r.tracker.noteStatus(r.node('b'), 'busy')
  ok('a handed-off step reads as running', r.tracker.snapshot().steps[1].status === 'running')
  ok('picking up the handoff is recorded', r.records.some((x) => x.event === 'step.begin'))

  r.tracker.noteTurn(r.node('b'), 'All 42 tests pass')
  const done = r.tracker.snapshot()
  ok('the mission completes when every step is done', done.status === 'done')
  ok('completion is recorded', r.records.some((x) => x.event === 'mission.done'))
  ok('the totals agree', done.totals.done === 2 && done.totals.failed === 0)
  ok('a finish time is set', typeof done.finishedAt === 'number')
}

// ═══ 6. The tracker — failure ═════════════════════════════════════════════

{
  const r = rig(chain)
  r.tracker.noteStatus(r.node('a'), 'idle')
  r.tracker.noteExit(r.node('a'), 1)

  const s = r.tracker.snapshot()
  ok('a terminal dying mid-step fails it', s.steps[0].status === 'failed')
  ok('the failure says what happened', /exited with code 1/.test(s.steps[0].note ?? ''))
  ok('everything downstream is blocked', s.steps[1].status === 'blocked')
  ok('the block names the cause', /Apollo/.test(s.steps[1].note ?? ''))
  ok('the mission as a whole failed', s.status === 'failed')
  ok('the failure is recorded at error level', r.records.some((x) => x.event === 'step.failed' && x.level === 'error'))
  ok('the block is recorded', r.records.some((x) => x.event === 'step.blocked'))
}

{
  const r = rig(chain)
  r.tracker.noteStatus(r.node('a'), 'idle')
  r.tracker.noteTurn(r.node('a'), 'done')
  r.tracker.noteExit(r.node('a'), 0)
  const s = r.tracker.snapshot()
  ok('an agent exiting AFTER finishing is not a failure', s.steps[0].status === 'done')
  ok('and nothing downstream is blocked', s.steps[1].status === 'pending')
}

{
  // Three deep, so blocking has to be transitive rather than one level.
  const deep = V({
    steps: [
      { ref: 'a', agentKind: 'claude', title: 'A', role: 'B', brief: 'go' },
      { ref: 'b', agentKind: 'claude', title: 'B', role: 'B', brief: 'go', dependsOn: 'a' },
      { ref: 'c', agentKind: 'claude', title: 'C', role: 'B', brief: 'go', dependsOn: 'b' }
    ]
  }).plan
  const r = rig(deep)
  r.tracker.noteStatus(r.node('a'), 'idle')
  r.tracker.noteExit(r.node('a'), 137)
  const s = r.tracker.snapshot()
  ok('blocking reaches the whole chain', s.steps[1].status === 'blocked' && s.steps[2].status === 'blocked')
  ok('the mission fails once nothing can move', s.status === 'failed')
}

// ═══ 7. The tracker — abort, stall, and edges ═════════════════════════════

{
  const r = rig(chain)
  r.tracker.noteStatus(r.node('a'), 'idle')
  r.tracker.abort('Stopped by the operator.')
  const s = r.tracker.snapshot()
  ok('aborting stops the mission', s.status === 'aborted')
  ok('in-flight steps are marked blocked', s.steps[0].status === 'blocked')
  ok('pending steps are marked blocked too', s.steps[1].status === 'blocked')
  ok('the abort is recorded', r.records.some((x) => x.event === 'mission.aborted'))

  const before = r.delivered.length
  r.tracker.noteStatus(r.node('b'), 'idle')
  r.tracker.noteTurn(r.node('b'), 'late output')
  ok('nothing is dispatched after an abort', r.delivered.length === before)
  ok('a late turn does not revive an aborted mission', r.tracker.snapshot().status === 'aborted')
}

{
  const r = rig(chain)
  r.tracker.noteStatus(r.node('a'), 'idle')
  ok('a fresh mission is not stalled', r.tracker.snapshot().stalled === false)
  r.tick(STALL_AFTER_MS + 1)
  ok('a mission with no movement reads as stalled', r.tracker.snapshot().stalled === true)
  r.tracker.noteTurn(r.node('a'), 'progress at last')
  ok('progress clears the stall', r.tracker.snapshot().stalled === false)
}

{
  // The node exists on the canvas but its CLI never came up.
  const r = rig(chain, { sessions: {} })
  r.tracker.noteStatus(r.node('a'), 'idle')
  ok('a step with no session is not dispatched', r.delivered.length === 0)
  ok('and it stays pending rather than failing', r.tracker.snapshot().steps[0].status === 'pending')
}

{
  // A brief made entirely of control characters sanitises to nothing. Sending
  // it would submit a bare Enter into a freshly booted CLI.
  const nasty = V({
    steps: [{ ref: 'a', agentKind: 'claude', title: 'A', role: 'B', brief: '\u001b[2J\u0007' }]
  }).plan
  const r = rig(nasty)
  r.tracker.noteStatus(r.node('a'), 'idle')
  ok('a brief that cleans to nothing is never sent', r.delivered.length === 0)
  ok('and the step is failed rather than left hanging', r.tracker.snapshot().steps[0].status === 'failed')
}

{
  // Escape sequences inside an otherwise real brief must not reach the pty.
  const nasty = V({
    steps: [
      {
        ref: 'a',
        agentKind: 'claude',
        title: 'A',
        role: 'B',
        brief: 'Fix \u001b]0;pwned\u0007 the \u001b[31mbug\u001b[0m now'
      }
    ]
  }).plan
  const r = rig(nasty)
  r.tracker.noteStatus(r.node('a'), 'idle')
  const sent = r.delivered[0].text
  // eslint-disable-next-line no-control-regex
  ok('escape sequences are stripped before the terminal', !/[\u0000-\u001f\u007f]/.test(sent.slice(0, -1)))
  ok('the carriage return is the only control character', sent.endsWith('\r'))
  ok('the real words survive', sent.includes('Fix') && sent.includes('bug'))
}

{
  // An unknown node id must not throw — the canvas can have nodes the mission
  // knows nothing about.
  const r = rig(chain)
  let threw = false
  try {
    r.tracker.noteStatus('some_other_node', 'idle')
    r.tracker.noteTurn('some_other_node', 'hello')
    r.tracker.noteExit('some_other_node', 1)
  } catch {
    threw = true
  }
  ok('events for unrelated nodes are ignored', !threw)
  ok('and change nothing', r.tracker.snapshot().totals.done === 0)
}

{
  // Fan-out: one root, two dependents. Only the root is ever dispatched.
  const fan = V({
    steps: [
      { ref: 'a', agentKind: 'claude', title: 'A', role: 'Build', brief: 'build' },
      { ref: 'b', agentKind: 'codex', title: 'B', role: 'Review', brief: 'review', dependsOn: 'a' },
      { ref: 'c', agentKind: 'gemini', title: 'C', role: 'Test', brief: 'test', dependsOn: 'a' }
    ]
  }).plan
  const r = rig(fan)
  r.tracker.noteStatus(r.node('a'), 'idle')
  r.tracker.noteStatus(r.node('b'), 'idle')
  r.tracker.noteStatus(r.node('c'), 'idle')
  ok('fan-out dispatches the root only', r.delivered.length === 1)

  r.tracker.noteTurn(r.node('a'), 'built')
  r.tracker.noteTurn(r.node('b'), 'reviewed')
  ok('the mission waits for the last branch', r.tracker.snapshot().status === 'running')
  r.tracker.noteTurn(r.node('c'), 'tested')
  ok('the mission completes when both branches land', r.tracker.snapshot().status === 'done')
}

{
  // A snapshot must be a copy: handing the renderer live internals would let a
  // stale render mutate the mission.
  const r = rig(chain)
  const snap = r.tracker.snapshot()
  const before = snap.steps[0].status
  snap.steps[0].status = 'done'
  snap.status = 'done'
  ok('the snapshot is a copy, not the live state', r.tracker.snapshot().steps[0].status === before)
  ok('and the mission status is untouched', r.tracker.snapshot().status === 'running')
}

// ═══ Report ═══════════════════════════════════════════════════════════════

for (const p of PASS) console.log(`  ✓ ${p}`)
for (const f of FAIL) console.error(`  ✗ ${f}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exit(FAIL.length ? 1 : 0)
