import { configureTransformers, hasModel, resolveModel } from './model-store'

/**
 * On-device speech recognition — Whisper, running in this process.
 *
 * Contract-compatible with `brainAsr()` in `llm-provider.ts`: both take a
 * base64 WAV and resolve to `{ text }`. That is deliberate — the voice loop
 * picks one or the other by channel name and cannot otherwise tell them apart,
 * so no caller needs to know which is in use.
 *
 * The model ships inside the installer (see `resources/models/README.md`), so
 * this works on a machine that has never been online.
 */

/** The bundled model. Also the id Transformers.js resolves under `localModelPath`. */
export const ASR_MODEL_ID = 'Xenova/whisper-base.en'

/** Whisper is trained at 16 kHz; anything else must be resampled before use. */
const WHISPER_SAMPLE_RATE = 16000

/**
 * The load, held as a promise rather than a value.
 *
 * Loading Whisper takes seconds. Two turns arriving close together — or the
 * settings panel warming up while a turn starts — would otherwise each begin
 * their own load, doubling memory and both being slow. Caching the *promise*
 * means the second caller awaits the first load instead of starting another.
 */
/**
 * The shape of a Transformers.js ASR pipeline, narrowed to what is used here.
 *
 * The library's own types are generated and not exported in a form that is
 * usable across this boundary, so this declares the call signature rather than
 * reaching for `any` and losing the return shape entirely.
 */
type Transcriber = (audio: Float32Array) => Promise<{ text?: string } | { text?: string }[]>

let transcriberPromise: Promise<Transcriber> | null = null

export function isAsrModelPresent(): boolean {
  return hasModel(ASR_MODEL_ID)
}

/** Where the model resolved from — surfaced in the settings panel diagnostics. */
export function asrModelSource(): 'bundled' | 'downloaded' | null {
  return resolveModel(ASR_MODEL_ID)?.source ?? null
}

async function getTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const transformers = await import('@xenova/transformers')
      // Must happen before the first pipeline() or Transformers.js writes to a
      // cache directory inside the read-only ASAR. See model-store.ts.
      configureTransformers(transformers.env as never)
      const pipe = await transformers.pipeline('automatic-speech-recognition', ASR_MODEL_ID)
      return pipe as unknown as Transcriber
    })().catch((err) => {
      // Clear the cache so a transient failure (a half-written model file, a
      // disk hiccup) can be retried instead of being remembered forever.
      transcriberPromise = null
      throw err
    })
  }
  return transcriberPromise
}

/**
 * Decode a 16-bit PCM WAV into the Float32 samples the pipeline wants.
 *
 * Walks the RIFF chunk table rather than assuming the canonical 44-byte header.
 * Most encoders emit exactly 44 bytes — including `float32ToWavBase64`, which
 * produces the audio this normally receives — but some insert `LIST`/`fact`
 * chunks before `data`, and a fixed offset would then read metadata as samples
 * and transcribe noise.
 */
export function decodeWav(buffer: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a RIFF/WAV payload')
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('RIFF payload is not WAVE')

  let sampleRate = WHISPER_SAMPLE_RATE
  let channels = 1
  let bitsPerSample = 16
  let dataStart = -1
  let dataLength = 0

  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(body + 2)
      sampleRate = buffer.readUInt32LE(body + 4)
      bitsPerSample = buffer.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataStart = body
      // Trust the buffer over the declared size: a truncated recording declares
      // its intended length, and reading past the end would throw.
      dataLength = Math.min(size, buffer.length - body)
      break
    }
    // Chunks are word-aligned — an odd size is followed by a pad byte.
    offset = body + size + (size % 2)
  }

  if (dataStart < 0) throw new Error('WAV has no data chunk')
  if (bitsPerSample !== 16) throw new Error(`Expected 16-bit PCM, got ${bitsPerSample}-bit`)

  const frames = Math.floor(dataLength / 2 / channels)
  const samples = new Float32Array(frames)

  for (let i = 0; i < frames; i++) {
    if (channels === 1) {
      samples[i] = buffer.readInt16LE(dataStart + i * 2) / 32768
    } else {
      // Downmix. Whisper is mono; feeding it interleaved stereo would halve the
      // apparent speech rate and produce confident nonsense.
      let sum = 0
      for (let c = 0; c < channels; c++)
        sum += buffer.readInt16LE(dataStart + (i * channels + c) * 2)
      samples[i] = sum / channels / 32768
    }
  }

  return { samples, sampleRate }
}

/** Linear resample. Only used when the caller did not already supply 16 kHz. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const ratio = from / to
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio
    const lower = Math.floor(src)
    const upper = Math.min(lower + 1, input.length - 1)
    out[i] = input[lower] + (input[upper] - input[lower]) * (src - lower)
  }
  return out
}

export interface TranscribeResult {
  text: string
  /** Wall-clock milliseconds, so the settings panel can report real latency. */
  ms: number
}

/**
 * Transcribe a base64 WAV.
 *
 * Returns an empty string for audio Whisper heard nothing in, rather than
 * throwing — the voice loop already treats empty text as "that was not speech,
 * keep listening", and a throw there would end the turn.
 */
export async function transcribe(wavBase64: string): Promise<TranscribeResult> {
  const started = Date.now()
  const transcriber = await getTranscriber()

  const { samples, sampleRate } = decodeWav(Buffer.from(wavBase64, 'base64'))
  const audio = resample(samples, sampleRate, WHISPER_SAMPLE_RATE)

  const output = await transcriber(audio)
  const raw = Array.isArray(output) ? output[0]?.text : output?.text

  return { text: cleanTranscript(String(raw ?? '')), ms: Date.now() - started }
}

/**
 * Strip Whisper's non-speech annotations.
 *
 * On silence or noise Whisper emits bracketed tags — `[BLANK_AUDIO]`,
 * `(upbeat music)`, `[ Silence ]`. Passed through, those become a "user turn"
 * that the assistant then earnestly answers, so a cough makes Brutus talk.
 */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Load the model and measure how long a short transcription really takes.
 *
 * The settings panel runs this during setup. On-device speech is only pleasant
 * if it is fast, and that depends entirely on the user's CPU — so this measures
 * it on their machine rather than promising a number from here.
 */
export async function warmUp(): Promise<{ loadMs: number; sampleMs: number }> {
  const loadStart = Date.now()
  await getTranscriber()
  const loadMs = Date.now() - loadStart

  // One second of silence. Cheap, and it exercises the full encode/decode path
  // rather than only the model load.
  const silence = new Float32Array(WHISPER_SAMPLE_RATE)
  const sampleStart = Date.now()
  const transcriber = await getTranscriber()
  await transcriber(silence)

  return { loadMs, sampleMs: Date.now() - sampleStart }
}

/** Release the model. Used when the user switches away from the local engine. */
export function unload(): void {
  transcriberPromise = null
}
