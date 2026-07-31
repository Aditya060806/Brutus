import { useEffect, useCallback, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import Sphere from '@renderer/components/Sphere'
import { saveMessage } from '@renderer/services/brutus-ai-brain'
import { brutusService } from '@renderer/services/Brutus-voice-ai'
import {
  RiCpuLine,
  RiCameraLine,
  RiTerminalBoxLine,
  RiSwapBoxLine,
  RiMicLine,
  RiMicOffLine,
  RiPhoneFill,
  RiSendPlaneLine,
  RiSignalTowerLine,
  RiVolumeUpLine
} from 'react-icons/ri'
import { FaMemory } from 'react-icons/fa6'
import { GiTinker } from 'react-icons/gi'
import * as faceapi from 'face-api.js'
import { VisionMode } from '@renderer/IndexRoot'
import { emotionBus } from '@renderer/components/BrutusEyes/emotionBus'
import type { FaceExpression } from '@renderer/components/BrutusEyes/emotionBus'

interface IrisProps {
  isSystemActive: boolean
  toggleSystem: () => void
  isMicMuted: boolean
  toggleMic: () => void
  isVideoOn: boolean
  visionMode: VisionMode
  startVision: (mode: 'camera' | 'screen') => void
  stopVision: () => void
  activeStream: MediaStream | null
}

interface DashboardViewProps {
  props: IrisProps
  stats: any
  chatHistory: any[]
  onVisionClick: () => void
}

/* ── Design system ────────────────────────────────────────────────────────────
 * ONE accent: red-500 (the Brutus brand). Every other surface is neutral zinc.
 * Red appears only for brand identity, live state, and threshold breach — never
 * as decoration. The previous build ran five competing accent hues, which made
 * the least important content (four hardware numbers) the loudest thing on the
 * screen and buried the actual hero.
 *
 * RADIUS SCALE (documented rule, applied everywhere):
 *   surface  rounded-2xl (16px)  — top-level panels
 *   nested   rounded-xl  (12px)  — surfaces inside a panel
 *   control  rounded-lg  (8px)   — buttons, inputs
 *   pill     rounded-full        — dock, bars, status dots
 *
 * TYPE SCALE (4 steps, was 7 arbitrary sizes):
 *   label  10px semibold uppercase tracking-[0.16em]  — what a thing is
 *   body   11px                                       — transcript, prose
 *   value  15px mono semibold                         — numbers you read first
 *   hero   the sphere itself
 */
const SURFACE = 'bg-zinc-950/50 backdrop-blur-xl border border-white/[0.06] rounded-2xl'
// zinc-400 rather than zinc-500: at 10px on a near-black surface, zinc-500
// lands around 3.9:1 and fails WCAG AA for small text. zinc-400 clears 7:1
// and still sits well below the value text in the hierarchy.
const LABEL = 'text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-400'
const VALUE = 'text-[15px] font-mono font-semibold tabular-nums'

const ABUSE_TRIGGERS = [
  'fuck you',
  'fuck off',
  'you suck',
  'stupid ai',
  'dumb ai',
  'moron',
  'retard',
  'piece of shit',
  'worthless',
  'useless piece',
  'go to hell',
  'screw you',
  'bitch',
  'asshole',
  'bastard',
  "you're trash",
  "you're garbage"
]

// Word-boundary regexes to avoid false positives (e.g. 'die' inside 'gradients')
const ABUSE_REGEXES = ABUSE_TRIGGERS.map(
  (t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
)

/**
 * Live audio meters driven by the voice service's real analyser nodes.
 *
 * This replaces the old `Math.random()` "network telemetry" — five bars that
 * animated constantly while showing nothing. These two bars show your actual
 * mic input and Brutus's actual speech output, so the rail is quiet when the
 * room is quiet and moves only when something is really happening.
 *
 * Levels are written straight to the DOM inside a rAF loop. Routing a 60 fps
 * signal through useState would re-render the whole dashboard every frame.
 */
function useAudioMeters(
  active: boolean,
  reduce: boolean
): {
  micRef: React.RefObject<HTMLDivElement | null>
  outRef: React.RefObject<HTMLDivElement | null>
} {
  const micRef = useRef<HTMLDivElement | null>(null)
  const outRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const reset = (): void => {
      if (micRef.current) micRef.current.style.transform = 'scaleX(0)'
      if (outRef.current) outRef.current.style.transform = 'scaleX(0)'
    }
    if (!active || reduce) {
      reset()
      return
    }

    let raf = 0
    let micBuf: Uint8Array<ArrayBuffer> | null = null
    let outBuf: Uint8Array<ArrayBuffer> | null = null
    let micLevel = 0
    let outLevel = 0

    const read = (
      analyser: AnalyserNode | null,
      buf: Uint8Array<ArrayBuffer> | null
    ): { level: number; buf: Uint8Array<ArrayBuffer> | null } => {
      if (!analyser) return { level: 0, buf }
      const next =
        buf && buf.length === analyser.frequencyBinCount
          ? buf
          : new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(next)
      let sum = 0
      for (let i = 0; i < next.length; i++) sum += next[i]
      return { level: sum / next.length / 255, buf: next }
    }

    const tick = (): void => {
      const mic = read(brutusService.micAnalyser, micBuf)
      const out = read(brutusService.analyser, outBuf)
      micBuf = mic.buf
      outBuf = out.buf

      // Asymmetric smoothing: rise fast so speech registers immediately,
      // fall slow so the bar reads as a level rather than a strobe.
      micLevel += (mic.level - micLevel) * (mic.level > micLevel ? 0.55 : 0.12)
      outLevel += (out.level - outLevel) * (out.level > outLevel ? 0.55 : 0.12)

      if (micRef.current) {
        micRef.current.style.transform = `scaleX(${Math.min(1, micLevel * 2.4).toFixed(3)})`
      }
      if (outRef.current) {
        outRef.current.style.transform = `scaleX(${Math.min(1, outLevel * 2.4).toFixed(3)})`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      reset()
    }
  }, [active, reduce])

  return { micRef, outRef }
}

/** A hardware reading. Neutral until it crosses a threshold worth noticing. */
function Vital({
  icon,
  label,
  value,
  percent,
  warnAt,
  live
}: {
  icon: React.ReactNode
  label: string
  value: string
  percent: number
  warnAt: number
  live: boolean
}): React.ReactElement {
  const hot = live && percent >= warnAt
  return (
    <div className="group flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-zinc-500 group-hover:text-zinc-400 transition-colors">
          <span className="text-[11px]">{icon}</span>
          <span className={LABEL}>{label}</span>
        </span>
        <span
          className={`${VALUE} ${hot ? 'text-red-400' : live ? 'text-zinc-100' : 'text-zinc-700'}`}
        >
          {value}
        </span>
      </div>
      <div className="h-[3px] w-full rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className={`h-full rounded-full origin-left transition-[width,background-color] duration-700 ease-out ${
            hot ? 'bg-red-500' : 'bg-zinc-400'
          }`}
          style={{ width: live ? `${Math.min(100, Math.max(0, percent))}%` : '0%' }}
        />
      </div>
    </div>
  )
}

/** Real signal level, fed by useAudioMeters. */
function Meter({
  label,
  icon,
  barRef,
  accent
}: {
  label: string
  icon: React.ReactNode
  barRef: React.RefObject<HTMLDivElement | null>
  accent: boolean
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex items-center gap-1.5 w-[68px] shrink-0 text-zinc-500">
        <span className="text-[11px]">{icon}</span>
        <span className={LABEL}>{label}</span>
      </span>
      <div className="flex-1 h-[3px] rounded-full bg-white/[0.06] overflow-hidden">
        <div
          ref={barRef}
          className={`h-full w-full rounded-full origin-left ${accent ? 'bg-red-500' : 'bg-zinc-300'}`}
          style={{ transform: 'scaleX(0)' }}
        />
      </div>
    </div>
  )
}

export default function DashboardView({
  props,
  stats,
  chatHistory,
  onVisionClick
}: DashboardViewProps) {
  const {
    isSystemActive,
    isVideoOn,
    visionMode,
    startVision,
    activeStream,
    toggleMic,
    toggleSystem,
    isMicMuted
  } = props

  const reduce = useReducedMotion() ?? false

  const scrollRef = useRef<HTMLDivElement>(null)
  const videoElementRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const faceScanInterval = useRef<NodeJS.Timeout | null>(null)
  const textInputRef = useRef<HTMLTextAreaElement>(null)

  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [textInput, setTextInput] = useState('')

  const { micRef, outRef } = useAudioMeters(isSystemActive, reduce)

  const handleSendText = async () => {
    const msg = textInput.trim()
    if (!msg || !isSystemActive) return
    setTextInput('')

    const lower = msg.toLowerCase()
    const isAbusive = ABUSE_REGEXES.some((rx) => rx.test(lower))
    if (isAbusive) {
      emotionBus.triggerLockdown()
      return
    }

    await saveMessage('user', msg)
    window.dispatchEvent(new CustomEvent('ai-force-speak', { detail: msg }))
  }

  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendText()
    }
  }

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [chatHistory])

  useEffect(() => {
    const loadModels = async () => {
      try {
        const MODEL_URL = './models'
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
          faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
          faceapi.nets.ageGenderNet.loadFromUri(MODEL_URL)
        ])
        setModelsLoaded(true)
      } catch (e) {}
    }
    loadModels()
  }, [])

  useEffect(() => {
    if (
      isVideoOn &&
      visionMode === 'camera' &&
      modelsLoaded &&
      videoElementRef.current &&
      canvasRef.current
    ) {
      if (faceScanInterval.current) clearInterval(faceScanInterval.current)

      faceScanInterval.current = setInterval(async () => {
        const video = videoElementRef.current
        const canvas = canvasRef.current
        if (!video || !canvas || video.readyState !== 4 || video.videoWidth === 0) return

        try {
          const vw = video.videoWidth
          const vh = video.videoHeight

          if (canvas.width !== vw || canvas.height !== vh) {
            canvas.width = vw
            canvas.height = vh
          }

          const ctx = canvas.getContext('2d')
          if (!ctx) return

          const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 })
          const detection = await faceapi
            .detectSingleFace(video, options)
            .withFaceExpressions()
            .withAgeAndGender()

          ctx.clearRect(0, 0, vw, vh)

          if (detection) {
            const { x, y, width, height } = detection.detection.box

            const mirroredX = vw - x - width

            ctx.strokeStyle = '#f87171'
            ctx.lineWidth = 4
            const l = 25

            ctx.beginPath()
            ctx.moveTo(mirroredX, y + l)
            ctx.lineTo(mirroredX, y)
            ctx.lineTo(mirroredX + l, y)
            ctx.moveTo(mirroredX + width - l, y)
            ctx.lineTo(mirroredX + width, y)
            ctx.lineTo(mirroredX + width, y + l)
            ctx.moveTo(mirroredX, y + height - l)
            ctx.lineTo(mirroredX, y + height)
            ctx.lineTo(mirroredX + l, y + height)
            ctx.moveTo(mirroredX + width - l, y + height)
            ctx.lineTo(mirroredX + width, y + height)
            ctx.lineTo(mirroredX + width, y + height - l)
            ctx.stroke()

            const expressions = detection.expressions
            const domExp = Object.keys(expressions).reduce((a, b) =>
              expressions[a] > expressions[b] ? a : b
            )
            emotionBus.setExpression(domExp as FaceExpression, expressions[domExp])
            const gender = detection.gender === 'male' ? 'M' : 'F'
            const age = Math.round(detection.age)
            const labelText = ` ID:${gender} | AGE:${age} | ${domExp.toUpperCase()} `

            ctx.fillStyle = 'rgba(10, 10, 10, 0.85)'
            ctx.fillRect(mirroredX, y - 32, width, 26)

            ctx.fillStyle = '#f87171'
            ctx.font = 'bold 16px monospace'
            ctx.fillText(labelText, mirroredX + 5, y - 14)
          } else {
            ctx.fillStyle = 'rgba(52, 211, 153, 0.8)'
            ctx.font = 'bold 14px monospace'
            ctx.fillText('SCANNING OPTICS...', 20, 30)
          }
        } catch (e) {}
      }, 250)
    } else {
      if (faceScanInterval.current) clearInterval(faceScanInterval.current)
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height)
    }

    return () => {
      if (faceScanInterval.current) clearInterval(faceScanInterval.current)
    }
  }, [isVideoOn, visionMode, modelsLoaded])

  const setVideoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      videoElementRef.current = node
      if (node && activeStream && isVideoOn) {
        node.srcObject = activeStream
        node.onloadedmetadata = () => node.play().catch(() => {})
      }
    },
    [activeStream, isVideoOn, visionMode]
  )

  const setMobileVideoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      if (node && activeStream && isVideoOn) {
        node.srcObject = activeStream
        node.onloadedmetadata = () => node.play().catch(() => {})
      }
    },
    [activeStream, isVideoOn, visionMode]
  )

  const toggleSource = () => {
    if (!isSystemActive) return
    const nextMode = visionMode === 'camera' ? 'screen' : 'camera'
    startVision(nextMode)
  }

  // Entrance choreography. Motivated: the stagger states the hierarchy on
  // arrival — hero first, then the surfaces that support it.
  const zone = (order: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.5, delay: order * 0.08, ease: [0.16, 1, 0.3, 1] as const }
        }

  const cpu = isSystemActive && stats ? stats.cpu : 0
  const ram = isSystemActive && stats ? stats.memory.usedPercentage : 0
  const temp = isSystemActive && stats ? stats.temperature : 0

  return (
    <div className="h-full w-full p-4 grid grid-cols-12 gap-4 overflow-hidden relative">
      {/* ══ AMBIENT RAIL ══════════════════════════════════════════════════════
          Was three stacked glass cards with doubled borders. Now one surface,
          divided by hairlines: optics, vitals, signal. Reads as one quiet
          instrument instead of a wall of boxes. */}
      <motion.aside {...zone(2)} className="hidden lg:flex col-span-3 flex-col min-h-0 z-40">
        <div className={`${SURFACE} flex-1 flex flex-col min-h-0 overflow-hidden`}>
          {/* Optics */}
          <section className="p-3.5 shrink-0">
            <header className="flex items-center justify-between mb-2.5">
              <span className="flex items-center gap-2">
                <span
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${
                    isVideoOn ? 'bg-red-500' : 'bg-zinc-700'
                  }`}
                />
                <span className={LABEL}>
                  {isVideoOn ? (visionMode === 'screen' ? 'Screen' : 'Optics') : 'Optics'}
                </span>
              </span>
              {isVideoOn && (
                <button
                  onClick={toggleSource}
                  title="Switch between camera and screen"
                  className="cursor-pointer p-1 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors active:scale-95"
                >
                  <RiSwapBoxLine size={13} />
                </button>
              )}
            </header>

            <div
              className={`relative aspect-[4/3] w-full rounded-xl overflow-hidden bg-black/40 border border-white/[0.06] transition-opacity duration-500 ${
                isVideoOn ? 'opacity-100' : 'opacity-40'
              }`}
            >
              <video
                key={visionMode}
                ref={setVideoRef}
                className={`absolute inset-0 w-full h-full object-cover ${visionMode === 'camera' ? '-scale-x-100' : ''}`}
                autoPlay
                playsInline
                muted
              />
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full object-cover pointer-events-none z-20"
              />
              {!isVideoOn && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-zinc-700">
                  <RiCameraLine size={20} />
                  <span className="text-[9px] font-mono tracking-widest uppercase">No signal</span>
                </div>
              )}
            </div>
          </section>

          <div className="h-px bg-white/[0.06] mx-3.5" />

          {/* Vitals */}
          <section className="p-3.5 flex flex-col gap-3.5">
            <Vital
              icon={<RiCpuLine />}
              label="CPU"
              value={isSystemActive && stats ? `${cpu}%` : '--'}
              percent={cpu}
              warnAt={85}
              live={isSystemActive && !!stats}
            />
            <Vital
              icon={<FaMemory />}
              label="Memory"
              value={isSystemActive && stats ? `${ram}%` : '--'}
              percent={ram}
              warnAt={85}
              live={isSystemActive && !!stats}
            />
            <Vital
              icon={<GiTinker />}
              label="Temp"
              value={isSystemActive && stats ? `${temp}°C` : '--'}
              percent={Math.min((temp / 90) * 100, 100)}
              warnAt={83}
              live={isSystemActive && !!stats}
            />
          </section>

          <div className="h-px bg-white/[0.06] mx-3.5" />

          {/* Signal — real levels, not simulated traffic */}
          <section className="p-3.5 flex flex-col gap-3 mt-auto">
            <Meter label="Mic" icon={<RiMicLine />} barRef={micRef} accent={false} />
            <Meter label="Voice" icon={<RiVolumeUpLine />} barRef={outRef} accent />
            <div className="flex items-center justify-between pt-0.5">
              <span className={LABEL}>Uplink</span>
              <span
                className={`text-[10px] font-mono font-semibold tracking-wider ${
                  isSystemActive ? 'text-red-400' : 'text-zinc-600'
                }`}
              >
                {isSystemActive ? 'LIVE' : 'STANDBY'}
              </span>
            </div>
            {stats?.os?.type && (
              <div className="flex items-center justify-between">
                <span className={LABEL}>Host</span>
                <span className="text-[10px] font-mono text-zinc-500 truncate max-w-[60%]">
                  {stats.os.type}
                </span>
              </div>
            )}
          </section>
        </div>
      </motion.aside>

      {/* ══ HERO ══════════════════════════════════════════════════════════════
          The sphere is the product. It gets the centre, the only chromatic
          presence on the page, and nothing competing beside it. */}
      <motion.main
        {...zone(0)}
        className="col-span-12 lg:col-span-6 relative flex flex-col items-center justify-center min-h-0"
      >
        <div
          className={`lg:hidden absolute top-4 right-4 w-32 h-24 ${SURFACE} z-50 overflow-hidden ${isVideoOn ? 'block' : 'hidden'}`}
        >
          <video
            ref={setMobileVideoRef}
            className={`w-full h-full object-cover ${visionMode === 'camera' ? '-scale-x-100' : ''}`}
            autoPlay
            playsInline
            muted
          />
        </div>

        {/* Aura appears only while the link is live — it IS the state signal. */}
        {isSystemActive && (
          <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[42vh] h-[42vh] rounded-full blur-3xl opacity-50 z-0 brutus-aura" />
        )}

        <div
          className={`relative z-10 w-[58vh] h-[58vh] max-w-full transition-all duration-1000 ${
            isSystemActive ? 'opacity-100 scale-100' : 'opacity-80 scale-[0.92] grayscale'
          }`}
          style={{
            filter: isSystemActive ? 'drop-shadow(0 0 22px rgba(180,60,60,0.18))' : 'none',
            transition: 'filter 1.5s ease'
          }}
        >
          <Sphere />
        </div>

        {/* Control dock */}
        <div className="absolute bottom-8 z-50">
          <div
            className={`${SURFACE} rounded-full px-5 py-2.5 flex items-center gap-5 border-white/10 shadow-[0_8px_40px_rgba(0,0,0,0.6)]`}
          >
            <motion.button
              whileTap={reduce ? undefined : { scale: 0.92 }}
              onClick={onVisionClick}
              title={isVideoOn ? 'Switch source' : 'Start vision'}
              className={`cursor-pointer p-2.5 rounded-full transition-colors ${
                isVideoOn
                  ? 'bg-red-500/15 text-red-400'
                  : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
              }`}
            >
              {isVideoOn ? <RiSwapBoxLine size={19} /> : <RiCameraLine size={19} />}
            </motion.button>

            <motion.button
              whileTap={reduce ? undefined : { scale: 0.94 }}
              onClick={toggleSystem}
              title={isSystemActive ? 'End session' : 'Start session'}
              className="relative group cursor-pointer"
            >
              {isSystemActive && !reduce && (
                <>
                  <span className="pointer-events-none absolute inset-0 rounded-full border border-red-400/60 brutus-ring" />
                  <span
                    className="pointer-events-none absolute inset-0 rounded-full border border-red-400/40 brutus-ring"
                    style={{ animationDelay: '1.2s' }}
                  />
                </>
              )}
              <div
                className={`relative p-3.5 rounded-full border transition-all duration-500 ${
                  isSystemActive
                    ? 'bg-red-500 border-red-400 text-black shadow-[0_0_24px_rgba(239,68,68,0.5)]'
                    : 'bg-red-500/10 border-red-500/40 text-red-500 group-hover:bg-red-500/20 group-hover:border-red-500/60'
                }`}
              >
                <RiPhoneFill size={22} />
              </div>
            </motion.button>

            <motion.button
              whileTap={reduce ? undefined : { scale: 0.92 }}
              onClick={toggleMic}
              title={isMicMuted ? 'Unmute microphone' : 'Mute microphone'}
              className={`cursor-pointer p-2.5 rounded-full transition-colors ${
                isMicMuted
                  ? 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
                  : 'bg-red-500/15 text-red-400'
              }`}
            >
              {isMicMuted ? <RiMicOffLine size={19} /> : <RiMicLine size={19} />}
            </motion.button>
          </div>
        </div>
      </motion.main>

      {/* ══ CONVERSATION ══════════════════════════════════════════════════════ */}
      <motion.aside {...zone(1)} className="hidden lg:flex col-span-3 flex-col min-h-0 z-40">
        <div className={`${SURFACE} flex-1 flex flex-col min-h-0 overflow-hidden`}>
          <header className="flex items-center justify-between px-4 py-3.5 border-b border-white/[0.06] shrink-0">
            <span className="flex items-center gap-2 text-zinc-500">
              <RiTerminalBoxLine size={13} />
              <span className={LABEL}>Transcript</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className={`w-1 h-1 rounded-full ${isSystemActive ? 'bg-red-500' : 'bg-zinc-700'}`}
              />
              <span className="text-[9px] font-mono tracking-wider text-zinc-600">
                {chatHistory.length > 0 ? `${chatHistory.length}` : ''}
              </span>
            </span>
          </header>

          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2.5 scrollbar-small"
          >
            {chatHistory.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-2.5 text-zinc-600">
                <RiSignalTowerLine size={22} />
                <span className="text-[10px] tracking-[0.16em] uppercase font-medium text-zinc-400">
                  Nothing yet
                </span>
                <span className="text-[10px] text-zinc-500 text-center max-w-[80%] leading-relaxed">
                  {isSystemActive ? 'Say something or type below' : 'Start a session to talk'}
                </span>
              </div>
            ) : (
              chatHistory.map((msg, idx) => {
                const mine = msg.role === 'user'
                return (
                  <motion.div
                    key={idx}
                    initial={reduce ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                    className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[92%] px-3 py-2 text-[11px] leading-relaxed rounded-xl ${
                        mine
                          ? 'bg-red-500/12 text-red-50/90 rounded-br-md'
                          : 'bg-white/[0.04] text-zinc-300 rounded-bl-md'
                      }`}
                    >
                      {msg.parts && msg.parts[0] ? msg.parts[0].text : msg.content}
                    </div>
                  </motion.div>
                )
              })
            )}
          </div>

          <div className="px-3 pb-3 pt-2.5 border-t border-white/[0.06] shrink-0">
            <div className="flex items-end gap-2">
              <textarea
                ref={textInputRef}
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={handleTextKeyDown}
                disabled={!isSystemActive}
                placeholder={isSystemActive ? 'Message Brutus' : 'System offline'}
                rows={1}
                className="flex-1 bg-black/40 border border-white/[0.06] rounded-lg text-[11px] text-zinc-200 placeholder-zinc-600 px-3 py-2 outline-none resize-none transition-colors focus:border-red-500/40 disabled:opacity-40 disabled:cursor-not-allowed"
              />
              <motion.button
                whileTap={reduce ? undefined : { scale: 0.92 }}
                onClick={handleSendText}
                disabled={!isSystemActive || !textInput.trim()}
                title="Send"
                className="p-2 rounded-lg bg-red-500/12 text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-25 disabled:cursor-not-allowed cursor-pointer"
              >
                <RiSendPlaneLine size={14} />
              </motion.button>
            </div>
          </div>
        </div>
      </motion.aside>
    </div>
  )
}
