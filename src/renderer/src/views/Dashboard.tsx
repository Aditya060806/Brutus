import { useEffect, useCallback, useRef, useState } from 'react'
import Sphere from '@renderer/components/Sphere'
import { saveMessage } from '@renderer/services/brutus-ai-brain'
import {
  RiCpuLine,
  RiCameraLine,
  RiTerminalBoxLine,
  RiSwapBoxLine,
  RiLayoutGridLine,
  RiMicLine,
  RiMicOffLine,
  RiPhoneFill,
  RiHistoryLine,
  RiPulseLine,
  RiWifiLine,
  RiServerLine,
  RiEarthLine,
  RiSendPlaneLine
} from 'react-icons/ri'
import { FaMemory } from 'react-icons/fa6'
import { GiTinker } from 'react-icons/gi'
import { HiComputerDesktop } from 'react-icons/hi2'
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

const glassPanel = 'bg-zinc-950/40 backdrop-blur-xl border border-white/5 rounded-2xl shadow-xl'

const ABUSE_TRIGGERS = [
  'fuck you', 'fuck off', 'you suck', 'stupid ai', 'dumb ai', 'moron', 'retard', 'piece of shit', 'worthless', 'useless piece', 'go to hell', 'screw you', 'bitch', 'asshole', 'bastard', 'you\'re trash', 'you\'re garbage'
]

// Word-boundary regexes to avoid false positives (e.g. 'die' inside 'gradients')
const ABUSE_REGEXES = ABUSE_TRIGGERS.map(t =>
  new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
)

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

  const scrollRef = useRef<HTMLDivElement>(null)
  const videoElementRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const faceScanInterval = useRef<NodeJS.Timeout | null>(null)
  const textInputRef = useRef<HTMLTextAreaElement>(null)

  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [networkStats, setNetworkStats] = useState({ ping: 24, rate: 1.2, tx: 40, rx: 60 })
  const [textInput, setTextInput] = useState('')

  const handleSendText = async () => {
    const msg = textInput.trim()
    if (!msg || !isSystemActive) return
    setTextInput('')

    const lower = msg.toLowerCase()
    const isAbusive = ABUSE_REGEXES.some(rx => rx.test(lower))
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
      } catch (e) { }
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
        } catch (e) { }
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

  useEffect(() => {
    if (!isSystemActive) {
      setNetworkStats({ ping: 0, rate: 0, tx: 0, rx: 0 })
      return
    }
    const interval = setInterval(() => {
      setNetworkStats({
        ping: Math.floor(Math.random() * 34) + 12,
        rate: parseFloat((Math.random() * 8.5 + 0.5).toFixed(1)),
        tx: Math.floor(Math.random() * 100),
        rx: Math.floor(Math.random() * 100)
      })
    }, 1700)
    return () => clearInterval(interval)
  }, [isSystemActive])

  const setVideoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      videoElementRef.current = node
      if (node && activeStream && isVideoOn) {
        node.srcObject = activeStream
        node.onloadedmetadata = () => node.play().catch(() => { })
      }
    },
    [activeStream, isVideoOn, visionMode]
  )

  const setMobileVideoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      if (node && activeStream && isVideoOn) {
        node.srcObject = activeStream
        node.onloadedmetadata = () => node.play().catch(() => { })
      }
    },
    [activeStream, isVideoOn, visionMode]
  )

  const toggleSource = () => {
    if (!isSystemActive) return
    const nextMode = visionMode === 'camera' ? 'screen' : 'camera'
    startVision(nextMode)
  }

  const systemMetrics = [
    {
      icon: <RiCpuLine />,
      bgIcon: <RiCpuLine size={140} />,
      label: 'CPU LOAD',
      val: isSystemActive && stats ? `${stats.cpu}%` : '--',
      raw: isSystemActive && stats ? stats.cpu : 0,
      colorClass: 'text-emerald-400',
      bgClass: 'bg-emerald-500',
      glowClass: 'via-emerald-500/50',
      shadowClass: 'shadow-[0_0_8px_#10b981]',
      bgGradient: 'from-emerald-950/30 to-black/60',
      pattern:
        'bg-[linear-gradient(to_right,#10b98114_1px,transparent_1px),linear-gradient(to_bottom,#10b98114_1px,transparent_1px)] bg-[size:12px_12px]'
    },
    {
      icon: <FaMemory />,
      bgIcon: <FaMemory size={140} />,
      label: 'RAM USAGE',
      val: isSystemActive && stats ? `${stats.memory.usedPercentage}%` : '--',
      raw: isSystemActive && stats ? stats.memory.usedPercentage : 0,
      colorClass: 'text-cyan-400',
      bgClass: 'bg-cyan-500',
      glowClass: 'via-cyan-500/50',
      shadowClass: 'shadow-[0_0_8px_#06b6d4]',
      bgGradient: 'from-cyan-950/30 to-black/60',
      pattern: 'bg-[radial-gradient(#06b6d422_1px,transparent_1px)] bg-[size:10px_10px]'
    },
    {
      icon: <GiTinker />,
      bgIcon: <GiTinker size={140} />,
      label: 'TEMP',
      val: isSystemActive && stats ? `${stats.temperature}°C` : '--',
      raw: isSystemActive && stats ? Math.min((stats.temperature / 90) * 100, 100) : 0,
      colorClass: 'text-orange-400',
      bgClass: 'bg-orange-500',
      glowClass: 'via-orange-500/50',
      shadowClass: 'shadow-[0_0_8px_#f97316]',
      bgGradient: 'from-orange-950/30 to-black/60',
      pattern:
        'bg-[radial-gradient(ellipse_at_top_right,#f9731628,transparent_70%)]'
    },
    {
      icon: <HiComputerDesktop />,
      bgIcon: <HiComputerDesktop size={140} />,
      label: 'OS',
      val: isSystemActive && stats ? `${stats.os.type}` : '--',
      raw: 0,
      colorClass: 'text-purple-400',
      bgClass: 'bg-purple-500',
      glowClass: 'via-purple-500/50',
      shadowClass: '',
      bgGradient: 'from-purple-950/30 to-black/60',
      pattern:
        'bg-[linear-gradient(45deg,#a855f714_25%,transparent_25%,transparent_50%,#a855f714_50%,#a855f714_75%,transparent_75%,transparent)] bg-[size:24px_24px]',
      hideBar: true
    }
  ]

  return (
    <div className="flex-1 p-4 bg-white/2 grid grid-cols-12 gap-4 h-full overflow-hidden relative animate-in fade-in zoom-in duration-300 w-full">
      <div className="hidden lg:flex col-span-3 flex-col gap-4 h-full z-40">
        <div
          className={`${glassPanel} h-70 shrink-0 flex flex-col p-1 overflow-hidden relative group`}
        >
          <div className="absolute top-3 left-3 z-30 flex items-center gap-2">
            <span
              className={`w-1.5 h-1.5 rounded-full ${isVideoOn ? 'bg-red-500 animate-pulse shadow-[0_0_8px_red]' : 'bg-zinc-600'}`}
            />
            <span
              className={`text-[9px] font-bold tracking-widest ${isVideoOn ? 'text-red-400/80' : 'text-zinc-600'}`}
            >
              {isVideoOn
                ? visionMode === 'screen'
                  ? 'SCREEN FEED'
                  : 'OPTICAL FEED'
                : 'OPTICS OFFLINE'}
            </span>
          </div>

          {isVideoOn && (
            <button
              onClick={toggleSource}
              className="absolute top-2 right-2 z-30 p-1.5 rounded-md bg-black/50 text-red-400 border border-red-500/20 hover:bg-red-500 hover:text-black transition-all"
            >
              <RiSwapBoxLine size={14} />
            </button>
          )}

          <div
            className={`w-full h-full rounded-xl overflow-hidden bg-black/20 relative border border-white/5 transition-all ${isVideoOn ? 'opacity-100' : 'opacity-30'}`}
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
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 opacity-50">
                <RiCameraLine size={24} />
                <span className="text-[9px] font-mono">NO SIGNAL</span>
              </div>
            )}
          </div>
        </div>

        <div className={`${glassPanel} h-32 shrink-0 p-4 flex flex-col justify-between relative overflow-hidden`}>
          {isSystemActive && (
            <div className="absolute inset-0 bg-linear-to-br from-red-500/5 via-transparent to-transparent pointer-events-none" />
          )}
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <span className="text-[10px] font-bold tracking-widest text-zinc-400 flex items-center gap-1">
              <RiPulseLine className={isSystemActive ? 'text-red-500 animate-pulse' : ''} />{' '}
              NETWORK TELEMETRY
            </span>
            <span
              className={`text-[8px] font-mono font-bold px-2 py-0.5 rounded-full border ${isSystemActive ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-zinc-600 border-zinc-700'}`}
            >
              {isSystemActive ? 'SECURE UPLINK' : 'STANDBY'}
            </span>
          </div>
          <div className="flex items-center justify-between mt-2">
            <div className="flex flex-col">
              <span className="text-[8px] text-zinc-600 font-mono tracking-widest">WSS LATENCY</span>
              <span className="text-xs font-bold text-zinc-300 flex items-center gap-1">
                <RiWifiLine className={isSystemActive ? 'text-red-500' : 'text-zinc-600'} />
                {isSystemActive ? `${networkStats.ping}ms` : '--'}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[8px] text-zinc-600 font-mono tracking-widest">PACKET RATE</span>
              <span className="text-xs font-bold text-zinc-300">
                {isSystemActive ? `${networkStats.rate.toFixed(1)} MB/s` : '--'}
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[8px] text-zinc-600 font-mono tracking-widest">ROUTING</span>
              <span className="text-xs font-bold text-zinc-300 flex items-center gap-1">
                {isSystemActive ? (
                  <><RiEarthLine className="text-red-400" /> GLOBAL</>
                ) : (
                  <>LOCAL <RiServerLine className="text-zinc-500" /></>
                )}
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1 mt-2">
            <div className="flex items-center gap-2">
              <span className="text-[7px] font-mono text-zinc-600 w-4">TX</span>
              <div className="flex-1 h-1 bg-black/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-red-500/70 rounded-full transition-all duration-700 shadow-[0_0_4px_rgba(239,68,68,0.5)]"
                  style={{ width: `${isSystemActive ? networkStats.tx : 0}%` }}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[7px] font-mono text-zinc-600 w-4">RX</span>
              <div className="flex-1 h-1 bg-black/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-zinc-400/50 rounded-full transition-all duration-700"
                  style={{ width: `${isSystemActive ? networkStats.rx : 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className={`${glassPanel} flex-1 p-4 flex flex-col gap-3`}>
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <span className="text-[10px] font-bold tracking-widest text-zinc-400">
              <RiLayoutGridLine className="inline mr-1" /> CORE METRICS
            </span>
          </div>
          {/* --- UPGRADED CORE METRICS UI --- */}
          <div className="grid grid-cols-2 gap-3 h-full pb-1">
            {systemMetrics.map((m, i) => (
              <div
                key={i}
                className={`cursor-pointer relative rounded-xl p-3 flex flex-col justify-between border border-white/5 overflow-hidden group hover:border-white/10 transition-all duration-300 bg-linear-to-br ${m.bgGradient}`}
              >
                {/* 1. Subtle Themed Pattern Overlay */}
                <div
                  className={`absolute inset-0 ${m.pattern} opacity-30 group-hover:opacity-60 transition-opacity duration-500 pointer-events-none`}
                />

                {/* 2. Massive Faded Background Icon */}
                <div
                  className={`absolute -bottom-8 -right-8 opacity-[0.03] group-hover:opacity-[0.08] transition-all duration-500 transform group-hover:scale-110 pointer-events-none ${m.colorClass}`}
                >
                  {m.bgIcon}
                </div>

                {/* 3. Subtle Hover Laser Glow Top Edge */}
                <div
                  className={`absolute top-0 left-0 w-full h-px bg-linear-to-r from-transparent ${m.glowClass} to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500`}
                />

                <div className="relative z-10 flex justify-between items-start">
                  <span
                    className={`text-base ${m.colorClass} opacity-70 group-hover:opacity-100 transition-opacity`}
                  >
                    {m.icon}
                  </span>
                  <span className="text-[8px] font-mono tracking-widest uppercase opacity-70 group-hover:opacity-100 transition-opacity text-zinc-300">{m.label}</span>
                </div>

                <div className="relative z-10 flex flex-col gap-1.5 mt-2">
                  <span className="text-xs font-bold text-white font-mono tracking-wide" style={{ textShadow: '0 0 8px rgba(255,255,255,0.15)' }}>
                    {m.val}
                  </span>
                  {/* Dynamic Hardware Bar */}
                  {!m.hideBar && (
                    <div className="relative w-full h-1 bg-black/40 rounded-full overflow-hidden backdrop-blur-sm border border-white/5">
                      <div
                        className={`h-full ${m.bgClass} ${m.shadowClass} transition-all duration-700 ease-out`}
                        style={{ width: isSystemActive ? `${m.raw}%` : '0%' }}
                      />
                      {isSystemActive && m.raw > 0 && (
                        <div className="absolute inset-y-0 left-0 w-1/3 bg-linear-to-r from-transparent via-white/50 to-transparent brutus-bar-sheen" />
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="col-span-12 lg:col-span-6 relative flex flex-col items-center justify-center">
        <div
          className={`lg:hidden absolute top-4 right-4 w-32 h-24 ${glassPanel} z-50 overflow-hidden ${isVideoOn ? 'block' : 'hidden'}`}
        >
          <video
            ref={setMobileVideoRef}
            className={`w-full h-full object-cover ${visionMode === 'camera' ? '-scale-x-100' : ''}`}
            autoPlay
            playsInline
            muted
          />
        </div>

        {isSystemActive && (
          <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[44vh] h-[44vh] rounded-full blur-2xl opacity-60 z-0 brutus-aura" />
        )}

        <div
          className={`relative z-10 w-[60vh] h-[60vh] max-w-full transition-all duration-1000 ${isSystemActive ? 'opacity-100 scale-100' : 'opacity-85 scale-90 grayscale'}`}
          style={{
            filter: isSystemActive ? 'drop-shadow(0 0 18px rgba(180,60,60,0.18))' : 'none',
            transition: 'filter 1.5s ease'
          }}
        >
          <Sphere />
        </div>

        <div className="absolute bottom-10 z-50">
          <div
            className={`${glassPanel} px-6 py-3 rounded-full flex items-center gap-6 border border-red-500/20 shadow-[0_0_30px_rgba(0,0,0,0.5)]`}
          >
            <button
              onClick={onVisionClick}
              className={`cursor-pointer p-3 rounded-full transition-all ${isVideoOn ? 'bg-red-500/20 text-red-400' : 'hover:bg-white/10 text-zinc-400'}`}
            >
              {isVideoOn ? <RiSwapBoxLine size={20} /> : <RiCameraLine size={20} />}
            </button>
            <button onClick={toggleSystem} className="relative group mx-2">
              {isSystemActive && (
                <>
                  <span className="pointer-events-none absolute inset-0 rounded-full border border-red-400/60 brutus-ring" />
                  <span
                    className="pointer-events-none absolute inset-0 rounded-full border border-red-400/40 brutus-ring"
                    style={{ animationDelay: '1.2s' }}
                  />
                </>
              )}
              <div
                className={`relative cursor-pointer p-4 rounded-full border-2 transition-all duration-500 ${isSystemActive ? 'bg-red-500 border-red-400 text-black shadow-[0_0_20px_#ef4444]' : 'bg-red-500/10 border-red-500/50 text-red-500 group-hover:bg-red-500/20 group-hover:scale-105'}`}
              >
                <RiPhoneFill size={24} className={isSystemActive ? 'animate-pulse' : ''} />
              </div>
            </button>
            <button
              onClick={toggleMic}
              className={`cursor-pointer p-3 rounded-full transition-all ${isMicMuted ? 'bg-red-500/20 text-red-400' : 'bg-red-500/10 text-red-400'}`}
            >
              {isMicMuted ? <RiMicOffLine size={20} /> : <RiMicLine size={20} />}
            </button>
          </div>
        </div>
      </div>

      <div className="hidden lg:flex col-span-3 flex-col overflow-hidden h-full z-40">
        <div className={`${glassPanel} h-full p-4 flex flex-col`}>
          <div className="flex items-center justify-between border-b border-white/10 pb-3 mb-2">
            <span className="text-[10px] font-bold tracking-widest text-zinc-400">
              <RiTerminalBoxLine className="inline mr-1" /> TRANSCRIPT
            </span>
            <span className="text-[8px] font-mono text-red-500/50">LIVE-LOG</span>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-small">
            {chatHistory.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-zinc-700 gap-2 opacity-50">
                <RiHistoryLine size={24} />
                <span className="text-[9px] tracking-widest uppercase font-mono">
                  No Data Stream
                </span>
              </div>
            ) : (
              chatHistory.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[95%] py-2 px-3 rounded-lg text-[11px] leading-relaxed border font-mono font-semibold ${msg.role === 'user' ? 'bg-red-900/20 border-red-500/20 text-red-100/90 rounded-br-none' : 'bg-zinc-900/50 border-white/5 text-zinc-400 rounded-bl-none'}`}
                  >
                    {msg.parts && msg.parts[0] ? msg.parts[0].text : msg.content}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="pt-2 mt-2 border-t border-white/5">
            <div className="flex items-end gap-2">
              <textarea
                ref={textInputRef}
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={handleTextKeyDown}
                disabled={!isSystemActive}
                placeholder={isSystemActive ? 'Type a message...' : 'System offline'}
                rows={1}
                className="flex-1 bg-black/40 border border-white/5 rounded-lg text-[11px] text-zinc-200 placeholder-zinc-600 font-mono px-3 py-2 outline-none resize-none focus:border-red-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              />
              <button
                onClick={handleSendText}
                disabled={!isSystemActive || !textInput.trim()}
                className="p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-all disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer"
              >
                <RiSendPlaneLine size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
