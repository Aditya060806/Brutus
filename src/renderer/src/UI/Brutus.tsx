import { useState, useEffect, Suspense, lazy } from 'react'
import {
  RiShieldFlashLine,
  RiLayoutGridLine,
  RiBrainLine,
  RiFolderOpenLine,
  RiPhoneLine,
  RiSettings4Line,
  RiCameraLine,
  RiComputerLine,
  RiCloseLine,
  RiImageLine,
  RiSlideshow3Line,
  RiNodeTree,
  RiRobot2Line
} from 'react-icons/ri'
import { getSystemStatus } from '@renderer/services/system-info'
import { getHistory } from '@renderer/services/brutus-ai-brain'
import ViewSkeleton from '@renderer/components/ViewSkelrton'

import DashboardView from '../views/Dashboard'
import PhoneView from '../views/Phone'
import { VisionMode } from '@renderer/IndexRoot'

const AppsView = lazy(() => import('../views/APP'))
const WorkFlowEditorView = lazy(() => import('../views/WorkFlowEditor'))
const NotesView = lazy(() => import('../views/Notes'))
const SettingsView = lazy(() => import('../views/Settings'))
const GalleryView = lazy(() => import('../views/Gallery'))
const RobotView = lazy(() => import('../views/Robot'))

interface BrutusProps {
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

const glassPanel = 'bg-zinc-950/40 backdrop-blur-xl border border-white/5 rounded-2xl shadow-xl'

const Brutus = (props: BrutusProps) => {
  const [activeTab, setActiveTab] = useState('DASHBOARD')
  const [stats, setStats] = useState<any>(null)
  const [time, setTime] = useState<Date>(new Date())
  const [chatHistory, setChatHistory] = useState<any[]>([])
  const [showSourceModal, setShowSourceModal] = useState(false)

  // The clock is local and cheap, so it ticks every second. System stats are an
  // IPC round-trip into the main process — polling those twice a second (as this
  // did) meant four IPC calls per second forever, for numbers that move slowly.
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const pull = (): void => void getSystemStatus().then(setStats)
    pull()
    const timer = setInterval(pull, 2000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const fetchHistory = async () => {
      const history = await getHistory()
      if (Array.isArray(history)) setChatHistory(history.slice(-15))
    }
    fetchHistory()
    const interval = setInterval(fetchHistory, 1000)
    return () => clearInterval(interval)
  }, [])

  const handleVisionClick = () => {
    if (props.isVideoOn) {
      props.stopVision()
    } else {
      setShowSourceModal(true)
    }
  }

  return (
    <div className="h-screen w-full bg-black text-zinc-100 font-sans overflow-hidden select-none flex flex-col relative pb-5">
      {/* Top bar. Single accent (red), one line, 56px. Labels use one casing.
          The old bar mixed DASHBOARD / Macros / Apps casing, ran a second accent
          hue (cyan) on one action button, and showed a hardcoded "100%" battery
          that was never real. */}
      <div className="h-14 w-full flex items-center justify-between gap-4 px-5 bg-zinc-950/80 border-b border-white/[0.06] z-50 backdrop-blur-md">
        <div className="hidden lg:flex items-center gap-2.5 shrink-0">
          <RiShieldFlashLine className="text-red-500 text-lg" />
          <span className="font-black tracking-[0.18em] text-[13px] text-zinc-100">BRUTUS</span>
        </div>

        <nav className="hidden md:flex items-center gap-0.5 bg-black/30 p-1 rounded-lg border border-white/[0.06]">
          {[
            { id: 'DASHBOARD', label: 'Home', icon: <RiLayoutGridLine /> },
            { id: 'Macros', label: 'Macros', icon: <RiBrainLine /> },
            { id: 'Apps', label: 'Apps', icon: <RiFolderOpenLine /> },
            { id: 'NOTES', label: 'Notes', icon: <RiFolderOpenLine /> },
            { id: 'GALLERY', label: 'Gallery', icon: <RiImageLine /> },
            { id: 'PHONE', label: 'Phone', icon: <RiPhoneLine /> },
            { id: 'ROBOT', label: 'Robot', icon: <RiRobot2Line /> },
            { id: 'SETTINGS', label: 'Settings', icon: <RiSettings4Line /> }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`cursor-pointer px-3 py-1.5 text-[11px] font-semibold rounded-md transition-colors duration-200 flex items-center gap-1.5 ${
                activeTab === tab.id
                  ? 'bg-red-500/15 text-red-400'
                  : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
              }`}
            >
              <span className="text-[13px]">{tab.icon}</span>
              {tab.label}
            </button>
          ))}

          <div className="w-px self-stretch my-1.5 mx-1 bg-white/10" />

          {/* Secondary tools stay neutral so they never outrank the nav or
              introduce a second accent colour. */}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-deck-studio'))}
            title="Deck Studio - AI presentation maker"
            className="cursor-pointer p-2 rounded-md text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors"
          >
            <RiSlideshow3Line className="text-[15px]" />
          </button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-knowledge-graph'))}
            title="Knowledge Graph - ingest documents and ask"
            className="cursor-pointer p-2 rounded-md text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors"
          >
            <RiNodeTree className="text-[15px]" />
          </button>
        </nav>

        <div className="flex items-center gap-4 shrink-0">
          <div className="hidden sm:flex items-center gap-2">
            <span
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                props.isSystemActive ? 'bg-red-500' : 'bg-zinc-700'
              }`}
            />
            <span
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${
                props.isSystemActive ? 'text-red-400' : 'text-zinc-600'
              }`}
            >
              {props.isSystemActive ? 'Live' : 'Idle'}
            </span>
          </div>
          <span className="text-[11px] font-mono tabular-nums text-zinc-400">
            {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-hidden relative bg-[radial-gradient(circle_at_center,var(--tw-gradient-stops))] from-zinc-900/50 via-black to-black">
        <div className={`absolute inset-0 ${activeTab === 'DASHBOARD' ? 'block' : 'hidden'}`}>
          <DashboardView
            props={props}
            stats={stats}
            chatHistory={chatHistory}
            onVisionClick={handleVisionClick}
          />
        </div>

        <div className={`absolute inset-0 ${activeTab === 'PHONE' ? 'block' : 'hidden'}`}>
          <PhoneView glassPanel={glassPanel} />
        </div>

        <Suspense fallback={<ViewSkeleton />}>
          {activeTab === 'Macros' && <WorkFlowEditorView />}
          {activeTab === 'Apps' && <AppsView />}
          {activeTab === 'NOTES' && <NotesView glassPanel={glassPanel} />}
          {activeTab === 'SETTINGS' && <SettingsView isSystemActive={props.isSystemActive} />}
          {activeTab === 'GALLERY' && <GalleryView />}
          {activeTab === 'ROBOT' && <RobotView />}
        </Suspense>
      </div>

      {showSourceModal && (
        <div className="absolute inset-0 z-100 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className={`${glassPanel} w-96 p-1 border-red-500/30 flex flex-col shadow-2xl`}>
            <div className="flex items-center justify-between p-4 border-b border-white/5 bg-white/5">
              <span className="text-xs font-bold tracking-widest text-red-400">
                ESTABLISH UPLINK
              </span>
              <button
                onClick={() => setShowSourceModal(false)}
                className="cursor-pointer text-zinc-500 hover:text-white"
              >
                <RiCloseLine size={18} />
              </button>
            </div>

            <div className="p-4 grid grid-cols-2 gap-4">
              <button
                onClick={() => {
                  props.startVision('camera')
                  setShowSourceModal(false)
                }}
                className="cursor-pointer group flex flex-col items-center justify-center gap-3 p-6 rounded-xl bg-black/40 border border-white/10 hover:border-red-500/50 hover:bg-red-500/10 transition-all"
              >
                <div className="p-3 rounded-full bg-zinc-900 group-hover:bg-red-500 text-zinc-400 group-hover:text-black transition-colors">
                  <RiCameraLine size={28} />
                </div>
                <span className="text-[10px] font-bold tracking-widest text-zinc-300 group-hover:text-red-400">
                  CAMERA FEED
                </span>
              </button>

              <button
                onClick={() => {
                  props.startVision('screen')
                  setShowSourceModal(false)
                }}
                className="cursor-pointer group flex flex-col items-center justify-center gap-3 p-6 rounded-xl bg-black/40 border border-white/10 hover:border-red-500/50 hover:bg-red-500/10 transition-all"
              >
                <div className="p-3 rounded-full bg-zinc-900 group-hover:bg-red-500 text-zinc-400 group-hover:text-black transition-colors">
                  <RiComputerLine size={28} />
                </div>
                <span className="text-[10px] font-bold tracking-widest text-zinc-300 group-hover:text-red-400">
                  SCREEN SHARE
                </span>
              </button>
            </div>

            <div className="p-3 bg-black/20 text-center">
              <p className="text-[9px] text-zinc-600 font-mono">
                SELECT INPUT SOURCE FOR NEURAL PROCESSING
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Brutus
