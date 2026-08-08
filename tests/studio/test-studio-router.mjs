/**
 * Router tests: the canvas strings carrying real data.
 *
 * Two things here are genuinely dangerous and get the most attention:
 *
 *   1. **Runaway graphs.** A loop edge, or a cycle wired out of handoffs, can
 *      drive agents at each other until the API quota is gone. Every ceiling is
 *      tested by actually building the graph that would run away.
 *   2. **Routing nothing.** A CLI parking at its prompt on startup looks exactly
 *      like a finished turn. Handing the welcome banner to the next agent would
 *      be worse than not routing at all.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const {
  StudioRouter,
  clampOutput,
  toSingleLine,
  reframePrompt,
  reframeWithModel,
  MAX_CASCADE_DELIVERIES,
  MAX_CASCADE_DEPTH,
  MAX_OUTPUT_CHARS,
  NOTHING_TO_DO
} = require('./router.test.cjs')
const { TerminalScreen, tidyScreen } = require('./terminal-screen.test.cjs')
const { validateMutations, commandPrompt, MAX_MUTATIONS } = require('./command.test.cjs')
const { visibleNodeIds, sameIds, CULL_MARGIN } = require('./viewport-cull.test.cjs')
const adapters = require('./adapters.test.cjs')

// ═══ 1. Screen reconstruction ═════════════════════════════════════════════
//
// These are the cases the old regex-based cleaner got wrong. A terminal
// emulator gets them right because it is not guessing at the byte stream — it
// is running the same state machine the visible terminal runs.

/** Feed bytes through a real emulator and read what it rendered. */
async function render(bytes, cols = 80) {
  const s = new TerminalScreen(cols, 24)
  s.write(bytes)
  await s.flush()
  const out = tidyScreen(s.read())
  s.dispose()
  return out
}

ok('strips ANSI colour', (await render('\x1b[32mdone\x1b[0m')) === 'done')

ok(
  'carriage-return redraws keep only the final frame',
  (await render('Progress 10%\rProgress 50%\rProgress 100%\r\n')) === 'Progress 100%'
)

{
  // The case the byte-level cleaner could not handle: cursor up + erase line.
  // Only the erased row changes — the row below it was never touched, and a
  // real terminal still shows it.
  const out = await render('draft a\r\ndraft b\r\n\x1b[2A\x1b[2KFINAL A\r\n')
  ok('cursor-up rewrites replace the draft', out.includes('FINAL A'), JSON.stringify(out))
  ok('the overwritten line is gone', !out.includes('draft a'), JSON.stringify(out))
  ok('a line that was never erased survives', out.includes('draft b'), JSON.stringify(out))
}

{
  // Erase-in-display: a TUI clearing the screen before a repaint.
  const out = await render('stale content\r\n\x1b[2J\x1b[Hfresh content\r\n')
  ok('erase-in-display clears what came before', !out.includes('stale'), JSON.stringify(out))
  ok('content after the clear survives', out.includes('fresh content'))
}

{
  // Wrapping is a display detail, not a paragraph break.
  const sentence = 'The quick brown fox jumps over the lazy dog and keeps on running past the end'
  const out = await render(sentence + '\r\n', 40)
  ok('wrapped lines are rejoined into one logical line', out === sentence, JSON.stringify(out))
}

{
  const out = await render('⠋\r\n⠙\r\n⠹\r\nBuild succeeded\r\n')
  ok('spinner frames are dropped', out === 'Build succeeded', JSON.stringify(out))
}

{
  const out = await render('╭────────╮\r\n│ hello  │\r\n╰────────╯\r\n')
  ok('box borders are dropped but content survives', out.includes('hello') && !out.includes('╭'))
}

{
  // The old cleaner de-duplicated adjacent identical lines to hide redraw
  // frames. Now that redraws are handled properly, real repeats must survive.
  const out = await render('FAIL should render\r\nFAIL should render\r\n')
  ok(
    'genuinely repeated lines are no longer swallowed',
    out === 'FAIL should render\nFAIL should render',
    JSON.stringify(out)
  )
}

ok('blank output stays blank', (await render('   \r\n\r\n  \r\n')) === '')

ok(
  'a screen reset drops the previous turn',
  await (async () => {
    const s = new TerminalScreen(80, 24)
    s.write('previous turn\r\n')
    await s.flush()
    s.reset()
    s.write('this turn\r\n')
    await s.flush()
    const out = tidyScreen(s.read())
    s.dispose()
    return out === 'this turn'
  })()
)

// ─── Adapter chrome stripping ────────────────────────────────────────────

{
  const shell = adapters.getAdapter('shell')
  const screen = ['PS C:\\repo> npm test', 'Tests: 9 passed', 'PS C:\\repo>'].join('\n')
  const out = shell.extractResponse(screen)
  ok(
    'shell strips the echoed prompt and the next prompt',
    out === 'Tests: 9 passed',
    JSON.stringify(out)
  )
}

{
  const shell = adapters.getAdapter('shell')
  // A prompt-shaped line surrounded by output is content, not chrome. Only the
  // edges are trimmed, so it survives.
  const screen = [
    'PS C:\\repo> cat run.sh',
    'echo hi',
    'PS C:\\repo> exit 0',
    'done',
    'PS C:\\repo>'
  ].join('\n')
  const out = shell.extractResponse(screen)
  ok(
    'a prompt-shaped line inside output survives',
    out === 'echo hi\nPS C:\\repo> exit 0\ndone',
    JSON.stringify(out)
  )
}

{
  const shell = adapters.getAdapter('shell')
  // Regression: `[^\n]*[$#%]` matched any line containing a percent sign, so
  // a perfectly ordinary result line was being stripped as a shell prompt.
  const screen = ['PS C:\\repo> npm test', 'Tests: 100% passed', 'PS C:\\repo>'].join('\n')
  const out = shell.extractResponse(screen)
  ok(
    'a percentage in output is not mistaken for a prompt',
    out === 'Tests: 100% passed',
    JSON.stringify(out)
  )
}

{
  const shell = adapters.getAdapter('shell')
  const screen = ['user@host:~/repo$ npm test', 'ok', 'user@host:~/repo$'].join('\n')
  const out = shell.extractResponse(screen)
  ok('POSIX prompts are trimmed too', out === 'ok', JSON.stringify(out))
}

{
  const gemini = adapters.getAdapter('gemini')
  const screen = ['Type your message', 'I refactored auth.ts', '❯', 'ctrl+c to quit'].join('\n')
  const out = gemini.extractResponse(screen)
  ok('gemini strips its TUI furniture', out === 'I refactored auth.ts', JSON.stringify(out))
}

{
  const claude = adapters.getAdapter('claude')
  const screen = ['✻ Welcome to Claude Code', 'Added the toggle.', '? for shortcuts'].join('\n')
  const out = claude.extractResponse(screen)
  ok('claude strips its banner and footer', out === 'Added the toggle.', JSON.stringify(out))
}

// ─── Clamping ────────────────────────────────────────────────────────────

const long = clampOutput('x'.repeat(MAX_OUTPUT_CHARS + 5000) + '\nTHE CONCLUSION')
ok('oversized output keeps the tail, not the head', long.endsWith('THE CONCLUSION'))
ok('oversized output is marked as trimmed', long.startsWith('…'))

// ═══ 2. Single-line instructions ══════════════════════════════════════════

ok(
  'newlines are flattened',
  toSingleLine('do this\nthen that') === 'do this then that',
  toSingleLine('do this\nthen that')
)
ok('runs of whitespace collapse', toSingleLine('a    b') === 'a b')
ok('a very long instruction is clamped', toSingleLine('y'.repeat(5000)).length <= 1200)

// ═══ 3. Reframe prompt shape ══════════════════════════════════════════════

const loopPrompt = reframePrompt({
  output: 'tests failed: 2 of 9',
  edgeKind: 'loop',
  edgeLabel: 'revise until green',
  fromTitle: 'Vega',
  fromKind: 'codex',
  toTitle: 'Apollo',
  toKind: 'claude',
  iteration: 2
})
ok('reframe prompt carries the edge label', loopPrompt.includes('revise until green'))
ok('reframe prompt states the loop pass', loopPrompt.includes('pass 2'))
ok('reframe prompt includes the upstream output', loopPrompt.includes('tests failed: 2 of 9'))
ok('reframe prompt names the downstream agent', loopPrompt.includes('Apollo'))

const fakeModel = {
  complete: async () => ({ text: '  Fix the two failing tests.\n' })
}
ok(
  'reframeWithModel returns a clean single line',
  (await reframeWithModel(fakeModel, {
    output: 'x',
    edgeKind: 'handoff',
    fromTitle: 'A',
    fromKind: 'claude',
    toTitle: 'B',
    toKind: 'codex',
    iteration: 1
  })) === 'Fix the two failing tests.'
)

// ═══ 4. Router behaviour ══════════════════════════════════════════════════

const jsonAdapter = {
  kind: 'claude',
  parseEvent(line) {
    const t = line.trim()
    if (!t.startsWith('{')) return null
    try {
      const m = JSON.parse(t)
      if (m.type === 'result') return { type: 'turn-complete', text: m.result }
      if (m.type === 'system') return { type: 'session', agentSessionId: m.session_id }
      return null
    } catch {
      return null
    }
  }
}

/** Build a router with recording deps. */
function makeRouter({ reframe, nodes, edges, autoRoute = true }) {
  const delivered = []
  const routed = []
  const logs = []
  const r = new StudioRouter({
    deliver: (sessionId, text) => delivered.push({ sessionId, text }),
    emit: (e) => e.type === 'routed' && routed.push(e),
    log: (l) => logs.push(l),
    reframe: reframe ?? (async (i) => `next: ${i.output.slice(0, 40)}`)
  })
  r.setGraph({ nodes, edges, autoRoute })
  return { r, delivered, routed, logs }
}

const node = (id, title, extra = {}) => ({
  id,
  kind: 'agent',
  agentKind: 'claude',
  title,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  ...extra
})

/** Drive a full turn: work happens, then the agent parks at its prompt. */
async function runTurn(r, sessionId, output, settle = 90) {
  r.onStatus(sessionId, 'busy')
  r.observe(sessionId, output)
  r.onStatus(sessionId, 'idle')
  await sleep(settle)
}

/**
 * Run the graph the way it actually runs.
 *
 * An agent only takes a turn because something was typed into it, so driving
 * turns on a fixed schedule would invent work no delivery caused — and every
 * such turn looks human-started, which legitimately grants a fresh cascade.
 * This pumps deliveries instead: one seed turn, then a turn for each delivery
 * that seed produced, until the graph goes quiet on its own.
 */
async function pump(r, delivered, seedSession, seedOutput, maxTurns = 80) {
  await runTurn(r, seedSession, seedOutput)
  let cursor = 0
  let turns = 0
  while (cursor < delivered.length && turns < maxTurns) {
    const d = delivered[cursor++]
    await runTurn(r, d.sessionId, `work produced by ${d.sessionId}`, 55)
    turns++
  }
  return turns
}

// ── The boot-banner case ──────────────────────────────────────────────────
{
  const { r, delivered } = makeRouter({
    nodes: [node('n1', 'Apollo'), node('n2', 'Vega')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }]
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)

  // Agent starts up, prints a banner, parks at its prompt. No work happened.
  r.observe('s1', 'Welcome to Claude Code!\n')
  r.onStatus('s1', 'idle')
  await sleep(60)
  ok('idle without work does not route the startup banner', delivered.length === 0)

  await runTurn(r, 's1', 'Added the dark-mode toggle in theme.ts')
  ok('a real turn does route', delivered.length === 1)
  ok('handoff lands in the downstream session', delivered[0]?.sessionId === 's2')
  ok(
    'delivered text carries no Enter of its own',
    !delivered[0]?.text.includes('\r'),
    JSON.stringify(delivered[0]?.text.slice(-12))
  )
  ok('delivered text is one line', delivered[0]?.text.split('\n').length === 1)
  ok(
    'the upstream output reached the reframer',
    delivered[0]?.text.includes('Added the dark-mode toggle')
  )
}

// ── Auto-route off ────────────────────────────────────────────────────────
{
  const { r, delivered } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }],
    autoRoute: false
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)
  await runTurn(r, 's1', 'finished')
  ok('auto-route off keeps the strings decorative', delivered.length === 0)
}

// ── Branch fan-out ────────────────────────────────────────────────────────
{
  const { r, delivered, routed } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B'), node('n3', 'C')],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', kind: 'branch' },
      { id: 'e2', source: 'n1', target: 'n3', kind: 'branch' }
    ]
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)
  r.bind('s3', 'n3', null)
  await runTurn(r, 's1', 'research complete', 120)
  ok('branch reaches every downstream agent', delivered.length === 2, `${delivered.length}`)
  ok('both branch targets are distinct', new Set(delivered.map((d) => d.sessionId)).size === 2)
  ok('each delivery emits a routed event', routed.length === 2)
}

// ── Structured output beats the transcript ────────────────────────────────
{
  const seen = []
  const { r } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }],
    reframe: async (i) => {
      seen.push(i.output)
      return 'go'
    }
  })
  r.bind('s1', 'n1', jsonAdapter)
  r.bind('s2', 'n2', null)

  r.onStatus('s1', 'busy')
  r.observe('s1', 'noisy TUI frames everywhere\n')
  r.observe('s1', JSON.stringify({ type: 'result', result: 'THE EXACT ANSWER' }) + '\n')
  await sleep(80)
  ok('a JSON turn-complete routes without waiting for idle', seen.length === 1)
  ok('structured output is preferred over the transcript', seen[0] === 'THE EXACT ANSWER', seen[0])
}

// ── JSON split across chunks ──────────────────────────────────────────────
{
  const { r } = makeRouter({ nodes: [node('n1', 'A')], edges: [] })
  r.bind('s1', 'n1', jsonAdapter)
  const half = JSON.stringify({ type: 'system', session_id: 'abc-123' })
  const events = [...r.observe('s1', half.slice(0, 12)), ...r.observe('s1', half.slice(12) + '\n')]
  ok(
    'a JSON object split across chunks still parses',
    events.some((e) => e.type === 'session' && e.agentSessionId === 'abc-123')
  )
}

// ── Loop cap, and the reset that matters ──────────────────────────────────
{
  const { r, delivered, logs } = makeRouter({
    nodes: [node('n1', 'Builder'), node('n2', 'Reviewer')],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' },
      { id: 'e2', source: 'n2', target: 'n1', kind: 'loop', maxIterations: 2 }
    ]
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)

  // One human prompt, then let the two agents bounce until they stop.
  await pump(r, delivered, 's1', 'built it')
  const loopDeliveries = delivered.filter((d) => d.sessionId === 's1').length
  ok('loop edge stops at its cap', loopDeliveries === 2, `${loopDeliveries} loop deliveries`)
  ok(
    'the forward handoff still fires on every pass',
    delivered.filter((d) => d.sessionId === 's2').length === 3,
    `${delivered.filter((d) => d.sessionId === 's2').length} forward handoffs`
  )
  ok(
    'hitting the cap is reported, not silent',
    logs.some((l) => l.includes('hit its cap'))
  )

  // A NEW human prompt must get a fresh allowance — this is the cascade design.
  const before = delivered.filter((d) => d.sessionId === 's1').length
  await runTurn(r, 's2', 'fresh human-started review')
  ok(
    'a new human prompt resets the loop allowance',
    delivered.filter((d) => d.sessionId === 's1').length === before + 1
  )
}

// ── A cycle built from plain handoffs still terminates ────────────────────
{
  const { r, delivered } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B'), node('n3', 'C')],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' },
      { id: 'e2', source: 'n2', target: 'n3', kind: 'handoff' },
      { id: 'e3', source: 'n3', target: 'n1', kind: 'handoff' }
    ]
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)
  r.bind('s3', 'n3', null)

  const turns = await pump(r, delivered, 's1', 'start')
  ok(
    'an unmarked cycle cannot run away',
    delivered.length <= MAX_CASCADE_DELIVERIES,
    `${delivered.length} deliveries`
  )
  ok('the cycle actually stopped on its own', turns < 80, `${turns} turns`)
}

// ── Depth ceiling ─────────────────────────────────────────────────────────
{
  const n = 10
  const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`, `A${i}`))
  const edges = Array.from({ length: n - 1 }, (_, i) => ({
    id: `e${i}`,
    source: `n${i}`,
    target: `n${i + 1}`,
    kind: 'handoff'
  }))
  const { r, delivered, logs } = makeRouter({ nodes, edges })
  nodes.forEach((nd, i) => r.bind(`s${i}`, nd.id, null))

  await pump(r, delivered, 's0', 'kick off')

  ok(
    'a long chain stops at the depth ceiling',
    delivered.length === MAX_CASCADE_DEPTH,
    `${delivered.length} deliveries, ceiling ${MAX_CASCADE_DEPTH}`
  )
  ok(
    'the depth stop is reported',
    logs.some((l) => l.includes('deep'))
  )
}

// ── Skips that must not crash ─────────────────────────────────────────────
{
  const { r, delivered, logs } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }]
  })
  r.bind('s1', 'n1', null) // n2 has no session at all
  await runTurn(r, 's1', 'done')
  ok('a target with no terminal is skipped, not crashed', delivered.length === 0)
  ok(
    'the missing terminal is explained',
    logs.some((l) => l.includes('no running terminal'))
  )
}

{
  const { r, delivered, logs } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B', { autoReply: false })],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }]
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)
  await runTurn(r, 's1', 'done')
  ok('a node with auto-reply off is not driven', delivered.length === 0)
  ok(
    'auto-reply off is explained',
    logs.some((l) => l.includes('auto-reply off'))
  )
}

{
  const { r, delivered } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }],
    reframe: async () => NOTHING_TO_DO
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)
  await runTurn(r, 's1', 'all green, nothing left')
  ok('NOTHING_TO_DO ends the chain instead of looping', delivered.length === 0)
}

{
  const { r, delivered, logs } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }],
    reframe: async () => {
      throw new Error('groq is down')
    }
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)
  await runTurn(r, 's1', 'the important result')
  ok('a failed reframe does not lose the handoff', delivered.length === 1)
  ok(
    'the fallback still carries the upstream output',
    delivered[0]?.text.includes('the important result')
  )
  ok(
    'the reframe failure is reported',
    logs.some((l) => l.includes('reframe failed'))
  )
}

{
  const { r, delivered } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }]
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)
  r.onStatus('s1', 'busy')
  r.observe('s1', '\x1b[2m⠋\x1b[0m\r\n⠙\r\n')
  r.onStatus('s1', 'idle')
  await sleep(90)
  ok('a turn that produced only spinner noise routes nothing', delivered.length === 0)
}

{
  const { r, delivered } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }]
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)
  await runTurn(r, 's1', 'result one')
  const after = delivered.length
  // Idle can be re-asserted by a redraw; the turn is already spent.
  r.onStatus('s1', 'idle')
  await sleep(60)
  ok('a spent turn does not re-fire on a repeat idle', delivered.length === after)
}

{
  const { r, delivered } = makeRouter({
    nodes: [node('n1', 'A'), node('n2', 'B')],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', kind: 'handoff' }]
  })
  r.bind('s1', 'n1', null)
  r.bind('s2', 'n2', null)
  r.unbind('s2')
  await runTurn(r, 's1', 'done')
  ok('unbinding a session removes it as a routing target', delivered.length === 0)
}

// ═══ 5. Command-bar validation ════════════════════════════════════════════

const NODES = [node('nA', 'Apollo'), node('nB', 'Vega')]
const AVAIL = ['claude', 'codex', 'shell']
const V = (ops) => validateMutations({ ops }, { nodes: NODES, availableKinds: AVAIL })

ok(
  'garbage input yields no mutations',
  validateMutations(null, { nodes: [], availableKinds: [] }).mutations.length === 0
)
ok(
  'a bare array is accepted too',
  validateMutations([{ op: 'remove-node', target: 'nA' }], { nodes: NODES, availableKinds: AVAIL })
    .mutations.length === 1
)

{
  const { mutations, skipped } = V([{ op: 'add-node', ref: 'a', agentKind: 'hermes', title: 'X' }])
  ok('an invented agent kind is rejected', mutations.length === 0)
  ok('the rejection says which kind', skipped.join(' ').includes('hermes'))
}

{
  const { mutations } = V([{ op: 'add-node', ref: 'a', agentKind: 'gemini', title: 'X' }])
  ok('an agent that is not installed is rejected', mutations.length === 0)
}

{
  const { mutations } = V([
    { op: 'add-node', ref: 'a', agentKind: 'claude', title: 'Orion' },
    { op: 'add-node', ref: 'b', agentKind: 'codex', title: 'Atlas' },
    { op: 'connect', from: 'a', to: 'b', kind: 'handoff' }
  ])
  ok('nodes added in the same batch can be connected', mutations.length === 3)
  ok('the connection resolves both new refs', mutations[2].from === 'a' && mutations[2].to === 'b')
}

{
  const { mutations } = V([{ op: 'connect', from: 'apollo', to: 'VEGA', kind: 'handoff' }])
  ok(
    'existing nodes resolve by title, case-insensitively',
    mutations[0]?.from === 'nA' && mutations[0]?.to === 'nB'
  )
}

{
  const { mutations, skipped } = V([{ op: 'connect', from: 'nA', to: 'ghost', kind: 'handoff' }])
  ok('a hallucinated node reference is dropped', mutations.length === 0)
  ok('the dropped connection is reported', skipped.length === 1)
}

{
  const { mutations } = V([{ op: 'connect', from: 'nA', to: 'nA', kind: 'handoff' }])
  ok('a node cannot be connected to itself', mutations.length === 0)
}

{
  const { mutations } = V([{ op: 'connect', from: 'nA', to: 'nB', kind: 'teleport' }])
  ok('an unknown edge kind falls back to handoff', mutations[0]?.kind === 'handoff')
}

{
  const { mutations } = V([
    { op: 'connect', from: 'nA', to: 'nB', kind: 'loop', maxIterations: 9999 }
  ])
  ok('an absurd iteration cap is clamped', mutations[0]?.maxIterations === 10)
}

{
  const { mutations } = V([
    { op: 'connect', from: 'nA', to: 'nB', kind: 'loop', maxIterations: -4 }
  ])
  ok('a negative iteration cap is clamped to 1', mutations[0]?.maxIterations === 1)
}

{
  const many = Array.from({ length: 40 }, () => ({ op: 'remove-node', target: 'nA' }))
  const { mutations, skipped } = V(many)
  ok('the batch is capped', mutations.length === MAX_MUTATIONS)
  ok('the cap is reported', skipped.join(' ').includes(String(MAX_MUTATIONS)))
}

{
  const { mutations } = V([{ op: 'prompt', target: 'Apollo', text: 'add tests' }])
  ok('a prompt op resolves its target', mutations[0]?.target === 'nA')
}

{
  const { mutations } = V([{ op: 'prompt', target: 'Apollo', text: '   ' }])
  ok('an empty prompt is dropped', mutations.length === 0)
}

{
  const { mutations } = V([{ op: 'demolish', target: 'nA' }])
  ok('an unknown operation is dropped', mutations.length === 0)
}

{
  const { mutations } = V([{ op: 'add-node', ref: 'nA', agentKind: 'claude', title: 'Dupe' }])
  ok('a ref that collides with a real node id is rejected', mutations.length === 0)
}

const cp = commandPrompt('connect them', NODES, [], AVAIL)
ok('the command prompt lists existing nodes', cp.includes('Apollo') && cp.includes('Vega'))
ok('the command prompt lists only available kinds', cp.includes('claude') && !cp.includes('gemini'))
ok('an empty canvas is described as empty', commandPrompt('x', [], [], AVAIL).includes('empty'))

// ═══ 6. Terminal virtualisation ═══════════════════════════════════════════
//
// Getting this wrong is subtle in both directions: cull too eagerly and
// terminals blank out while visibly on screen; cull too late and the canvas
// pays for every xterm whether or not you are looking at it.

const box = (id, x, y) => ({ id, x, y, width: 400, height: 340 })
const view = (over = {}) => ({ x: 0, y: 0, zoom: 1, width: 1280, height: 800, ...over })

{
  const live = visibleNodeIds([box('a', 0, 0)], view())
  ok('a node at the origin is live', live.has('a'))
}

{
  // Just past the right edge but inside the margin — still live, so a slow pan
  // does not flicker.
  const live = visibleNodeIds([box('a', 1280 + 100, 0)], view())
  ok('a node just off-screen stays live inside the margin', live.has('a'))
}

{
  const live = visibleNodeIds([box('a', 1280 + CULL_MARGIN * 3, 0)], view())
  ok('a node far off-screen is culled', !live.has('a'))
}

{
  // Zoomed out, far more of the graph is on screen.
  const far = box('a', 3000, 0)
  ok('zoomed in, a distant node is culled', !visibleNodeIds([far], view({ zoom: 1 })).has('a'))
  ok('zoomed out, the same node is live', visibleNodeIds([far], view({ zoom: 0.25 })).has('a'))
}

{
  // Panning right (negative x offset) brings right-hand nodes into view.
  const n = box('a', 4000, 0)
  ok('panned away, the node is culled', !visibleNodeIds([n], view()).has('a'))
  ok('panned to it, the node is live', visibleNodeIds([n], view({ x: -3900 })).has('a'))
}

{
  const n = box('a', 0, 4000)
  ok('vertical panning works the same way', visibleNodeIds([n], view({ y: -3900 })).has('a'))
}

{
  ok(
    'a zoom of zero does not divide by zero',
    visibleNodeIds([box('a', 0, 0)], view({ zoom: 0 })).has('a')
  )
}

{
  // The 10-node feel check, as arithmetic: a realistic spread should keep only
  // the nearby windows mounted.
  const many = Array.from({ length: 12 }, (_, i) =>
    box(`n${i}`, (i % 4) * 3000, Math.floor(i / 4) * 3000)
  )
  const live = visibleNodeIds(many, view())
  ok('a wide 12-node canvas mounts only a few terminals', live.size <= 4, `${live.size} live`)
  ok('at least the node under the viewport is mounted', live.has('n0'))
}

ok('sameIds is true for equal sets', sameIds(new Set(['a', 'b']), new Set(['b', 'a'])))
ok('sameIds is false when one differs', !sameIds(new Set(['a']), new Set(['b'])))
ok('sameIds is false on different sizes', !sameIds(new Set(['a']), new Set(['a', 'b'])))
ok('sameIds short-circuits on identity', sameIds(new Set(['a']), new Set(['a'])))

// ═══ 7. Windows binary resolution ═════════════════════════════════════════
//
// Regression: `where claude` lists the extensionless POSIX shell script BEFORE
// the .cmd shim, and taking the first result handed node-pty a script. Windows
// answered `CreateProcess ... error code: 193`, which named neither the file
// nor the reason. Every npm-installed agent CLI hit this.

const NPM = 'C:\\Users\\Someone\\AppData\\Roaming\\npm\\'

{
  const picked = adapters.pickExecutable([NPM + 'claude', NPM + 'claude.cmd'], 'win32')
  ok(
    'the .cmd shim wins over the extensionless script',
    picked === NPM + 'claude.cmd',
    String(picked)
  )
}

{
  // Order must not matter — `where` output is not something to rely on.
  const picked = adapters.pickExecutable([NPM + 'claude.cmd', NPM + 'claude'], 'win32')
  ok('ordering does not change the choice', picked === NPM + 'claude.cmd', String(picked))
}

{
  const picked = adapters.pickExecutable(
    [NPM + 'tool', NPM + 'tool.cmd', 'C:\\bin\\tool.exe'],
    'win32'
  )
  ok('a real .exe beats the .cmd shim', picked === 'C:\\bin\\tool.exe', String(picked))
}

{
  const picked = adapters.pickExecutable([NPM + 'claude', NPM + 'claude.ps1'], 'win32')
  ok('scripts alone resolve to nothing rather than error 193', picked === null, String(picked))
}

{
  const picked = adapters.pickExecutable([NPM + 'x.BAT'], 'win32')
  ok('extension matching is case-insensitive', picked === NPM + 'x.BAT', String(picked))
}

{
  // POSIX has no extension convention; `which` returns exactly one answer.
  const picked = adapters.pickExecutable(['/usr/local/bin/claude'], 'linux')
  ok('POSIX keeps the first result', picked === '/usr/local/bin/claude', String(picked))
}

ok('no candidates resolves to nothing', adapters.pickExecutable([], 'win32') === null)
ok('blank lines are ignored', adapters.pickExecutable(['', '   '], 'linux') === null)

// ═══ 8. Shared project context ════════════════════════════════════════════
//
// Two agents in one repository have to know what the other just did, or they
// duplicate work and overwrite each other's files. This is what makes them
// usable in parallel rather than merely simultaneous.

const nodefs = require('fs')
const nodepath = require('path')
const nodeos = require('os')
const project = require('./project.test.cjs')

{
  // A folder inside a repo must resolve to the repo, so an agent opened in
  // src/renderer and one opened at the root share a project.
  const repo = nodefs.mkdtempSync(nodepath.join(nodeos.tmpdir(), 'brutus-proj-'))
  nodefs.mkdirSync(nodepath.join(repo, '.git'))
  const deep = nodepath.join(repo, 'src', 'renderer')
  nodefs.mkdirSync(deep, { recursive: true })

  const fromRoot = project.resolveProjectRoot(repo)
  const fromDeep = project.resolveProjectRoot(deep)
  ok('a repository root is detected', fromRoot.isRepo === true)
  ok('a subfolder resolves up to the repository', fromDeep.root === fromRoot.root, fromDeep.root)
  ok('the project is named after its folder', fromRoot.name === nodepath.basename(repo))

  // A loose folder is still a project, just not a repository.
  const loose = nodefs.mkdtempSync(nodepath.join(nodeos.tmpdir(), 'brutus-loose-'))
  const canonicalLoose = nodefs.realpathSync.native(loose)
  const l = project.resolveProjectRoot(loose)
  ok('a folder with no repo is still usable', l.root === canonicalLoose, l.root)
  ok('and is reported as not a repository', l.isRepo === false)

  /**
   * Regression: this machine has a `.git` in the home directory, and the walk
   * climbed into it — so every unrelated folder resolved to "the home project".
   * It slipped through because `os.tmpdir()` yields the 8.3 short name
   * (`C:\Users\ADITYA~1`) while `os.homedir()` yields the long one, and the two
   * never compared equal.
   */
  ok(
    'the home directory is never the project root',
    project.resolveProjectRoot(nodeos.homedir()).isRepo === false ||
      project.resolveProjectRoot(nodeos.homedir()).root !==
        nodefs.realpathSync.native(nodeos.homedir()),
    JSON.stringify(project.resolveProjectRoot(nodeos.homedir()))
  )
  ok(
    'a temp folder does not inherit a repo from the home directory',
    !l.isRepo && l.root === canonicalLoose
  )

  ok(
    'a missing folder does not throw',
    project.resolveProjectRoot(nodepath.join(repo, 'nope')).root.length > 0
  )
}

{
  const root = 'C:/work/app'
  const files = project.filesFromToolInput('Edit', { file_path: 'C:/work/app/src/a.ts' }, root)
  ok('an absolute path inside the project is captured', files.includes('src/a.ts'), String(files))
}

{
  const root = 'C:/work/app'
  ok(
    'a relative path is captured',
    project.filesFromToolInput('Write', { path: 'src/b.ts' }, root).includes('src/b.ts')
  )
  ok(
    'a path outside the project is ignored',
    project.filesFromToolInput('Edit', { file_path: 'C:/elsewhere/x.ts' }, root).length === 0
  )
  ok(
    'batched edits are captured',
    project.filesFromToolInput(
      'Edit',
      { edits: [{ file_path: 'src/c.ts' }, { path: 'src/d.ts' }] },
      root
    ).length === 2
  )
  ok(
    'files named in a shell command are captured',
    project
      .filesFromToolInput('Bash', { command: 'npx prettier --write src/e.ts' }, root)
      .includes('src/e.ts')
  )
  ok('a tool with no file is fine', project.filesFromToolInput('Read', {}, root).length === 0)
}

{
  const j = new project.ProjectJournal()
  const ROOT = '/repo'

  j.noteFiles('s1', ['src/auth.ts'])
  j.record(ROOT, 's1', { agent: 'Apollo', kind: 'claude', summary: 'Added the login form' })

  const digest = j.digest(ROOT, 'Vega')
  ok('the digest names the sibling agent', digest.includes('Apollo'))
  ok('the digest carries the summary', digest.includes('Added the login form'))
  ok('the digest lists the touched file', digest.includes('src/auth.ts'))
  ok('the digest warns against duplicate work', /do not redo/i.test(digest))

  ok('an agent does not see its own entries', j.digest(ROOT, 'Apollo') === '')
  ok('a different project shares nothing', j.digest('/other', 'Vega') === '')

  // Files noted during a turn are consumed by it, not leaked into the next.
  j.record(ROOT, 's1', { agent: 'Apollo', kind: 'claude', summary: 'Second turn' })
  const second = j.entriesFor(ROOT)[1]
  ok(
    'a new turn starts with no carried-over files',
    second.files.length === 0,
    JSON.stringify(second.files)
  )
}

{
  const j = new project.ProjectJournal()
  const ROOT = '/repo'
  for (let i = 0; i < 60; i++) {
    j.record(ROOT, 's' + i, { agent: 'A' + i, kind: 'claude', summary: 'turn ' + i })
  }
  ok('the journal is bounded', j.entriesFor(ROOT).length <= 40, String(j.entriesFor(ROOT).length))
  ok('the digest stays small enough to prepend to a prompt', j.digest(ROOT, 'x').length <= 1300)
  ok('the digest keeps the most recent work', j.digest(ROOT, 'x').includes('turn 59'))
}

{
  const j = new project.ProjectJournal()
  j.noteFiles('s1', ['a.ts'])
  j.forgetSession('s1')
  j.record('/repo', 's1', { agent: 'A', kind: 'claude', summary: 'x' })
  ok('forgetting a session drops its pending files', j.entriesFor('/repo')[0].files.length === 0)
}

// The reframe prompt must actually carry the context through.
{
  const withContext = reframePrompt({
    output: 'done',
    edgeKind: 'handoff',
    fromTitle: 'Apollo',
    fromKind: 'claude',
    toTitle: 'Vega',
    toKind: 'codex',
    iteration: 1,
    projectContext: 'PROJECT CONTEXT — other agents are working in this same repository.'
  })
  ok('project context reaches the reframe prompt', withContext.includes('PROJECT CONTEXT'))
  ok(
    'the prompt still works without any context',
    !reframePrompt({
      output: 'done',
      edgeKind: 'handoff',
      fromTitle: 'A',
      fromKind: 'claude',
      toTitle: 'B',
      toKind: 'codex',
      iteration: 1
    }).includes('PROJECT CONTEXT')
  )
}

// ═══ Report ══════════════════════════════════════════════════════════════

console.log(`PASS ${PASS.length}`)
PASS.forEach((p) => console.log(`  ✓ ${p}`))
if (FAIL.length) {
  console.log(`\nFAIL ${FAIL.length}`)
  FAIL.forEach((f) => console.log(`  ✗ ${f}`))
}
process.exit(FAIL.length ? 1 : 0)
