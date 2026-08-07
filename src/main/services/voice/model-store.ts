import { app } from 'electron'
import fs from 'fs'
import path from 'path'

/**
 * Where machine-learning models live, and how Transformers.js is told about it.
 *
 * ── THE BUG THIS EXISTS TO FIX ─────────────────────────────────────────────
 * Transformers.js decides its own cache directory at import time:
 *
 *     const DEFAULT_CACHE_DIR = RUNNING_LOCALLY ? path.join(__dirname, '/.cache/') : null
 *
 * In development `__dirname` is inside `node_modules`, which is writable, so
 * everything works and keeps working for as long as you only ever run `npm run
 * dev`. In a packaged build `__dirname` resolves **inside app.asar**, which is a
 * read-only archive. Any model download then fails.
 *
 * `src/main/logic/file-search.ts` has been calling `pipeline('feature-extraction',
 * …)` without setting this, which means semantic file search has almost
 * certainly never worked in the shipped installer while working perfectly on the
 * developer's machine. Every voice model would hit the same wall.
 *
 * So every consumer of Transformers.js in this app must call
 * `configureTransformers()` before its first `pipeline()`, and this module is
 * the only place that decides a path.
 *
 * ── THE TWO LOCATIONS ──────────────────────────────────────────────────────
 *   bundled     `resources/models`   ships inside the installer, READ-ONLY.
 *                                    The speech models live here so on-device
 *                                    voice works with no network, ever.
 *   downloaded  `userData/models`    writable. Anything fetched on demand —
 *                                    the optional local LLM, embeddings.
 *
 * `env.localModelPath` points at the bundled directory and `env.cacheDir` at the
 * writable one, so Transformers.js checks the shipped copy first and falls back
 * to downloading only when a model genuinely is not present.
 */

/** Set once by `configureTransformers`, so repeat calls are cheap and safe. */
let configured = false

/**
 * The writable model directory: `<userData>/models`.
 *
 * `app.getPath('userData')` is per-user and survives updates, which is what we
 * want — a 1 GB language model should not be re-downloaded on every release.
 */
export function modelsDir(): string {
  return path.join(app.getPath('userData'), 'models')
}

/**
 * The read-only model directory shipped inside the installer.
 *
 * `process.resourcesPath` only exists in a packaged app; in development the
 * equivalent is the repo's own `resources/` folder, so the same code path works
 * in both without a special case at the call site.
 */
export function bundledModelsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models')
    : path.join(app.getAppPath(), 'resources', 'models')
}

/** Absolute path to a model that ships with the app. */
export function bundledModelPath(id: string): string {
  return path.join(bundledModelsDir(), id)
}

/** Absolute path to a model downloaded at runtime. */
export function downloadedModelPath(id: string): string {
  return path.join(modelsDir(), id)
}

/**
 * Is this model available locally, in either location?
 *
 * Checks the bundled copy first, matching the resolution order given to
 * Transformers.js, so the answer agrees with what a `pipeline()` call will
 * actually do.
 */
export function hasModel(id: string): boolean {
  for (const candidate of [bundledModelPath(id), downloadedModelPath(id)]) {
    try {
      if (fs.existsSync(candidate)) return true
    } catch {
      /* unreadable path is the same as absent, for our purposes */
    }
  }
  return false
}

/** Where a given model actually resolved from — useful for diagnostics. */
export function resolveModel(
  id: string
): { path: string; source: 'bundled' | 'downloaded' } | null {
  const bundled = bundledModelPath(id)
  if (fs.existsSync(bundled)) return { path: bundled, source: 'bundled' }
  const downloaded = downloadedModelPath(id)
  if (fs.existsSync(downloaded)) return { path: downloaded, source: 'downloaded' }
  return null
}

export interface TransformersEnv {
  cacheDir: string
  localModelPath: string
  allowLocalModels: boolean
  allowRemoteModels: boolean
  /** `backends.onnx` is the onnxruntime module itself, not a plain config bag. */
  backends?: { onnx?: { env?: { logLevel?: string } } }
}

/**
 * Point Transformers.js at directories that exist and are writable.
 *
 * Idempotent: several features (embeddings, ASR, TTS) each call it before their
 * first pipeline, and only the first call does any work.
 *
 * Takes the `env` object as an argument rather than importing
 * `@xenova/transformers` here, because that import pulls in onnxruntime and its
 * native binding — a cost this module should not force on anything that merely
 * wants to know where models live.
 */
export function configureTransformers(env: TransformersEnv): void {
  if (configured) return

  const writable = modelsDir()
  try {
    fs.mkdirSync(writable, { recursive: true })
  } catch (err) {
    // Non-fatal on purpose. A read-only or full userData directory should
    // degrade to "models cannot be downloaded", not take the main process down
    // on startup before the window has even opened.
    console.error('[voice] could not create the model directory:', err)
  }

  env.cacheDir = writable
  env.localModelPath = bundledModelsDir()
  env.allowLocalModels = true

  // Remote fetching stays on so embeddings and any non-bundled model still work
  // when there is a network. The bundled speech models mean the *voice* feature
  // never depends on it. (On the onnxruntime log spam, see the note below.)
  env.allowRemoteModels = true

  configured = true
}

/** Test seam — lets a suite re-run `configureTransformers` against a fresh env. */
export function resetTransformersConfigForTests(): void {
  configured = false
}

/**
 * ── A KNOWN, ACCEPTED ANNOYANCE ────────────────────────────────────────────
 * Loading a quantised model prints ~120 lines of
 * `[W:onnxruntime:…] Removing initializer '…'. It is not used by any node`.
 * They are expected for quantised weights and mean nothing is wrong.
 *
 * They cannot be suppressed from here, and both obvious attempts were tried and
 * removed rather than left in looking useful:
 *
 *   1. `env.backends.onnx.env.logLevel = 'error'` — has no effect. Transformers.js
 *      v2 hardcodes `InferenceSession.create(buffer, { executionProviders })`
 *      (models.js, `constructSession`) with no `logSeverityLevel`, and the
 *      messages come from the C++ graph optimiser at session-creation time.
 *   2. Wrapping the load and filtering `process.stderr.write` — also has no
 *      effect. onnxruntime's native layer writes directly to file descriptor 2,
 *      below Node's stream abstraction, so no JS-level interception sees it.
 *
 * Redirecting fd 2 at the OS level would work and would also swallow genuine
 * native crashes, which is a bad trade for tidier logs. This is main-process
 * stderr: developers see it in the terminal, packaged users never do.
 *
 * Transformers.js **v3 does** expose `session_options`, so migrating (Phase 3)
 * fixes this properly as a side effect.
 */
