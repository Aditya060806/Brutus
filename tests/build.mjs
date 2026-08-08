/**
 * Bundle main-process modules so they can be unit-tested under plain node.
 *
 * Main-process code imports `electron`, which does not exist outside the
 * Electron runtime. esbuild bundles each module with `electron` aliased to a
 * tiny stub, producing a self-contained CJS file node can require directly.
 * That keeps the engine tests fast and headless — no Electron, no display.
 *
 *   node tests/build.mjs          # regenerate every bundle
 *
 * Bundles are build output: they live beside the tests and are gitignored.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'url'
import path from 'path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = path.join(ROOT, 'src', 'main', 'services')
const RENDERER = path.join(ROOT, 'src', 'renderer', 'src')

/** module source → output bundle. Paths are absolute so cwd never matters. */
const TARGETS = [
  // ── BRUTUS Studio ──────────────────────────────────────────────────────
  ['studio/pty-manager.ts', 'studio/pty-manager.test.cjs'],
  ['studio/dock.ts', 'studio/dock.test.cjs'],
  ['studio/policy.ts', 'studio/policy.test.cjs'],
  ['studio/policy-server.ts', 'studio/policy-server.test.cjs'],
  ['studio/prompt-watch.ts', 'studio/prompt-watch.test.cjs'],
  ['studio/hook-install.ts', 'studio/hook-install.test.cjs'],
  ['studio/terminal-screen.ts', 'studio/terminal-screen.test.cjs'],
  ['studio/project.ts', 'studio/project.test.cjs'],
  ['studio/worktree.ts', 'studio/worktree.test.cjs'],
  ['studio/retry.ts', 'studio/retry.test.cjs'],
  ['studio/telemetry.ts', 'studio/telemetry.test.cjs'],
  ['studio/router.ts', 'studio/router.test.cjs'],
  ['studio/command.ts', 'studio/command.test.cjs'],
  ['studio/mission.ts', 'studio/mission.test.cjs'],
  ['studio/dev-server.ts', 'studio/dev-server.test.cjs'],
  // Agent task records: checklist derivation, search, filters and the review
  // packet. All pure, so every awkward case is a test rather than a hope.
  ['studio/records.ts', 'studio/records.test.cjs'],
  ['studio/packet.ts', 'studio/packet.test.cjs'],
  ['studio/record-seeds.ts', 'studio/record-seeds.test.cjs'],
  // The PDF renderer plus the samples, so the test can assert that every
  // demonstration record actually draws.
  [null, 'studio/pdf.test.cjs', path.join(HERE, 'pdf-entry.ts')],
  // The IPC registrar. Bundled so a test can assert every studio-* channel is
  // registered — this app has twice shipped a view whose only symptom was
  // "No handler registered", and Studio now owns forty of them.
  ['studio/index.ts', 'studio/register.test.cjs'],
  // The adapter registry is only populated as a side effect of importing each
  // adapter, so the entry re-exports the registry *and* imports all four.
  [null, 'studio/adapters.test.cjs', path.join(HERE, 'adapters-entry.ts')],

  // ── Brutus Desk ────────────────────────────────────────────────────────
  ['coo/rails.ts', 'desk/rails.test.cjs'],
  ['coo/analyze.ts', 'desk/analyze.test.cjs'],
  ['coo/store.ts', 'desk/store.test.cjs'],
  ['coo/types.ts', 'desk/types.test.cjs'],
  // The IPC registrar. Bundled so a test can assert that every desk-* channel
  // is registered even when start-up work fails — the app once shipped a window
  // whose only symptom was "No handler registered for 'desk-state'".
  ['coo/index.ts', 'desk/register.test.cjs'],
  [null, 'desk/gmail-mime.test.cjs', path.join(ROOT, 'src', 'main', 'logic', 'gmail-manager.ts')],

  // ── On-device voice ────────────────────────────────────────────────────
  ['voice/model-store.ts', 'voice/model-store.test.cjs'],
  ['voice/local-asr.ts', 'voice/local-asr.test.cjs'],

  // ── Orchestrator ───────────────────────────────────────────────────────
  ['orchestrator/types.ts', 'orchestrator/types.test.cjs'],
  ['orchestrator/key-pool.ts', 'orchestrator/keypool.test.cjs'],
  ['orchestrator/capability-bus.ts', 'orchestrator/bus.test.cjs'],
  ['orchestrator/planner.ts', 'orchestrator/planner.test.cjs'],
  ['orchestrator/agent-runner.ts', 'orchestrator/runner.test.cjs'],
  ['orchestrator/scheduler.ts', 'orchestrator/scheduler.test.cjs']
]

// Renderer modules that are pure logic — no React, no DOM — and therefore
// testable the same headless way as the main-process engines.
const RENDERER_TARGETS = [
  ['components/studio/viewport-cull.ts', 'studio/viewport-cull.test.cjs'],
  // The settings registry is deliberately free of React and electron imports
  // so it can be bundled and asserted here. See its header comment.
  ['components/settings/settingsRegistry.ts', 'renderer/settings-registry.test.cjs'],
  // The tutorial's placement maths and its content. Both are deliberately free
  // of React and the DOM so a card that would render off-screen, or a tour with
  // a missing Hindi string, is a test rather than something a user finds.
  ['tutorial/types.ts', 'renderer/tutorial-types.test.cjs'],
  ['tutorial/content.ts', 'renderer/tutorial-content.test.cjs']
]

/** Entry paths resolved up front so cwd never matters. */
const ALL = [
  ...TARGETS.map(([src, out, entry]) => [src && path.join(SRC, src), out, entry]),
  ...RENDERER_TARGETS.map(([src, out]) => [path.join(RENDERER, src), out])
]

const results = await Promise.allSettled(
  ALL.map(([src, out, explicitEntry]) =>
    build({
      entryPoints: [explicitEntry ?? src],
      outfile: path.join(HERE, out),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      // Keep node-pty external: it is a real native addon and must load the
      // genuine prebuilt binary, not a bundled copy. @xterm/headless is left
      // external too so the tests exercise the same emulator the app ships.
      // node-pty is a real native addon and must load its genuine prebuilt
      // binary, not a bundled copy. @xterm/headless stays external so the tests
      // exercise the same emulator the app ships. @xenova/transformers is
      // external because it resolves model files relative to its own location —
      // bundling it would break that resolution and hide the very packaging bug
      // these modules exist to avoid.
      external: ['node-pty', '@xterm/headless', '@xenova/transformers'],
      alias: { electron: path.join(HERE, 'electron-stub.js') },
      logLevel: 'silent'
    }).then(() => out)
  )
)

let failed = 0
for (const [i, r] of results.entries()) {
  const name = ALL[i][1]
  if (r.status === 'fulfilled') {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}\n    ${r.reason?.message ?? r.reason}`)
  }
}

console.log(failed ? `\n${failed} bundle(s) failed` : `\n${results.length} bundles ready`)
process.exit(failed ? 1 : 0)
