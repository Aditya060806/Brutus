/**
 * Desk IPC registration — the channels must exist, whatever else goes wrong.
 *
 * ── WHY THIS SUITE EXISTS ──────────────────────────────────────────────────
 * A build shipped where the Desk view rendered fine and every button was dead,
 * because the main process had no `desk-state` handler. The only thing the user
 * saw was:
 *
 *     Error invoking remote method 'desk-state': No handler registered
 *
 * — a message that names an Electron internal and gives them nothing to do.
 *
 * `registerDesk` originally did its start-up work FIRST and registered handlers
 * afterwards, so anything that threw during start-up took the entire IPC surface
 * with it, silently. The order is now inverted, and this suite pins it: handler
 * registration comes first, and start-up failures degrade to an explained error
 * rather than an absent channel.
 *
 * The registrar is bundled by `tests/build.mjs` with `electron` stubbed, so this
 * runs headless under plain node like the rest of the desk suites.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const registerDesk = require('./register.test.cjs').default

/**
 * The channels the renderer and the preload allowlist agree on.
 * Kept as a literal list rather than derived: this is the contract, and a test
 * that derives the contract from the code under test asserts nothing.
 */
const EXPECTED = [
  'desk-approve',
  'desk-commitment-done',
  'desk-config',
  'desk-dismiss',
  'desk-run-now',
  'desk-state',
  'desk-stop'
]

/** Records registrations in order, like the real ipcMain but inspectable. */
const fakeIpc = () => {
  const handlers = new Map()
  const order = []
  return {
    handlers,
    order,
    removeHandler: (c) => handlers.delete(c),
    handle: (c, fn) => {
      handlers.set(c, fn)
      order.push(c)
    },
    on: () => {}
  }
}

// ═══ 1. Every channel is registered ═══════════════════════════════════════

{
  const ipc = fakeIpc()
  registerDesk(ipc)

  for (const channel of EXPECTED) {
    ok(`${channel} is registered`, ipc.handlers.has(channel))
  }
  ok(
    'nothing unexpected is registered',
    [...ipc.handlers.keys()].every((c) => EXPECTED.includes(c)),
    [...ipc.handlers.keys()].filter((c) => !EXPECTED.includes(c)).join(', ')
  )
  ok('every handler is callable', [...ipc.handlers.values()].every((h) => typeof h === 'function'))
}

// ═══ 2. Registration happens before anything that can fail ════════════════
//
// The regression guard. `boot()` touches the disk and starts a timer; if a
// future edit moves work above the `handle()` calls, or a registrar is added
// after `boot()`, this fails.

{
  const ipc = fakeIpc()
  let registeredBeforeDiskTouch = null

  // `configureStore` is the first thing `boot()` does, and mkdir is the first
  // thing IT does. Trip a wire there and see how many channels already exist.
  const realMkdir = fs.mkdirSync
  fs.mkdirSync = function (...args) {
    if (registeredBeforeDiskTouch === null && String(args[0]).includes('brutus_desk')) {
      registeredBeforeDiskTouch = ipc.handlers.size
    }
    return realMkdir.apply(this, args)
  }
  try {
    registerDesk(ipc)
  } finally {
    fs.mkdirSync = realMkdir
  }

  ok(
    'the store directory is not touched until every channel is registered',
    registeredBeforeDiskTouch === EXPECTED.length,
    `only ${registeredBeforeDiskTouch} of ${EXPECTED.length} were registered first`
  )
}

// ═══ 3. A failing start-up still leaves a usable IPC surface ══════════════

{
  const ipc = fakeIpc()
  const realMkdir = fs.mkdirSync
  const realError = console.error
  // The registrar is SUPPOSED to log here — that is the behaviour under test.
  // Captured rather than printed so a passing run stays readable, and asserted
  // on below so "logs the failure" does not quietly stop being true.
  const logged = []
  console.error = (...args) => logged.push(args.map(String).join(' '))
  fs.mkdirSync = function (...args) {
    if (String(args[0]).includes('brutus_desk')) throw new Error('EACCES: simulated')
    return realMkdir.apply(this, args)
  }
  try {
    registerDesk(ipc)
  } catch {
    FAIL.push('registerDesk threw when start-up failed — it must not')
  } finally {
    fs.mkdirSync = realMkdir
    console.error = realError
  }

  ok('all channels survive a failed start-up', EXPECTED.every((c) => ipc.handlers.has(c)))
  ok(
    'the failure is written to the log',
    logged.some((line) => line.includes('[desk]')),
    'a silent degradation is undiagnosable'
  )
}

// ═══ 4. desk-state answers with a snapshot, not a rejection ═══════════════

{
  const ipc = fakeIpc()
  registerDesk(ipc)

  let res
  let threw = false
  try {
    res = ipc.handlers.get('desk-state')({})
  } catch {
    threw = true
  }

  ok('desk-state does not throw', !threw)
  ok('desk-state answers', Boolean(res))
  ok('it reports success on a healthy store', res?.success === true, JSON.stringify(res?.error))
  ok('it carries a config', typeof res?.config?.level === 'string')
  ok(
    'a fresh install is off',
    res?.config?.level === 'off',
    'the exe ships to other people — it must never start autonomous'
  )
  for (const key of ['needsYou', 'handled', 'triaged', 'commitments', 'audit']) {
    ok(`${key} is an array`, Array.isArray(res?.[key]))
  }
  ok('engine state is present', typeof res?.engine === 'object' && res.engine !== null)
}

// ═══ 5. The kill switch is reachable and turns autonomy off ═══════════════
//
// Asserted through the handler rather than the store, because "the user pressed
// Stop and nothing happened" is the failure that matters, and it can be caused
// by a broken handler over a perfectly good store.

{
  const ipc = fakeIpc()
  registerDesk(ipc)

  const setTo = ipc.handlers.get('desk-config')({}, { level: 'draft' })
  ok('desk-config applies a level', setTo?.config?.level === 'draft')

  const stopped = ipc.handlers.get('desk-stop')({})
  ok('desk-stop succeeds', stopped?.success === true)
  ok('desk-stop forces autonomy off', stopped?.config?.level === 'off')

  const after = ipc.handlers.get('desk-state')({})
  ok('and the state agrees', after?.config?.level === 'off')

  // Leave the shared store as it was found, so suite order cannot matter.
  ipc.handlers.get('desk-config')({}, { level: 'off' })
}

// ═══ 6. Unknown ids are refused rather than crashing ══════════════════════

{
  const ipc = fakeIpc()
  registerDesk(ipc)

  const dismissed = ipc.handlers.get('desk-dismiss')({}, { threadId: 'nope' })
  ok('dismissing an unknown thread fails cleanly', dismissed?.success === false)
  ok('and says why', typeof dismissed?.error === 'string' && dismissed.error.length > 0)

  const done = ipc.handlers.get('desk-commitment-done')({}, { id: 'nope' })
  ok('completing an unknown commitment fails cleanly', done?.success === false)
  ok('and says why', typeof done?.error === 'string' && done.error.length > 0)
}

// ═══ Cleanup ══════════════════════════════════════════════════════════════
//
// The stubbed `app.getPath` returns the OS temp dir, so the registrar wrote a
// real `brutus_desk` folder there. Remove it.

try {
  fs.rmSync(path.join(os.tmpdir(), 'brutus_desk'), { recursive: true, force: true })
} catch {
  /* a leftover temp dir is not a test failure */
}

for (const name of PASS) console.log(`  ✓ ${name}`)
for (const name of FAIL) console.error(`  ✗ ${name}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exitCode = FAIL.length ? 1 : 0
