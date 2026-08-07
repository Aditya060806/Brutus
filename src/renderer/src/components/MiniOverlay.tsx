import { useState, useEffect, useRef } from 'react'
import {
  RiMicLine,
  RiMicOffLine,
  RiComputerLine,
  RiCameraLine,
  RiFullscreenLine
} from 'react-icons/ri'
import { GiPowerButton } from 'react-icons/gi'
import { brutusService } from '@renderer/services/Brutus-voice-ai'
import { VisionMode } from '@renderer/IndexRoot'

interface OverlayProps {
  isSystemActive: boolean
  toggleSystem: () => void
  isMicMuted: boolean
  toggleMic: () => void
  isVideoOn: boolean
  visionMode: VisionMode
  startVision: (mode: 'camera' | 'screen') => void
  stopVision: () => void
}

const MiniOverlay = ({
  isSystemActive,
  toggleSystem,
  isMicMuted,
  toggleMic,
  isVideoOn,
  visionMode,
  startVision,
  stopVision
}: OverlayProps) => {
  const [isTalking, setIsTalking] = useState(false)
  const analyzerRef = useRef<AnalyserNode | null>(null)
  const dataArrayRef = useRef<Uint8Array | any | null>(null)

  useEffect(() => {
    if (isSystemActive && brutusService.analyser) {
      analyzerRef.current = brutusService.analyser
      dataArrayRef.current = new Uint8Array(brutusService.analyser.frequencyBinCount)
      const checkAudio = () => {
        if (analyzerRef.current && dataArrayRef.current) {
          analyzerRef.current.getByteFrequencyData(dataArrayRef.current)
          const avg = dataArrayRef.current.reduce((a, b) => a + b) / dataArrayRef.current.length
          setIsTalking(avg > 10)
        }
        if (isSystemActive) requestAnimationFrame(checkAudio)
      }
      checkAudio()
    } else {
      setIsTalking(false)
    }
  }, [isSystemActive])

  const handleVisionClick = (mode: 'camera' | 'screen') => {
    if (isVideoOn && visionMode === mode) {
      stopVision()
    } else {
      startVision(mode)
    }
  }

  const expand = () => {
    window.electron.ipcRenderer.send('toggle-overlay')
  }

  return (
    <div className="w-full h-full flex items-center justify-center px-2 bg-black/95 backdrop-blur-2xl rounded-2xl border border-white/[0.06] shadow-[0_4px_30px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.03)] drag-region overflow-hidden">
      <div className="flex items-center gap-1 no-drag">
        <div
          className={`w-7 h-7 rounded-xl flex items-center justify-center transition-all duration-500 ${isSystemActive ? (isTalking ? 'bg-red-500/20 shadow-[0_0_12px_rgba(var(--brutus-accent-c),0.4)]' : 'bg-red-500/10') : 'bg-white/[0.03]'}`}
        >
          <div
            className={`w-2 h-2 rounded-full transition-all duration-500 ${isSystemActive ? (isTalking ? 'bg-red-400 shadow-[0_0_6px_rgba(var(--brutus-accent-c),0.9)]' : 'bg-red-600') : 'bg-zinc-700'}`}
          />
        </div>

        <div className="w-px h-5 bg-white/[0.06] mx-1" />

        <button
          onClick={toggleMic}
          disabled={!isSystemActive}
          className={`p-1.5 rounded-lg transition-all duration-200 ${!isSystemActive ? 'opacity-20 cursor-default' : isMicMuted ? 'text-red-400 bg-red-500/10 hover:bg-red-500/20' : 'text-zinc-300 hover:text-white hover:bg-white/[0.06]'}`}
        >
          {isMicMuted ? <RiMicOffLine size={15} /> : <RiMicLine size={15} />}
        </button>

        <button
          onClick={toggleSystem}
          className={`p-2 rounded-xl border transition-all duration-500 mx-0.5 ${isSystemActive ? 'bg-red-500/15 border-red-500/40 text-red-400 shadow-[0_0_20px_rgba(var(--brutus-accent-c),0.15)]' : 'bg-white/[0.03] border-white/[0.06] text-zinc-500 hover:text-white hover:border-white/10'}`}
        >
          <GiPowerButton size={16} className={isSystemActive ? 'animate-pulse' : ''} />
        </button>

        <button
          onClick={() => handleVisionClick('camera')}
          disabled={!isSystemActive}
          className={`p-1.5 rounded-lg transition-all duration-200 ${!isSystemActive ? 'opacity-20 cursor-default' : isVideoOn && visionMode === 'camera' ? 'text-red-400 bg-red-500/10' : 'text-zinc-500 hover:text-white hover:bg-white/[0.06]'}`}
          title="Camera"
        >
          <RiCameraLine size={15} />
        </button>

        <button
          onClick={() => handleVisionClick('screen')}
          disabled={!isSystemActive}
          className={`p-1.5 rounded-lg transition-all duration-200 ${!isSystemActive ? 'opacity-20 cursor-default' : isVideoOn && visionMode === 'screen' ? 'text-red-400 bg-red-500/10' : 'text-zinc-500 hover:text-white hover:bg-white/[0.06]'}`}
          title="Screen"
        >
          <RiComputerLine size={15} />
        </button>

        <div className="w-px h-5 bg-white/[0.06] mx-1" />

        <button
          onClick={expand}
          className="p-1.5 rounded-lg text-zinc-600 hover:text-white hover:bg-white/[0.06] transition-all duration-200 no-drag"
        >
          <RiFullscreenLine size={14} />
        </button>
      </div>
    </div>
  )
}

export default MiniOverlay
