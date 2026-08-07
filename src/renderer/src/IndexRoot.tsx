import { useState, useEffect, useRef } from 'react'
import MiniOverlay from './components/MiniOverlay'
import { brutusService } from './services/Brutus-voice-ai'
import { getScreenSourceId } from './hooks/CaptureDesktop'
import Brutus from './UI/Brutus'
import TerminalOverlay from './components/TerminalOverlay'
import LeafletMapWidget from './Widgets/MapView'
import ImageWidget from './Widgets/ImageWidget'
import EmailWidget from './Widgets/EmailWidget'
import WeatherWidget from './Widgets/WeatherWidget'
import StockWidget from './Widgets/StockWidget'
import LiveCodingWidget from './Widgets/LiveCodingWidget'
import WormholeWidget from './Widgets/WormholeWidget'
import OracleWidget from './Widgets/RagOrcaleWidget'
import ResearchWidget from './Widgets/DeepResearch'
import SemanticWidget from './Widgets/SematicSearch'
import SmartDropZonesWidget from './Widgets/SmartZoneWidget'
import TitleBar from './components/Titlebar'
import QRWidget from './Widgets/QRWidget'
import ChatPanel from './components/ChatPanel'
import EdgeStatusChip from './components/EdgeStatusChip'
import DramaticOverlay from './components/DramaticOverlay'
import DuetOverlay from './components/DuetOverlay'
import { duetController } from './services/duet-controller'
import DeckStudioWidget from './Widgets/DeckStudioWidget'
import KnowledgeGraphWidget from './Widgets/KnowledgeGraphWidget'
import { RiChat3Line, RiMicLine, RiSlideshow3Line, RiNodeTree } from 'react-icons/ri'

export type VisionMode = 'camera' | 'screen' | 'none'

const IndexRoot = () => {
  const [isOverlay, setIsOverlay] = useState(false)
  const [isChatOpen, setIsChatOpen] = useState(false)

  const [isSystemActive, setIsSystemActive] = useState(false)
  const [isMicMuted, setIsMicMuted] = useState(true)

  const [isVideoOn, setIsVideoOn] = useState(false)
  const [visionMode, setVisionMode] = useState<VisionMode>('none')

  /**
   * Which view the shell is showing.
   *
   * Defaults to the tab the shell itself starts on, because a child's effects
   * run before its parent's — the shell's first announcement is dispatched
   * before this listener exists, so the default has to already be right.
   */
  const [activeTab, setActiveTab] = useState('DASHBOARD')
  const onDashboard = activeTab === 'DASHBOARD'

  useEffect(() => {
    const onTab = (e: Event): void => setActiveTab((e as CustomEvent<string>).detail)
    window.addEventListener('brutus-tab', onTab)
    return () => window.removeEventListener('brutus-tab', onTab)
  }, [])

  const processingVideoRef = useRef<HTMLVideoElement>(document.createElement('video'))
  const activeStreamRef = useRef<MediaStream | null>(null)
  const aiIntervalRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    window.electron.ipcRenderer.on('overlay-mode', (_e, mode) => setIsOverlay(mode))
    // Listen for Duet Mode commands from a paired phone (works app-wide).
    duetController.init()
    return () => {
      window.electron.ipcRenderer.removeAllListeners('overlay-mode')
    }
  }, [])

  // When a reminder/timer fires, have Brutus announce it (if connected).
  useEffect(() => {
    const handler = (_e: unknown, payload: any) => {
      const text = payload?.text
      const type = payload?.type || 'reminder'
      if (text) {
        window.dispatchEvent(
          new CustomEvent('ai-force-speak', {
            detail: `[SYSTEM]: A ${type} just triggered. Announce this to the user clearly and briefly: "${text}"`
          })
        )
      }
    }
    window.electron.ipcRenderer.on('reminder-fired', handler)
    return () => window.electron.ipcRenderer.removeAllListeners('reminder-fired')
  }, [])

  /**
   * Turns the UI off when the voice service is genuinely dead.
   *
   * ── WHY IT WAITS NOW ──
   * This is what users saw as "the power button switches itself off". It polls
   * every second and flips the toggle the instant the service is not connected
   * and not visibly recovering — but there are brief, normal moments where all
   * three flags are false: between a socket closing and the reconnect being
   * scheduled, and during the gap while a backoff timer is pending.
   *
   * A single unlucky sample in that window killed a session that was about to
   * recover on its own. Requiring the condition to hold for several consecutive
   * polls means a real failure still turns the UI off within a few seconds,
   * while a reconnect in progress is left alone.
   *
   * The service-side fixes (a whole-attempt connect deadline, and a failed
   * reconnect re-entering the state machine instead of stranding
   * `isReconnecting`) close the other half of this: the states this watchdog
   * reads are now always eventually truthful.
   */
  useEffect(() => {
    let deadPolls = 0
    const DEAD_POLLS_BEFORE_OFF = 4

    const watchdog = setInterval(() => {
      const recovering = brutusService.isConnecting || brutusService.isReconnecting
      const dead = isSystemActive && !brutusService.isConnected && !recovering

      if (!dead) {
        deadPolls = 0
        return
      }

      deadPolls++
      if (deadPolls < DEAD_POLLS_BEFORE_OFF) return

      console.warn('[Brutus] Voice service is down and not recovering — switching off.')
      deadPolls = 0
      setIsSystemActive(false)
      setIsMicMuted(true)
      stopVision()
    }, 1000)

    return () => clearInterval(watchdog)
  }, [isSystemActive])

  const toggleSystem = async () => {
    if (!isSystemActive) {
      try {
        await brutusService.connect()
        setIsSystemActive(true)
        setIsMicMuted(false)
        brutusService.setMute(false)
      } catch (err: any) {
        if (err.message === 'NO_API_KEY') {
          alert(
            '⚠️ CRITICAL ERROR: Gemini API Key is missing. Please enter it in the Command Center Vault (Settings Tab).'
          )
        } else {
          alert(`Connection failed: ${err.message}`)
        }
        setIsSystemActive(false)
      }
    } else {
      brutusService.disconnect()
      setIsSystemActive(false)
      setIsMicMuted(true)
      brutusService.setMute(true)
      stopVision()
    }
  }

  const toggleMic = () => {
    const s = !isMicMuted
    setIsMicMuted(s)
    brutusService.setMute(s)
  }

  const startVision = async (mode: 'camera' | 'screen') => {
    if (!isSystemActive) return

    try {
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach((t) => t.stop())
      }

      let stream: MediaStream

      if (mode === 'camera') {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 }
        })
      } else {
        const sourceId = await getScreenSourceId()
        if (!sourceId) return
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            // @ts-ignore
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxWidth: 1280,
              maxHeight: 720
            }
          }
        })
      }

      activeStreamRef.current = stream

      processingVideoRef.current.srcObject = stream
      await processingVideoRef.current.play()

      setVisionMode(mode)
      setIsVideoOn(true)

      startAIProcessing()

      stream.getVideoTracks()[0].onended = () => stopVision()
    } catch (e) {
      stopVision()
    }
  }

  const stopVision = () => {
    setIsVideoOn(false)
    setVisionMode('none')

    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach((t) => t.stop())
      activeStreamRef.current = null
    }

    if (processingVideoRef.current) {
      processingVideoRef.current.srcObject = null
    }

    if (aiIntervalRef.current) {
      clearInterval(aiIntervalRef.current)
      aiIntervalRef.current = null
    }
  }

  const startAIProcessing = () => {
    if (aiIntervalRef.current) clearInterval(aiIntervalRef.current)

    aiIntervalRef.current = setInterval(() => {
      const vid = processingVideoRef.current
      if (vid && vid.readyState === 4 && brutusService.socket?.readyState === WebSocket.OPEN) {
        const canvas = document.createElement('canvas')
        canvas.width = 800
        canvas.height = 450
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(vid, 0, 0, canvas.width, canvas.height)
          const base64 = canvas.toDataURL('image/jpeg', 0.6).split(',')[1]
          brutusService.sendVideoFrame(base64)
        }
      }
    }, 2000)
  }

  if (isOverlay) {
    return (
      <div className="w-screen h-screen overflow-hidden flex items-center justify-center bg-transparent">
        <MiniOverlay
          isSystemActive={isSystemActive}
          toggleSystem={toggleSystem}
          isMicMuted={isMicMuted}
          toggleMic={toggleMic}
          isVideoOn={isVideoOn}
          visionMode={visionMode}
          startVision={startVision}
          stopVision={stopVision}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-black overflow-hidden relative border border-red-500/20 rounded-xl">
      <TitleBar />
      <div className="flex-1 relative">
        <Brutus
          isSystemActive={isSystemActive}
          toggleSystem={toggleSystem}
          isMicMuted={isMicMuted}
          toggleMic={toggleMic}
          isVideoOn={isVideoOn}
          visionMode={visionMode}
          startVision={startVision}
          stopVision={stopVision}
          activeStream={activeStreamRef.current}
        />
      </div>
      <SmartDropZonesWidget />
      <SemanticWidget />
      <OracleWidget />
      <WormholeWidget />
      <LeafletMapWidget />
      <StockWidget />
      <WeatherWidget />
      <ImageWidget />
      <EmailWidget />
      <TerminalOverlay />
      <LiveCodingWidget />
      <ResearchWidget />
      <QRWidget />

      {/* ── Floating launchers ──
          Dashboard only. These are `fixed`, so on any other view they hover
          over that view's own controls — on the Studio canvas they sat right on
          top of the zoom and grid cluster. Each destination has its own way in
          from the top nav, so nothing becomes unreachable by hiding them. */}
      {onDashboard && (
        <>
          {/* Voice / Text mode toggle */}
          <button
            onClick={() => setIsChatOpen((v) => !v)}
            title={isChatOpen ? 'Switch to voice' : 'Switch to text chat'}
            className="fixed bottom-6 right-6 z-[9065] h-12 w-12 flex items-center justify-center rounded-full bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-300 shadow-[0_8px_30px_rgba(var(--brutus-accent-c),0.25)] backdrop-blur-md transition-all hover:scale-105"
          >
            {isChatOpen ? <RiMicLine size={20} /> : <RiChat3Line size={20} />}
          </button>

          {/* Deck Studio launcher */}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-deck-studio'))}
            title="Open Deck Studio (AI presentation maker)"
            className="fixed bottom-6 right-20 z-[9065] h-12 w-12 flex items-center justify-center rounded-full bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-300 shadow-[0_8px_30px_rgba(var(--brutus-accent-c),0.25)] backdrop-blur-md transition-all hover:scale-105"
          >
            <RiSlideshow3Line size={20} />
          </button>

          {/* Knowledge Graph launcher */}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-knowledge-graph'))}
            title="Open Knowledge Graph (industrial operations brain)"
            className="fixed bottom-6 right-[8.5rem] z-[9065] h-12 w-12 flex items-center justify-center rounded-full bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 shadow-[0_8px_30px_rgba(6,182,212,0.25)] backdrop-blur-md transition-all hover:scale-105"
          >
            <RiNodeTree size={20} />
          </button>
        </>
      )}

      {/* Anchored just above the toggle, so it follows the same rule. Hiding
          rather than closing means coming back to the Dashboard restores it
          exactly as you left it. */}
      <ChatPanel open={isChatOpen && onDashboard} onClose={() => setIsChatOpen(false)} />
      <EdgeStatusChip active={isSystemActive} />
      <DramaticOverlay />
      <DuetOverlay />
      <DeckStudioWidget />
      <KnowledgeGraphWidget />
    </div>
  )
}

export default IndexRoot
