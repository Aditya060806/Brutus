import { useCallback, useEffect, useRef, useState } from 'react'
import { float32ToWavBase64 } from '@renderer/utils/audioUtils'

/**
 * Push-to-talk dictation for a text field.
 *
 * ── WHY ON-DEVICE, NOT THE WEB SPEECH API ──────────────────────────────────
 * `webkitSpeechRecognition` is the obvious choice and does not work here:
 * Chromium's implementation calls a Google endpoint using an API key compiled
 * into Chrome, which Electron builds do not carry. It fails silently with a
 * `network` error, which is exactly the sort of thing that looks fine in
 * development and is dead in the shipped exe.
 *
 * So this records raw PCM and sends it to the same `local-asr` channel the
 * voice loop uses — the on-device Whisper model. Offline, no key, no per-minute
 * cost, and the encoding is byte-identical to the live path (`float32ToWavBase64`
 * at 16 kHz mono) so working here means working there.
 */

/** Below this, the recording is a click rather than a sentence. */
const MIN_SECONDS = 0.4
/** Ceiling, so a forgotten open mic cannot record until memory runs out. */
const MAX_SECONDS = 60

export interface Dictation {
  recording: boolean
  transcribing: boolean
  error: string | null
  /** Start if idle, stop and transcribe if recording. */
  toggle: () => void
  supported: boolean
}

export function useDictation(onText: (text: string) => void): Dictation {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Set while recording; calling it stops and transcribes. */
  const stopRef = useRef<(() => void) | null>(null)
  /** The latest callback, so a stop that lands after a re-render still delivers. */
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  // An open microphone must not outlive the panel that opened it.
  useEffect(() => {
    return () => stopRef.current?.()
  }, [])

  const start = useCallback(async () => {
    setError(null)

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('Microphone access was refused.')
      return
    }

    const context = new AudioContext({ sampleRate: 16000 })
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const chunks: Float32Array[] = []
    let samples = 0
    let finished = false

    processor.onaudioprocess = (event) => {
      const frame = event.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(frame))
      samples += frame.length
      if (samples >= 16000 * MAX_SECONDS) stopRef.current?.()
    }
    source.connect(processor)
    processor.connect(context.destination)
    setRecording(true)

    const finish = async (): Promise<void> => {
      // Guarded because the cap and a click can both fire; tearing the audio
      // graph down twice throws.
      if (finished) return
      finished = true
      stopRef.current = null
      setRecording(false)

      processor.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      await context.close()

      if (samples < 16000 * MIN_SECONDS) {
        setError('That was too short to hear.')
        return
      }

      const pcm = new Float32Array(samples)
      let offset = 0
      for (const c of chunks) {
        pcm.set(c, offset)
        offset += c.length
      }

      setTranscribing(true)
      try {
        const res = await window.electron.ipcRenderer.invoke('local-asr', {
          wavBase64: float32ToWavBase64(pcm, 16000)
        })
        if (!res?.success) {
          setError(res?.error || 'Could not transcribe. Set up on-device voice in Settings.')
          return
        }
        const text = String(res.text ?? '').trim()
        if (!text) {
          setError('Nothing recognisable was heard.')
          return
        }
        onTextRef.current(text)
      } catch (err) {
        setError(String((err as { message?: string })?.message || err))
      } finally {
        setTranscribing(false)
      }
    }

    stopRef.current = () => void finish()
  }, [])

  const toggle = useCallback(() => {
    if (stopRef.current) stopRef.current()
    else void start()
  }, [start])

  return {
    recording,
    transcribing,
    error,
    toggle,
    supported: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  }
}
