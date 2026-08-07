/**
 * Fetch the speech models that ship inside the installer.
 *
 *   node scripts/fetch-models.mjs           # download anything missing
 *   node scripts/fetch-models.mjs --list    # show what would be downloaded
 *   node scripts/fetch-models.mjs --force   # re-download even if present
 *
 * ── WHY A SCRIPT AND NOT GIT ───────────────────────────────────────────────
 * These are ~200 MB of binary weights. Committing them would bloat every clone
 * and every fetch forever, and git is bad at storing them. They are build
 * output: this script reproduces them, `.gitignore` keeps them out, and
 * `electron-builder.yml` copies the result into the installer.
 *
 * ── LAYOUT MATTERS ─────────────────────────────────────────────────────────
 * Transformers.js resolves a local model as `{localModelPath}/{modelId}/{file}`,
 * so the repo-relative directory structure has to be mirrored exactly —
 * `resources/models/Xenova/whisper-base.en/onnx/…`. Getting this wrong produces
 * a silent fall back to downloading from the network at runtime, which is the
 * precise failure the bundling exists to prevent.
 *
 * Only quantised ONNX weights are taken. The fp32 files in these repos are 3-4x
 * larger for accuracy nobody will hear through a laptop microphone.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEST = path.join(ROOT, 'resources', 'models')

const args = new Set(process.argv.slice(2))
const LIST_ONLY = args.has('--list')
const FORCE = args.has('--force')

/**
 * Models bundled into the installer.
 *
 * `keep` decides which files come down. Whisper repos carry several precisions
 * and both merged and split decoders; we take the quantised merged pair plus the
 * JSON config/tokenizer files, which is everything the ASR pipeline needs.
 */
const MODELS = [
  {
    id: 'Xenova/whisper-base.en',
    purpose: 'speech recognition',
    keep: (file) =>
      file.endsWith('.json') ||
      file === 'onnx/encoder_model_quantized.onnx' ||
      file === 'onnx/decoder_model_merged_quantized.onnx'
  }
  // NOTE: there is no text-to-speech model here on purpose.
  //
  // MMS-TTS (VITS) was implemented and measured on a real machine before being
  // removed: 1.9 s to say "Yes.", 7.6 s for one sentence, 17.6 s for a
  // paragraph — 1.8-3.1x realtime. A voice assistant that takes seven seconds to
  // begin answering is not one. Speech synthesis now uses the platform's own
  // voices through the Web Speech API (see `services/system-voice.ts`), which
  // is instant, offline, and costs nothing to ship.
]

const HF = 'https://huggingface.co'

const human = (bytes) => {
  if (!bytes) return '?'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n.toFixed(n < 10 && u > 0 ? 1 : 0)} ${units[u]}`
}

/** List every file in a model repo, with sizes, via the Hub API. */
const listRepo = async (id) => {
  const url = `${HF}/api/models/${id}/tree/main?recursive=true`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Hub listing for ${id} failed: ${res.status} ${res.statusText}`)
  const tree = await res.json()
  return tree.filter((e) => e.type === 'file').map((e) => ({ path: e.path, size: e.size ?? 0 }))
}

const download = async (id, file, dest) => {
  const url = `${HF}/${id}/resolve/main/${file}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${file}: ${res.status} ${res.statusText}`)

  fs.mkdirSync(path.dirname(dest), { recursive: true })
  // Write to a temp name and rename on success, so an interrupted run can never
  // leave a truncated .onnx that looks complete to the existence check.
  const tmp = `${dest}.partial`
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, dest)
  return buf.length
}

let failed = 0
let totalBytes = 0

for (const model of MODELS) {
  console.log(`\n${model.id}  —  ${model.purpose}`)

  let files
  try {
    files = (await listRepo(model.id)).filter((f) => model.keep(f.path))
  } catch (err) {
    console.error(`  ✗ ${err.message}`)
    failed++
    continue
  }

  if (!files.length) {
    console.error(`  ✗ nothing matched the keep filter — the repo layout may have changed`)
    failed++
    continue
  }

  const planned = files.reduce((n, f) => n + f.size, 0)
  console.log(`  ${files.length} files, ${human(planned)}`)

  if (LIST_ONLY) {
    for (const f of files) console.log(`    ${f.path.padEnd(46)} ${human(f.size)}`)
    continue
  }

  for (const file of files) {
    const dest = path.join(DEST, ...model.id.split('/'), ...file.path.split('/'))
    if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`    · ${file.path} (already present)`)
      continue
    }
    try {
      const bytes = await download(model.id, file.path, dest)
      totalBytes += bytes
      console.log(`    ✓ ${file.path.padEnd(46)} ${human(bytes)}`)
    } catch (err) {
      console.error(`    ✗ ${file.path}: ${err.message}`)
      failed++
    }
  }
}

if (LIST_ONLY) {
  console.log('\n(--list: nothing downloaded)')
} else {
  console.log(
    failed
      ? `\n${failed} file(s) failed. The installer would fall back to downloading at runtime.`
      : `\nDone — ${human(totalBytes)} fetched into resources/models.`
  )
}

// `process.exitCode`, not `process.exit()`. Calling exit() immediately after
// undici's fetch tears the event loop down while its keep-alive sockets are
// still closing, and libuv aborts with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — which turns a
// successful run into exit code 127 and would fail CI for no reason.
process.exitCode = failed ? 1 : 0
