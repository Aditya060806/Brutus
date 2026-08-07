import { useCallback, useEffect, useRef, useState } from 'react'
import {
  RiCheckLine,
  RiCloudLine,
  RiCpuLine,
  RiComputerLine,
  RiMicLine,
  RiVolumeUpLine
} from 'react-icons/ri'
import { Badge, Button, Select, cn } from '@renderer/components/ui'
import { useProfileStore, type VoiceEngine } from '@renderer/store/profile-store'
import { float32ToWavBase64 } from '@renderer/utils/audioUtils'
import * as systemVoice from '@renderer/services/system-voice'
import {
  SettingsHeader,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsSpinner
} from '../controls'
import { useStatus } from '../useStatus'
import type { PanelProps } from '../types'

interface EngineCard {
  id: VoiceEngine
  title: string
  icon: React.ReactNode
  summary: string
  needs: string
  cost: string
}

const ENGINES: EngineCard[] = [
  {
    id: 'cloud',
    title: 'Cloud',
    icon: <RiCloudLine size={17} />,
    summary: 'Gemini Live. Real-time, interruptible, and the only engine that can use tools.',
    needs: 'A Gemini API key and an internet connection',
    cost: 'Billed per minute of audio'
  },
  {
    id: 'server',
    title: 'Brain Node',
    icon: <RiCpuLine size={17} />,
    summary: 'Your own edge device on the LAN handles speech and the reply.',
    needs: 'A reachable Brain Node',
    cost: 'Free — it is your hardware'
  },
  {
    id: 'local',
    title: 'On device',
    icon: <RiComputerLine size={17} />,
    summary:
      'Whisper listens and your system voice speaks, both on this machine. Nothing is sent anywhere.',
    needs: 'Nothing — the model ships with Brutus',
    cost: 'Free, and works with no network'
  }
]

/** Seconds of microphone audio the test captures. */
const TEST_SECONDS = 4

const VoicePanel = ({ navigate }: PanelProps): React.JSX.Element => {
  const engine = useProfileStore((s) => s.voiceEngine)
  const setEngine = useProfileStore((s) => s.setVoiceEngine)
  const { status, setStatus } = useStatus()

  const [modelReady, setModelReady] = useState<boolean | null>(null)
  const [modelSource, setModelSource] = useState<string | null>(null)
  const [warming, setWarming] = useState(false)
  const [latency, setLatency] = useState<{ loadMs: number; sampleMs: number } | null>(null)

  const [voices, setVoices] = useState<string[]>([])
  const [voiceName, setVoiceName] = useState(
    () => localStorage.getItem('brutus_system_voice') || ''
  )

  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [heard, setHeard] = useState<string | null>(null)
  const stopRecording = useRef<(() => void) | null>(null)

  // Model presence, so the card can say whether this will work before it is used.
  useEffect(() => {
    if (!window.electron?.ipcRenderer) return
    window.electron.ipcRenderer
      .invoke('local-voice-status')
      .then((res) => {
        setModelReady(Boolean(res?.success && res.asr?.present))
        setModelSource(res?.asr?.source ?? null)
      })
      .catch(() => setModelReady(false))
  }, [])

  useEffect(() => {
    void systemVoice.listVoiceNames().then(setVoices)
  }, [])

  // Stop any test speech if the panel closes mid-sentence.
  useEffect(() => () => systemVoice.cancel(), [])

  const runSetup = async (): Promise<void> => {
    setWarming(true)
    setStatus('info', 'Loading Whisper and timing it on this machine…')
    try {
      const res = await window.electron.ipcRenderer.invoke('local-voice-warmup')
      if (res?.success) {
        setLatency({ loadMs: res.loadMs, sampleMs: res.sampleMs })
        setModelReady(true)
        setStatus('success', 'Ready. The model stays loaded until you close Brutus.')
      } else {
        setStatus('error', res?.error || 'Could not load the speech model.')
      }
    } catch (err) {
      setStatus('error', String(err))
    } finally {
      setWarming(false)
    }
  }

  /**
   * Record from the microphone, then transcribe it on-device.
   *
   * Deliberately uses the same 16 kHz mono WAV encoding as the live voice loop
   * (`float32ToWavBase64`), so a successful test here means the real path works
   * — not merely that some audio reached some model.
   */
  const runMicTest = useCallback(async (): Promise<void> => {
    setHeard(null)
    setStatus('info', `Listening for ${TEST_SECONDS} seconds — say something.`)

    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setStatus('error', 'Microphone access was refused.')
      return
    }

    const context = new AudioContext({ sampleRate: 16000 })
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(4096, 1, 1)
    const chunks: Float32Array[] = []

    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
    }
    source.connect(processor)
    processor.connect(context.destination)
    setRecording(true)

    const finish = async (): Promise<void> => {
      stopRecording.current = null
      setRecording(false)
      processor.disconnect()
      source.disconnect()
      stream?.getTracks().forEach((t) => t.stop())
      await context.close()

      const total = chunks.reduce((n, c) => n + c.length, 0)
      const pcm = new Float32Array(total)
      let offset = 0
      for (const c of chunks) {
        pcm.set(c, offset)
        offset += c.length
      }

      if (total < 16000 * 0.5) {
        setStatus('error', 'That was too short to transcribe.')
        return
      }

      setTranscribing(true)
      setStatus('info', 'Transcribing on this device…')
      try {
        const res = await window.electron.ipcRenderer.invoke('local-asr', {
          wavBase64: float32ToWavBase64(pcm, 16000)
        })
        if (res?.success) {
          setHeard(res.text || '')
          setStatus(
            res.text ? 'success' : 'error',
            res.text
              ? `Transcribed in ${res.ms} ms, entirely offline.`
              : 'Nothing recognisable was heard — try speaking closer to the microphone.'
          )
        } else {
          setStatus('error', res?.error || 'Transcription failed.')
        }
      } finally {
        setTranscribing(false)
      }
    }

    const timer = setTimeout(() => void finish(), TEST_SECONDS * 1000)
    stopRecording.current = () => {
      clearTimeout(timer)
      void finish()
    }
  }, [setStatus])

  const testSpeech = async (): Promise<void> => {
    if (!systemVoice.isSupported()) {
      setStatus('error', 'This system has no speech voices available.')
      return
    }
    await systemVoice.speak(
      'Brutus is listening. Speech recognition and spoken replies run on this device.',
      { voiceName: voiceName || undefined }
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="Voice"
        description="How Brutus hears you and how it answers. This is separate from which model writes the reply."
      />

      <SettingsSection
        title="Engine"
        description="Applies the next time you start a session — an engine cannot change mid-call."
      >
        <div className="flex flex-col gap-2 px-4 py-4">
          {ENGINES.map((card) => {
            const active = engine === card.id
            const unavailable = card.id === 'local' && modelReady === false
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => {
                  setEngine(card.id)
                  setStatus('success', `${card.title} selected. Restart the session to apply.`)
                }}
                aria-pressed={active}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 text-left',
                  'transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                  active
                    ? 'border-primary-500/50 bg-primary-500/10'
                    : 'border-line bg-surface-muted hover:border-line-strong hover:bg-hover'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 shrink-0',
                    active ? 'text-primary-500' : 'text-content-muted'
                  )}
                >
                  {card.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-content">{card.title}</span>
                    {active && <RiCheckLine size={14} className="text-primary-500" />}
                    {card.id === 'local' && modelReady && (
                      <Badge tone="success" dot>
                        {modelSource === 'bundled' ? 'Included' : 'Installed'}
                      </Badge>
                    )}
                    {unavailable && <Badge tone="warning">Model missing</Badge>}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-content-muted">
                    {card.summary}
                  </span>
                  <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-content-faint">
                    <span>Needs: {card.needs}</span>
                    <span>{card.cost}</span>
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </SettingsSection>

      {engine === 'local' && (
        <>
          <SettingsSection
            title="On-device setup"
            description="Speech recognition is only pleasant if it is fast, and that depends on your CPU. This measures it here rather than guessing."
            aside={
              latency ? (
                <Badge mono tone={latency.sampleMs < 1500 ? 'success' : 'warning'}>
                  {latency.sampleMs} ms
                </Badge>
              ) : undefined
            }
          >
            <SettingsRow
              label="Prepare the model"
              description={
                latency
                  ? `Loaded in ${latency.loadMs} ms. One second of audio transcribes in ${latency.sampleMs} ms on this machine.`
                  : 'Loads Whisper and times a short transcription.'
              }
              control={
                <Button variant="secondary" size="sm" loading={warming} onClick={runSetup}>
                  {latency ? 'Measure again' : 'Run setup'}
                </Button>
              }
            />

            <SettingsRow
              label="Test the microphone"
              description={`Records ${TEST_SECONDS} seconds and transcribes it here, with no network.`}
              control={
                recording ? (
                  <Button
                    variant="secondary"
                    tone="danger"
                    size="sm"
                    onClick={() => stopRecording.current?.()}
                    leadingIcon={<RiMicLine size={14} />}
                  >
                    Stop
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={transcribing}
                    onClick={() => void runMicTest()}
                    leadingIcon={transcribing ? undefined : <RiMicLine size={14} />}
                  >
                    Record
                  </Button>
                )
              }
            />

            {(recording || heard !== null) && (
              <div className="px-4 py-3">
                {recording ? (
                  <SettingsSpinner label="Listening…" />
                ) : (
                  <p className="rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] leading-relaxed text-content">
                    {heard || <span className="text-content-faint">nothing heard</span>}
                  </p>
                )}
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            title="Speaking voice"
            description="Provided by your operating system, so it starts instantly and needs no download."
          >
            <SettingsRow
              htmlFor="system-voice"
              label="Voice"
              description={
                voices.length
                  ? `${voices.length} available on this system.`
                  : 'No voices found — Windows and macOS ship these; some Linux desktops do not.'
              }
              stacked
              control={
                <div className="flex items-center gap-2">
                  <Select
                    id="system-voice"
                    value={voiceName}
                    options={voices.map((v) => ({ value: v, label: v }))}
                    placeholder={voices.length ? 'System default' : 'None available'}
                    onChange={(e) => {
                      setVoiceName(e.target.value)
                      localStorage.setItem('brutus_system_voice', e.target.value)
                    }}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!voices.length}
                    onClick={() => void testSpeech()}
                    leadingIcon={<RiVolumeUpLine size={14} />}
                  >
                    Hear it
                  </Button>
                </div>
              }
            />
          </SettingsSection>

          <SettingsSection title="What this mode cannot do">
            <SettingsRow
              label="Tools are unavailable"
              description="Email, robot control, file search and Studio need the cloud engine. On-device mode answers and converses only — the same limit the Brain Node engine has."
              control={
                <Button variant="tertiary" size="sm" onClick={() => navigate('keys')}>
                  API keys
                </Button>
              }
            />
            <SettingsRow
              label="The robot speaker stays silent"
              description="System voices render straight to your speakers and expose no audio data, so there is nothing to forward to the robot over UDP."
            />
          </SettingsSection>
        </>
      )}

      <SettingsStatus status={status} />
    </div>
  )
}

export default VoicePanel
