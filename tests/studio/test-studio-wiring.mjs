/**
 * Wiring tests: the policy engine connected to a live pty.
 *
 * The claim being tested is the headline one — that Brutus actually intercepts
 * an agent's permission prompt, holds the agent while a human decides, and then
 * answers on their behalf. A prompt that gets answered *after* the agent moved
 * on would be worse than useless, so the blocking is what matters.
 */
import { createRequire } from 'module'
import http from 'http'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { PtyManager, defaultShell } = require('./pty-manager.test.cjs')
const { PromptWatcher } = require('./prompt-watch.test.cjs')
const { startPolicyServer } = require('./policy-server.test.cjs')
const { decide } = require('./policy.test.cjs')
const adapters = require('./adapters.test.cjs')

// ═══ 1. PtyManager in-main hooks (what the watcher rides on) ══════════════
const events = []
const fakeWin = { isDestroyed: () => false, webContents: { send: (_c, e) => events.push(e) } }
const mgr = new PtyManager({ getWindow: () => fakeWin })

let hookedChunks = 0
let hookedExit = null
const offData = mgr.onData(() => hookedChunks++)
mgr.onExit((id, code) => (hookedExit = { id, code }))

const s = mgr.spawn({
  kind: 'shell',
  file: defaultShell(),
  args: [],
  cwd: process.cwd(),
  runMode: 'default'
})
await sleep(1300)
ok('onData hook receives the live stream', hookedChunks > 0, `${hookedChunks} chunks`)

// A throwing listener must not break the terminal.
mgr.onData(() => {
  throw new Error('bad listener')
})
const before = hookedChunks
mgr.write(s.id, 'echo STILL_ALIVE\r')
await sleep(1300)
ok('a throwing data hook does not break the stream', hookedChunks > before)
ok('output still reaches the renderer', mgr.scrollbackOf(s.id).includes('STILL_ALIVE'))

offData()
const afterOff = hookedChunks
mgr.write(s.id, 'echo AFTER_OFF\r')
await sleep(1200)
ok('unsubscribing stops delivery', hookedChunks === afterOff)

mgr.kill(s.id)
await sleep(400)

// ═══ 2. Pattern track end-to-end: watcher → policy → keystroke ════════════
const codex = adapters.getAdapter('codex')
const ROOT = process.cwd()

/** Mirrors the wiring in studio/index.ts attachWatcher(). */
function runPatternTrack({ output, autonomy }) {
  return new Promise((resolve) => {
    const written = []
    let asked = null
    const w = new PromptWatcher(codex, {
      onBusy: () => {},
      onIdle: () => {},
      onApproval: (hit) => {
        const command = hit.summary.replace(/^Run:\s*/i, '')
        const verdict = decide(
          { sessionId: 'x', toolName: 'Bash', toolInput: { command }, cwd: ROOT },
          { autonomy, workingDir: ROOT }
        )
        if (verdict.decision === 'allow') written.push(hit.pattern.yes)
        else if (verdict.decision === 'deny') written.push(hit.pattern.no)
        else asked = { summary: hit.summary, reason: verdict.reason, keys: hit.pattern }
      }
    })
    w.push(output)
    setTimeout(() => {
      w.dispose()
      resolve({ written, asked })
    }, 700)
  })
}

const safeRun = await runPatternTrack({
  output: 'Allow this command? $ git status  (y/n)',
  autonomy: 'guarded'
})
ok(
  'recognised-safe command is auto-approved',
  safeRun.written[0] === 'y\r',
  JSON.stringify(safeRun.written)
)
ok('safe command does not bother the human', safeRun.asked === null)

const dangerRun = await runPatternTrack({
  output: 'Allow this command? $ rm -rf /  (y/n)',
  autonomy: 'guarded'
})
ok('catastrophic command is NOT auto-answered', dangerRun.written.length === 0)
ok('catastrophic command raises an approval', dangerRun.asked !== null)
ok(
  'approval explains why',
  /filesystem root|recursive/i.test(dangerRun.asked?.reason ?? ''),
  dangerRun.asked?.reason
)

const dangerAuto = await runPatternTrack({
  output: 'Allow this command? $ rm -rf /  (y/n)',
  autonomy: 'autonomous'
})
ok(
  'catastrophic still asks even in AUTONOMOUS',
  dangerAuto.asked !== null && dangerAuto.written.length === 0
)

const unknownRun = await runPatternTrack({
  output: 'Allow this command? $ frobnicate --prod  (y/n)',
  autonomy: 'guarded'
})
ok('unrecognised command asks rather than guessing', unknownRun.asked !== null)

// ═══ 3. Hook track: the agent is genuinely BLOCKED ════════════════════════
let releaseDecision = null
const server = await startPolicyServer(
  (req) =>
    new Promise((resolve) => {
      // Stand in for a human staring at the approval card.
      releaseDecision = (granted) =>
        resolve({
          decision: granted ? 'allow' : 'deny',
          reason: granted ? 'Approved by the operator.' : 'Declined by the operator.'
        })
      void req
    })
)

const post = (body) =>
  new Promise((resolve) => {
    const data = JSON.stringify(body)
    const r = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: '/studio/permission',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Authorization: `Bearer ${server.token}`
        }
      },
      (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => resolve(JSON.parse(b)))
      }
    )
    r.write(data)
    r.end()
  })

let settled = false
const inFlight = post({
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
  cwd: ROOT
}).then((r) => {
  settled = true
  return r
})

await sleep(600)
ok('agent is still BLOCKED while the human decides', settled === false)

releaseDecision(true)
const answered = await inFlight
ok('request completes once answered', settled === true)
ok('approval flows back as allow', answered.hookSpecificOutput.permissionDecision === 'allow')
ok(
  'reason is carried back to the agent',
  /operator/i.test(answered.hookSpecificOutput.permissionDecisionReason)
)

// Denial path.
const deniedPromise = post({
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
  cwd: ROOT
})
await sleep(300)
releaseDecision(false)
const denied = await deniedPromise
ok('denial flows back as deny', denied.hookSpecificOutput.permissionDecision === 'deny')

server.close()

// ═══ 4. Concurrent asks queue rather than collide ═════════════════════════
const queue = []
const server2 = await startPolicyServer(
  (req) =>
    new Promise((resolve) => {
      queue.push({ req, resolve })
    })
)
const p1 = new Promise((res) => {
  const d = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'a' }, cwd: ROOT })
  const r = http.request(
    {
      host: '127.0.0.1',
      port: server2.port,
      path: '/studio/permission',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(d),
        Authorization: `Bearer ${server2.token}`
      }
    },
    (resp) => {
      let b = ''
      resp.on('data', (c) => (b += c))
      resp.on('end', () => res(JSON.parse(b)))
    }
  )
  r.write(d)
  r.end()
})
const p2 = new Promise((res) => {
  const d = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'b' }, cwd: ROOT })
  const r = http.request(
    {
      host: '127.0.0.1',
      port: server2.port,
      path: '/studio/permission',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(d),
        Authorization: `Bearer ${server2.token}`
      }
    },
    (resp) => {
      let b = ''
      resp.on('data', (c) => (b += c))
      resp.on('end', () => res(JSON.parse(b)))
    }
  )
  r.write(d)
  r.end()
})

await sleep(500)
ok('two concurrent agents both queue', queue.length === 2, `${queue.length} queued`)
queue[0].resolve({ decision: 'allow', reason: 'first' })
queue[1].resolve({ decision: 'deny', reason: 'second' })
const [r1, r2] = await Promise.all([p1, p2])
ok(
  'each concurrent request gets its OWN answer',
  r1.hookSpecificOutput.permissionDecision === 'allow' &&
    r2.hookSpecificOutput.permissionDecision === 'deny'
)
server2.close()

mgr.killAll()

console.log(`PASS ${PASS.length}`)
PASS.forEach((p) => console.log(`  ✓ ${p}`))
if (FAIL.length) {
  console.log(`\nFAIL ${FAIL.length}`)
  FAIL.forEach((f) => console.log(`  ✗ ${f}`))
}
process.exit(FAIL.length ? 1 : 0)
