/**
 * On-device speech synthesis, using the platform's own voices.
 *
 * ── WHY NOT A NEURAL MODEL ─────────────────────────────────────────────────
 * A neural voice was built first and measured on a real machine: MMS-TTS (VITS)
 * took 1.9 s to say "Yes.", 7.6 s for one sentence and 17.6 s for a paragraph —
 * between 1.8x and 3.1x realtime. Seven seconds of silence before an assistant
 * starts answering is not a latency problem to be tuned, it is a different
 * product. The Web Speech API starts speaking immediately because there is no
 * model to run: Windows, macOS and most Linux desktops already ship voices, and
 * Chromium exposes them.
 *
 * It is also genuinely offline and adds nothing to the installer.
 *
 * ── THE TRADE, STATED HONESTLY ─────────────────────────────────────────────
 * Voice quality is whatever the user's OS provides, so it is not identical on
 * every machine — good on Windows 11 and macOS, variable on Linux. And unlike
 * the Brain Node path this produces no PCM we can capture, so audio cannot be
 * forwarded to the robot's speaker in this mode. `speaksToRobot` below makes
 * that checkable rather than a surprise.
 */

/** Whether this build can speak without a network or a model. */
export function isSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * Can audio from this engine reach the robot's speaker?
 *
 * No. The Web Speech API renders straight to the output device and exposes no
 * sample data, so there is nothing to forward over UDP to the ESP2 amp. The
 * Brain Node and Gemini paths both return decodable audio and can.
 */
export const speaksToRobot = false

/**
 * Voices, once the browser has actually loaded them.
 *
 * `getVoices()` returns an empty array on first call in Chromium — the list
 * populates asynchronously and fires `voiceschanged`. Code that reads it once
 * at module load therefore sees nothing and concludes speech is unavailable,
 * which is the classic bug with this API.
 */
export function loadVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!isSupported()) return resolve([])

    const immediate = window.speechSynthesis.getVoices()
    if (immediate.length) return resolve(immediate)

    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      window.speechSynthesis.removeEventListener('voiceschanged', finish)
      resolve(window.speechSynthesis.getVoices())
    }

    window.speechSynthesis.addEventListener('voiceschanged', finish)
    // Some platforms never fire the event when there are no voices at all, so
    // this must not hang the caller for ever.
    setTimeout(finish, timeoutMs)
  })
}

/**
 * Rank voices so the default is a good one rather than whatever is first.
 *
 * Windows lists "Microsoft David/Zira" (older, robotic) ahead of the newer
 * natural voices, so taking `voices[0]` picks the worst option available. This
 * prefers, in order: an explicitly "Natural"/"Online" voice, a local English
 * voice, then anything English.
 */
export function pickVoice(
  voices: SpeechSynthesisVoice[],
  preferredName?: string
): SpeechSynthesisVoice | null {
  if (!voices.length) return null

  if (preferredName) {
    const exact = voices.find((v) => v.name === preferredName)
    if (exact) return exact
  }

  const english = voices.filter((v) => /^en(-|_|$)/i.test(v.lang))
  const pool = english.length ? english : voices

  const natural = pool.find((v) => /natural|neural|online|premium|enhanced/i.test(v.name))
  if (natural) return natural

  const local = pool.find((v) => v.localService)
  return local ?? pool[0]
}

export interface SpeakOptions {
  /** Exact `SpeechSynthesisVoice.name`, as chosen in settings. */
  voiceName?: string
  /** 0.1–10, default 1. Slightly above 1 reads more naturally for assistants. */
  rate?: number
  pitch?: number
  /** Called once audio actually begins, for driving the speaking state. */
  onStart?: () => void
}

let activeUtterance: SpeechSynthesisUtterance | null = null

/**
 * Speak `text`, resolving when it has finished.
 *
 * Resolves rather than rejects on synthesis errors: the caller uses completion
 * to hand the microphone back, and a rejection there would leave the voice loop
 * stuck busy — silent and unable to listen, which is worse than a missed reply.
 */
export function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  return new Promise((resolve) => {
    if (!isSupported() || !text.trim()) return resolve()

    // Anything still queued belongs to a turn that is over.
    cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = options.rate ?? 1.05
    utterance.pitch = options.pitch ?? 1

    const voices = window.speechSynthesis.getVoices()
    const voice = pickVoice(voices, options.voiceName)
    if (voice) {
      utterance.voice = voice
      // Setting lang to match the voice avoids Chromium substituting a
      // different one when the utterance language and voice disagree.
      utterance.lang = voice.lang
    }

    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      if (activeUtterance === utterance) activeUtterance = null
      resolve()
    }

    utterance.onstart = () => options.onStart?.()
    utterance.onend = finish
    utterance.onerror = finish

    activeUtterance = utterance
    window.speechSynthesis.speak(utterance)
  })
}

/** Stop immediately. Used when the session ends or the user interrupts. */
export function cancel(): void {
  if (!isSupported()) return
  try {
    window.speechSynthesis.cancel()
  } catch {
    /* cancelling an empty queue is not an error worth surfacing */
  }
  activeUtterance = null
}

export function isSpeaking(): boolean {
  return isSupported() && window.speechSynthesis.speaking
}

/** Voice names for the settings panel, best-first. */
export async function listVoiceNames(): Promise<string[]> {
  const voices = await loadVoices()
  const best = pickVoice(voices)
  const names = voices.map((v) => v.name)
  if (!best) return names
  // Surface the default choice first so the panel's initial selection matches
  // what `speak()` would actually use.
  return [best.name, ...names.filter((n) => n !== best.name)]
}
