import { useState, useEffect, Suspense, lazy } from 'react'
import {
  RiShieldFlashLine,
  RiSettings4Line,
  RiCameraLine,
  RiComputerLine,
  RiCloseLine,
  RiSlideshow3Line,
  RiNodeTree
} from 'react-icons/ri'
import { getSystemStatus, type SystemStats } from '@renderer/services/system-info'
import { getHistory, type ChatMessage } from '@renderer/services/brutus-ai-brain'
import ViewSkeleton from '@renderer/components/ViewSkelrton'
import AppBackground from '@renderer/components/AppBackground'
import SettingsModal from '@renderer/components/settings/SettingsModal'
import { openSettings } from '@renderer/components/settings/open-settings'
import { Tooltip, cn } from '@renderer/components/ui'
import { avatarClass, useProfileStore } from '@renderer/store/profile-store'
import { useAuthStore } from '@renderer/store/auth-store'

import DashboardView from '../views/Dashboard'
import PhoneView from '../views/Phone'
import { VisionMode } from '@renderer/IndexRoot'

const DeskView = lazy(() => import('../views/Desk'))
const AppsView = lazy(() => import('../views/APP'))
const WorkFlowEditorView = lazy(() => import('../views/WorkFlowEditor'))
const NotesView = lazy(() => import('../views/Notes'))
const GalleryView = lazy(() => import('../views/Gallery'))
const RobotView = lazy(() => import('../views/Robot'))
const OrchestratorView = lazy(() => import('../views/Orchestrator'))
const StudioView = lazy(() => import('../views/Studio'))

/**
 * The top navigation.
 *
 * Labels only — no icons. Nine icons beside nine words is nine redundant
 * shapes: the words already say it, and at 12px the glyphs were decoration
 * rather than wayfinding.
 *
 * Settings is deliberately NOT one of these. It is a modal now, reachable from
 * the gear in the right-hand cluster and from Ctrl+, anywhere in the app — so
 * it opens over whatever you were doing instead of navigating you away from it.
 */
const TABS = [
  { id: 'DASHBOARD', label: 'Home' },
  { id: 'DESK', label: 'Desk' },
  { id: 'Macros', label: 'Macros' },
  { id: 'Apps', label: 'Apps' },
  { id: 'NOTES', label: 'Notes' },
  { id: 'GALLERY', label: 'Gallery' },
  { id: 'PHONE', label: 'Phone' },
  { id: 'AGENTS', label: 'Agents' },
  { id: 'STUDIO', label: 'Studio' },
  { id: 'ROBOT', label: 'Robot' }
]

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

const Brutus = (props: BrutusProps): React.JSX.Element => {
  const [activeTab, setActiveTab] = useState('DASHBOARD')
  // Typed from what the services actually return rather than `any` — both
  // already declare their shapes, so this cost nothing and gives the dashboard
  // props real checking.
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [time, setTime] = useState<Date>(new Date())
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [showSourceModal, setShowSourceModal] = useState(false)

  // The account chip prefers the cloud identity and falls back to the local
  // display name, so it reads correctly whether or not the user has signed in.
  const cloudUser = useAuthStore((s) => s.user)
  const displayName = useProfileStore((s) => s.displayName)
  const avatarColor = useProfileStore((s) => s.avatarColor)
  const accountName = cloudUser?.name || displayName || 'Operator'
  const accountInitial = accountName.trim().charAt(0).toUpperCase() || 'B'

  // The Dashboard composer fires this after starting a /agent run so the user
  // lands on the live task graph instead of watching a silent transcript.
  useEffect(() => {
    const jump = (): void => setActiveTab('AGENTS')
    window.addEventListener('open-orchestrator', jump)
    return () => window.removeEventListener('open-orchestrator', jump)
  }, [])

  // Announce the current view so the app-level floating launchers can get out
  // of the way. They sit above every view and were overlapping the Studio
  // canvas' own bottom-right controls, so they now only show on the Dashboard.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('brutus-tab', { detail: activeTab }))
  }, [activeTab])

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
    const fetchHistory = async (): Promise<void> => {
      const history = await getHistory()
      if (Array.isArray(history)) setChatHistory(history.slice(-15))
    }
    void fetchHistory()
    const interval = setInterval(fetchHistory, 1000)
    return () => clearInterval(interval)
  }, [])

  const handleVisionClick = (): void => {
    if (props.isVideoOn) {
      props.stopVision()
    } else {
      setShowSourceModal(true)
    }
  }

  return (
    <div className="relative flex h-screen w-full select-none flex-col overflow-hidden bg-canvas pb-5 font-sans text-content">
      {/* ── Top bar ──
          Stays at the top by design.

          ── WHY THIS IS SO PLAIN ──
          The previous bar was a bordered pill container holding nine
          icon+label buttons, a divider, two more icon buttons, then a second
          cluster — four nested boxes and eleven competing shapes across 56px.
          It read as a toolbar from a different application.

          Now: plain text labels, no container, no icons. The active item is
          simply the only white one, marked with a 1px rule that sits ON the
          header's bottom border — the item and the surface it belongs to are
          visually joined, which is what makes a nav read as a nav. Everything
          else is grey until you hover it. */}
      <header className="relative z-50 flex h-14 w-full shrink-0 items-center justify-between gap-6 border-b border-line bg-canvas/85 px-5 backdrop-blur-xl">
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <RiShieldFlashLine className="text-[15px] text-content-secondary" />
          <span className="text-[12px] font-semibold tracking-[0.2em] text-content">BRUTUS</span>
        </div>

        {/* Centred, not left-aligned. Absolute rather than a flex child so it
            stays on the window's true centre line regardless of how wide the
            brand and the right-hand cluster happen to be. */}
        <nav
          aria-label="Main"
          className="absolute left-1/2 hidden h-full -translate-x-1/2 items-stretch md:flex"
        >
          {TABS.map((tab) => {
            const active = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative cursor-pointer px-3.5 text-[12px] transition-colors duration-200',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                  active
                    ? 'font-medium text-content'
                    : 'text-content-muted hover:text-content-secondary'
                )}
              >
                {tab.label}
                {/* -1px so the indicator overlaps the header border rather than
                    floating above it. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-none absolute inset-x-3 -bottom-px h-px transition-opacity duration-200',
                    active ? 'bg-content opacity-100' : 'bg-content opacity-0'
                  )}
                />
              </button>
            )
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-1">
          {/* Status. The dot is the only accent in this bar, and only when the
              link is actually live — that is the whole point of it. */}
          <div className="mr-2 hidden items-center gap-2 sm:flex">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full transition-colors duration-300',
                props.isSystemActive ? 'bg-primary-500 shadow-glow' : 'bg-line-strong'
              )}
            />
            <span className="font-mono text-[11px] tabular-nums text-content-muted">
              {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          <Tooltip label="Deck Studio" side="bottom">
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-deck-studio'))}
              aria-label="Open Deck Studio"
              className="cursor-pointer rounded-lg p-2 text-content-faint transition-colors hover:bg-hover hover:text-content-secondary"
            >
              <RiSlideshow3Line className="text-[15px]" />
            </button>
          </Tooltip>
          <Tooltip label="Knowledge Graph" side="bottom">
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-knowledge-graph'))}
              aria-label="Open Knowledge Graph"
              className="cursor-pointer rounded-lg p-2 text-content-faint transition-colors hover:bg-hover hover:text-content-secondary"
            >
              <RiNodeTree className="text-[15px]" />
            </button>
          </Tooltip>
          <Tooltip label="Settings — Ctrl+," side="bottom">
            <button
              onClick={openSettings}
              aria-label="Open settings"
              className="cursor-pointer rounded-lg p-2 text-content-faint transition-colors hover:bg-hover hover:text-content-secondary"
            >
              <RiSettings4Line className="text-[15px]" />
            </button>
          </Tooltip>

          <Tooltip label={accountName} side="bottom">
            <button
              onClick={openSettings}
              aria-label={`Account: ${accountName}`}
              className={cn(
                'ml-1.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full',
                'text-[11px] font-medium text-white ring-1 ring-inset ring-white/10',
                'transition-opacity duration-150 hover:opacity-85',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50',
                avatarClass(avatarColor)
              )}
            >
              {accountInitial}
            </button>
          </Tooltip>
        </div>
      </header>

      <div className="relative flex-1 overflow-hidden">
        {/* The scenery sits behind every view. Views draw their own opaque
            surfaces where they need to, so this reads as depth rather than
            noise. */}
        <AppBackground />

        {/* One stacking context above the background for all view content. */}
        <div className="absolute inset-0 z-10">
          <div className={`absolute inset-0 ${activeTab === 'DASHBOARD' ? 'block' : 'hidden'}`}>
            <DashboardView
              props={props}
              stats={stats}
              chatHistory={chatHistory}
              onVisionClick={handleVisionClick}
            />
          </div>

          <div className={`absolute inset-0 ${activeTab === 'PHONE' ? 'block' : 'hidden'}`}>
            <PhoneView />
          </div>

          <Suspense fallback={<ViewSkeleton />}>
            {activeTab === 'DESK' && <DeskView />}
            {activeTab === 'Macros' && <WorkFlowEditorView />}
            {activeTab === 'Apps' && <AppsView />}
            {activeTab === 'NOTES' && <NotesView glassPanel={glassPanel} />}
            {activeTab === 'GALLERY' && <GalleryView />}
            {activeTab === 'ROBOT' && <RobotView />}
            {activeTab === 'AGENTS' && <OrchestratorView />}
            {activeTab === 'STUDIO' && <StudioView />}
          </Suspense>
        </div>
      </div>

      {/* Mounted once at the shell level so Ctrl+, and the gear work from any
          view, and so the dialog survives a tab change. */}
      <SettingsModal isSystemActive={props.isSystemActive} />

      {showSourceModal && (
        <div className="absolute inset-0 z-100 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          {/* Neutral throughout. Picking an input source is a routine choice —
              it does not warrant the accent, and the old red-on-hover made
              both options look like destructive actions. */}
          <div className="flex w-96 flex-col overflow-hidden rounded-2xl border border-line bg-elevated shadow-xl animate-in fade-in zoom-in">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="text-[13px] font-medium text-content">Choose a source</span>
              <button
                onClick={() => setShowSourceModal(false)}
                aria-label="Cancel"
                className="brutus-close cursor-pointer rounded-lg p-1 text-content-faint"
              >
                <RiCloseLine size={17} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5 p-4">
              {[
                { mode: 'camera' as const, icon: <RiCameraLine size={22} />, label: 'Camera' },
                { mode: 'screen' as const, icon: <RiComputerLine size={22} />, label: 'Screen' }
              ].map((source) => (
                <button
                  key={source.mode}
                  onClick={() => {
                    props.startVision(source.mode)
                    setShowSourceModal(false)
                  }}
                  className={cn(
                    'group flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl',
                    'border border-line bg-surface-muted p-6 transition-colors duration-150',
                    'hover:border-line-strong hover:bg-hover',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40'
                  )}
                >
                  <span className="text-content-muted transition-colors group-hover:text-content">
                    {source.icon}
                  </span>
                  <span className="text-[12px] font-medium text-content-secondary transition-colors group-hover:text-content">
                    {source.label}
                  </span>
                </button>
              ))}
            </div>

            <p className="border-t border-line px-4 py-3 text-center text-[11px] text-content-faint">
              Brutus will see this feed while the session is live.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export default Brutus
