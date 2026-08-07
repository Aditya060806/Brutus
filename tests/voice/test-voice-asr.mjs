/**
 * On-device ASR tests: the pure logic around the model.
 *
 * The model itself is not asserted here — a neural network's output is not a
 * contract, and pinning it would produce a test that fails on every upstream
 * revision without anything being wrong. What IS a contract is everything
 * around it, and all of it fails silently:
 *
 *   • **WAV decoding.** Read the header wrong and you feed Whisper noise. It
 *     will not error — it will transcribe the noise, confidently.
 *   • **Transcript cleaning.** Whisper emits `[BLANK_AUDIO]` and `(soft music)`
 *     on silence. Passed through, a cough becomes a user turn the assistant
 *     earnestly answers.
 *   • **Model resolution.** Point it at the wrong directory and Transformers.js
 *     silently downloads from the network instead — which defeats the entire
 *     point of an offline feature, while appearing to work.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const asr = require('./local-asr.test.cjs')
const store = require('./model-store.test.cjs')

// ═══ 1. WAV decoding ══════════════════════════════════════════════════════

/** Build a WAV exactly the way the renderer's `float32ToWavBase64` does. */
function wav(samples, { sampleRate = 16000, channels = 1, extraChunk = false } = {}) {
  const dataBytes = samples.length * 2
  const extra = extraChunk ? 12 : 0
  const buf = Buffer.alloc(44 + extra + dataBytes)
  let o = 0
  buf.write('RIFF', o, 'ascii')
  o += 4
  buf.writeUInt32LE(36 + extra + dataBytes, o)
  o += 4
  buf.write('WAVE', o, 'ascii')
  o += 4
  buf.write('fmt ', o, 'ascii')
  o += 4
  buf.writeUInt32LE(16, o)
  o += 4
  buf.writeUInt16LE(1, o)
  o += 2
  buf.writeUInt16LE(channels, o)
  o += 2
  buf.writeUInt32LE(sampleRate, o)
  o += 4
  buf.writeUInt32LE(sampleRate * 2 * channels, o)
  o += 4
  buf.writeUInt16LE(2 * channels, o)
  o += 2
  buf.writeUInt16LE(16, o)
  o += 2
  if (extraChunk) {
    // A `fact` chunk between fmt and data — legal, and fatal to any decoder
    // that assumes samples begin at byte 44.
    buf.write('fact', o, 'ascii')
    o += 4
    buf.writeUInt32LE(4, o)
    o += 4
    buf.writeUInt32LE(samples.length, o)
    o += 4
  }
  buf.write('data', o, 'ascii')
  o += 4
  buf.writeUInt32LE(dataBytes, o)
  o += 4
  for (const s of samples) {
    const c = Math.max(-1, Math.min(1, s))
    buf.writeInt16LE(c < 0 ? c * 0x8000 : c * 0x7fff, o)
    o += 2
  }
  return buf
}

{
  const decoded = asr.decodeWav(wav([0, 0.5, -0.5, 1, -1]))
  ok('decodes the sample count', decoded.samples.length === 5)
  ok('reads the sample rate', decoded.sampleRate === 16000)
  ok('decodes silence as zero', decoded.samples[0] === 0)
  ok('round-trips a positive sample', Math.abs(decoded.samples[1] - 0.5) < 0.001)
  ok('round-trips a negative sample', Math.abs(decoded.samples[2] + 0.5) < 0.001)
  ok('clamps at full scale', Math.abs(decoded.samples[4] + 1) < 0.001)
}

{
  // The reason the decoder walks the chunk table instead of assuming 44 bytes.
  const decoded = asr.decodeWav(wav([0.25, -0.25], { extraChunk: true }))
  ok(
    'finds the data chunk past an interleaved fact chunk',
    decoded.samples.length === 2 && Math.abs(decoded.samples[0] - 0.25) < 0.001,
    `got ${decoded.samples.length} samples`
  )
}

{
  // Stereo must be downmixed. Read as-is, every utterance plays at half speed
  // through the model and transcribes as gibberish.
  const decoded = asr.decodeWav(wav([1, -1, 1, -1], { channels: 2 }))
  ok('downmixes stereo to mono', decoded.samples.length === 2)
  ok('averages the two channels', Math.abs(decoded.samples[0]) < 0.001)
}

{
  const decoded = asr.decodeWav(wav([0.5], { sampleRate: 48000 }))
  ok('reports a non-16k rate rather than assuming', decoded.sampleRate === 48000)
}

{
  // A truncated recording declares its intended length; reading it would throw.
  const full = wav([0.5, 0.5, 0.5, 0.5])
  const cut = full.subarray(0, full.length - 4)
  let survived = true
  try {
    asr.decodeWav(cut)
  } catch {
    survived = false
  }
  ok('survives a truncated data chunk', survived)
}

for (const [label, bad] of [
  ['empty buffer', Buffer.alloc(0)],
  ['not RIFF', Buffer.from('NOPEnope....', 'ascii')]
]) {
  let threw = false
  try {
    asr.decodeWav(bad)
  } catch {
    threw = true
  }
  ok(`rejects ${label}`, threw)
}

// ═══ 2. Transcript cleaning ═══════════════════════════════════════════════

const CLEAN_CASES = [
  ['[BLANK_AUDIO]', ''],
  ['[ Silence ]', ''],
  ['(upbeat music)', ''],
  ['[BLANK_AUDIO] hello there', 'hello there'],
  ['hello (coughs) there', 'hello there'],
  ['  spaced   out  ', 'spaced out'],
  ['Turn on the lights.', 'Turn on the lights.'],
  ['', '']
]
for (const [input, expected] of CLEAN_CASES) {
  const got = asr.cleanTranscript(input)
  ok(`cleans ${JSON.stringify(input)}`, got === expected, `got ${JSON.stringify(got)}`)
}

// A real utterance must survive untouched — over-eager cleaning that ate speech
// would be worse than the annotations it removes.
ok(
  'leaves ordinary speech alone',
  asr.cleanTranscript('What is the weather in Delhi today?') ===
    'What is the weather in Delhi today?'
)

// ═══ 3. Model resolution ══════════════════════════════════════════════════

ok(
  'the ASR model id is declared',
  typeof asr.ASR_MODEL_ID === 'string' && asr.ASR_MODEL_ID.length > 0
)

{
  const bundled = store.bundledModelsDir()
  const writable = store.modelsDir()
  ok('bundled and writable model dirs are different', bundled !== writable)
  ok('the bundled dir is inside the app, not userData', !bundled.startsWith(writable))
}

{
  // If this fails, `npm run fetch:models` has not been run — and the shipped
  // installer would fall back to downloading Whisper at runtime, silently.
  const present = asr.isAsrModelPresent()
  ok('the bundled ASR model is present', present, 'run: npm run fetch:models')
  if (present) {
    ok('the ASR model resolves to the BUNDLED copy', asr.asrModelSource() === 'bundled')

    // The exact files Transformers.js will look for. A missing one produces a
    // network fetch at runtime rather than an error, so check them here.
    const dir = path.join(store.bundledModelsDir(), ...asr.ASR_MODEL_ID.split('/'))
    for (const file of [
      'config.json',
      'tokenizer.json',
      'preprocessor_config.json',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized.onnx'
    ]) {
      ok(`bundled model has ${file}`, fs.existsSync(path.join(dir, file)))
    }
  }
}

{
  // The gitignore rule that keeps 76 MB of weights out of the repository.
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  ok('resources/models is gitignored', ignore.includes('resources/models/*'))
  ok('its README is exempted', ignore.includes('!resources/models/README.md'))
}

// ═══ Report ═══════════════════════════════════════════════════════════════

for (const name of PASS) console.log(`  ✓ ${name}`)
for (const name of FAIL) console.error(`  ✗ ${name}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exitCode = FAIL.length ? 1 : 0
