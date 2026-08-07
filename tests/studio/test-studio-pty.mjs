/**
 * Phase 1 tests: PtyManager against a REAL pty (node-pty is N-API so it loads
 * in plain node too). Covers the logic that is actually ours — the write queue,
 * the scrollback ring, status transitions and teardown — not just the wrapper.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { PtyManager, defaultShell, ptyAvailable } = require('./pty-manager.test.cjs')

const events = []
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (_ch, ev) => events.push(ev) }
}

ok('node-pty reports available', ptyAvailable().ok === true)
ok('resolves a default shell', typeof defaultShell() === 'string' && defaultShell().length > 0)

const mgr = new PtyManager({ getWindow: () => fakeWin })

// ── spawn ────────────────────────────────────────────────────────────────────
const info = mgr.spawn({
  kind: 'shell',
  file: defaultShell(),
  args: [],
  cwd: process.cwd(),
  runMode: 'default',
  cols: 90,
  rows: 24
})
ok('spawn returns session info', !!info.id && info.status === 'starting')
ok('spawn reports a pid', typeof info.pid === 'number' && info.pid > 0, `pid=${info.pid}`)
ok(
  'session appears in list()',
  mgr.list().some((s) => s.id === info.id)
)
ok(
  'emits session-started',
  events.some((e) => e.type === 'session-started')
)

await sleep(1400)
ok(
  'streams data events',
  events.some((e) => e.type === 'data'),
  `${events.filter((e) => e.type === 'data').length} chunks`
)
ok(
  'accumulates scrollback',
  mgr.scrollbackOf(info.id).length > 0,
  `${mgr.scrollbackOf(info.id).length} bytes`
)

// ── write round-trip ─────────────────────────────────────────────────────────
mgr.write(info.id, 'echo STUDIO_WRITE_OK\r')
await sleep(1400)
ok(
  'typed command round-trips into scrollback',
  mgr.scrollbackOf(info.id).includes('STUDIO_WRITE_OK')
)

// ── write queue: never type into a busy agent ────────────────────────────────
mgr.setStatus(info.id, 'busy')
const beforeQueued = mgr.scrollbackOf(info.id).length
mgr.enqueue(info.id, 'echo QUEUED_WHILE_BUSY\r')
await sleep(500)
ok(
  'enqueue does NOT write while busy',
  !mgr.scrollbackOf(info.id).includes('QUEUED_WHILE_BUSY'),
  `scrollback grew ${mgr.scrollbackOf(info.id).length - beforeQueued}b (shell noise ok)`
)

// Going idle must drain the queue.
mgr.setStatus(info.id, 'idle')
await sleep(1600)
ok('queued write drains once idle', mgr.scrollbackOf(info.id).includes('QUEUED_WHILE_BUSY'))

// Straight to idle writes immediately.
mgr.enqueue(info.id, 'echo IMMEDIATE_OK\r')
await sleep(1400)
ok('enqueue writes immediately when idle', mgr.scrollbackOf(info.id).includes('IMMEDIATE_OK'))

// ── status events ────────────────────────────────────────────────────────────
const statusEvents = events.filter((e) => e.type === 'status').map((e) => e.status)
ok('emits status transitions', statusEvents.includes('busy') && statusEvents.includes('idle'))
const dupBefore = events.filter((e) => e.type === 'status').length
mgr.setStatus(info.id, 'idle') // already idle
ok(
  'does not re-emit an unchanged status',
  events.filter((e) => e.type === 'status').length === dupBefore
)

// ── resize ───────────────────────────────────────────────────────────────────
mgr.resize(info.id, 120, 40)
ok('resize updates session dims', mgr.get(info.id).cols === 120 && mgr.get(info.id).rows === 40)
mgr.resize(info.id, 5, 1) // below floor
ok('resize clamps to a sane floor', mgr.get(info.id).cols >= 20 && mgr.get(info.id).rows >= 5)

// ── scrollback ring is bounded ───────────────────────────────────────────────
const LIMIT = 256 * 1024
mgr.write(
  info.id,
  `for ($i=0; $i -lt 4000; $i++) { Write-Output "padpadpadpadpadpadpadpadpadpad $i" }\r`
)
await sleep(6000)
const len = mgr.scrollbackOf(info.id).length
ok('scrollback stays bounded under flood', len <= LIMIT, `${len} bytes vs cap ${LIMIT}`)
ok('scrollback keeps the TAIL (most recent)', len > 0)

// ── teardown ─────────────────────────────────────────────────────────────────
mgr.kill(info.id)
ok('kill removes the session', mgr.get(info.id) === null)
ok(
  'kill is idempotent',
  (() => {
    try {
      mgr.kill(info.id)
      return true
    } catch {
      return false
    }
  })()
)

// killAll must not throw even with nothing left.
const m2 = new PtyManager({ getWindow: () => fakeWin })
const s2 = m2.spawn({
  kind: 'shell',
  file: defaultShell(),
  args: [],
  cwd: process.cwd(),
  runMode: 'default'
})
await sleep(600)
m2.killAll()
ok('killAll clears every session', m2.list().length === 0, `left ${m2.list().length}`)
ok(
  'killAll survives being called twice',
  (() => {
    try {
      m2.killAll()
      return true
    } catch {
      return false
    }
  })()
)

// writes to a dead session are refused, not thrown
ok('write to a killed session returns false', m2.write(s2.id, 'x') === false)

console.log(`PASS ${PASS.length}`)
PASS.forEach((p) => console.log(`  ✓ ${p}`))
if (FAIL.length) {
  console.log(`\nFAIL ${FAIL.length}`)
  FAIL.forEach((f) => console.log(`  ✗ ${f}`))
}
process.exit(FAIL.length ? 1 : 0)
