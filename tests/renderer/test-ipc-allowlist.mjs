/**
 * IPC allowlist tests: the channel contract between renderer and main.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `src/preload/index.ts` allowlists every channel the renderer may invoke.
 * Adding a new `ipcMain.handle` in main and a matching `invoke` in the renderer
 * is not enough — miss the allowlist entry and the call dies in preload with
 * "Blocked IPC channel". It typechecks. It builds. Every test passes. It fails
 * only when a human clicks the button.
 *
 * That happened: `adb-forget-device` and `adb-save-device` were added with a
 * handler and a call site and no allowlist entry, and the Forget button threw
 * on every click. Unit tests could not catch it because they stub
 * `window.electron`, which bypasses preload entirely — the stub is exactly the
 * thing that hides this bug.
 *
 * So this asserts the wiring by reading the source, which is the only place all
 * three facts (handled / allowed / invoked) exist together.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

/**
 * Channels that are genuinely broken today, with no handler in main at all.
 *
 * This list is an admission, not an allowance. Anything here is a live bug;
 * the point of naming them is that the suite fails the moment a NEW one
 * appears. Fix one and remove it from this list — the final assertion below
 * makes the list itself go stale loudly rather than quietly.
 */
const KNOWN_BROKEN = ['deploy-wormhole']

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const sourceOf = (dir) =>
  walk(path.join(ROOT, dir))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')

const setOf = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]))

const mainSrc = sourceOf('src/main')
const rendererSrc = sourceOf('src/renderer/src')
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf8')

// Main registers channels two ways: `ipcMain.handle(...)` directly, and via a
// local `handle(...)` wrapper (knowledge-graph.ts does this). Both count, or
// every kg-* channel reads as unhandled.
const handled = new Set([
  ...setOf(mainSrc, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g),
  ...setOf(mainSrc, /(?<!ipcMain\.)\bhandle\(\s*['"]([^'"]+)['"]/g)
])
const invoked = setOf(rendererSrc, /ipcRenderer\s*\.?\s*invoke\(\s*['"]([^'"]+)['"]/g)

const listBlock = preloadSrc.match(/const INVOKE_CHANNELS[^[]*\[([\s\S]*?)\]\)/)
const allowed = new Set([...(listBlock?.[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]))

// ═══ 1. The lists parse at all ════════════════════════════════════════════

ok('the preload allowlist was found and parsed', allowed.size > 0)
ok('main registers handlers', handled.size > 0)
ok('the renderer invokes channels', invoked.size > 0)

// ═══ 2. The contract ══════════════════════════════════════════════════════

{
  const missing = [...invoked].filter((c) => !allowed.has(c) && !KNOWN_BROKEN.includes(c)).sort()
  ok(
    'every channel the renderer invokes is allowlisted in preload',
    missing.length === 0,
    missing.length ? `blocked at runtime: ${missing.join(', ')}` : ''
  )
}

{
  // A channel the renderer calls that main never registers is dead on arrival.
  const orphans = [...invoked].filter((c) => !handled.has(c) && !KNOWN_BROKEN.includes(c)).sort()
  ok(
    'every channel the renderer invokes has a handler in main',
    orphans.length === 0,
    orphans.length ? `no handler: ${orphans.join(', ')}` : ''
  )
}

{
  // Keeps KNOWN_BROKEN honest: once someone fixes one, this fails and tells
  // them to delete the entry, so the list cannot rot into a permanent excuse.
  const fixed = KNOWN_BROKEN.filter((c) => handled.has(c) && allowed.has(c))
  ok(
    'the known-broken list contains nothing that has since been fixed',
    fixed.length === 0,
    fixed.length ? `now wired — remove from KNOWN_BROKEN: ${fixed.join(', ')}` : ''
  )

  // And nothing may be parked on the list that is not actually broken.
  const stale = KNOWN_BROKEN.filter((c) => !invoked.has(c))
  ok(
    'the known-broken list has no stale entries',
    stale.length === 0,
    stale.length ? `no longer invoked anywhere: ${stale.join(', ')}` : ''
  )
}

{
  // Specifically the two that shipped broken. Named so a regression points
  // straight at the cause rather than at a generic count.
  const adb = ['adb-forget-device', 'adb-save-device']
  const gaps = adb.filter((c) => !allowed.has(c) || !handled.has(c))
  ok('the phone add/forget channels are wired end to end', gaps.length === 0, gaps.join(', '))
}

// ═══ Report ═══════════════════════════════════════════════════════════════

for (const name of PASS) console.log(`  ✓ ${name}`)
for (const name of FAIL) console.error(`  ✗ ${name}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exit(FAIL.length ? 1 : 0)
