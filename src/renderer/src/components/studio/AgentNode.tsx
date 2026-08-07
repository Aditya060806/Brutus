import { memo, useState, type ReactElement } from 'react'
import { Handle, NodeResizer, Position, type NodeProps } from 'reactflow'
import { motion, useReducedMotion } from 'framer-motion'
import {
  RiFolder3Line,
  RiRefreshLine,
  RiEraserLine,
  RiFlashlightLine,
  RiExpandDiagonalLine,
  RiPlayFill,
  RiPauseCircleLine,
  RiAlertLine
} from 'react-icons/ri'
import AgentTerminal from './AgentTerminal'
import StudioErrorBoundary from './StudioErrorBoundary'
import { useIsLive } from './live-context'
import { studio, type SessionStatus } from '@renderer/services/studio-client'
import type { AgentInfo } from '@renderer/services/studio-client'

/**
 * One agent window on the canvas.
 *
 * Two states, matching the reference: a **setup card** (choose run mode and
 * working directory) before launch, and a **live terminal** after. The setup
 * step exists because launching a coding agent in the wrong folder, or with
 * the wrong permissions, is the single most expensive mistake this UI could
 * let you make — so it is an explicit choice, not a default.
 */

/**
 * Status is shown three ways at once — a dot, a coloured word, and the window's
 * own glow — because on a canvas of ten windows you read the colour from across
 * the screen and only then look for the word.
 */
const STATUS: Record<SessionStatus, { dot: string; label: string; text: string; ring: string }> = {
  starting: {
    dot: 'bg-amber-400',
    label: 'Starting',
    text: 'text-amber-400',
    ring: 'bg-amber-400/10'
  },
  idle: {
    dot: 'bg-emerald-500',
    label: 'Ready',
    text: 'text-emerald-400',
    ring: 'bg-emerald-500/10'
  },
  busy: { dot: 'bg-red-500', label: 'Working', text: 'text-red-400', ring: 'bg-red-500/12' },
  'awaiting-approval': {
    dot: 'bg-amber-400',
    label: 'Needs you',
    text: 'text-amber-300',
    ring: 'bg-amber-400/15'
  },
  exited: { dot: 'bg-zinc-600', label: 'Stopped', text: 'text-zinc-500', ring: 'bg-white/[0.04]' },
  failed: { dot: 'bg-red-600', label: 'Failed', text: 'text-red-400', ring: 'bg-red-600/12' }
}

/** Just the folder name — the full path is the tooltip. */
const folderName = (path: string): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() ?? path

export interface AgentNodeData {
  title: string
  agentKind: string
  agentLabel: string
  accent: string
  info?: AgentInfo
  sessionId?: string
  status?: SessionStatus
  exitCode?: number
  cwd: string
  runMode: string
  autoReply: boolean
  hookManaged?: boolean
  focusKey?: number
  error?: string
  onLaunch: (opts: { runMode: string; cwd: string }) => void
  onClose: () => void
  onCollapse: () => void
  onMaximize: () => void
  onRestart: () => void
  onPickFolder: () => void
  onToggleAutoReply: () => void
  collapsed?: boolean
}

/** The connection dots. Dim until you go near them, then they light up. */
function Dot({ position, id }: { position: Position; id: string }): ReactElement {
  return (
    <Handle
      type={position === Position.Left || position === Position.Top ? 'target' : 'source'}
      position={position}
      id={id}
      className="!h-2.5 !w-2.5 !rounded-full !border !border-white/20 !bg-zinc-700 transition-all duration-200 hover:!h-3.5 hover:!w-3.5 hover:!bg-red-500 hover:!border-red-300 hover:!shadow-[0_0_12px_rgba(var(--brutus-accent-c),0.8)]"
    />
  )
}

function AgentNode({ id, data, selected }: NodeProps<AgentNodeData>): ReactElement {
  const [runMode, setRunMode] = useState(data.runMode)
  const status = data.status ?? 'starting'
  const s = STATUS[status] ?? STATUS.starting
  const live = Boolean(data.sessionId) && status !== 'exited' && status !== 'failed'
  const inViewport = useIsLive(id)
  const reduceMotion = useReducedMotion()

  /**
   * The window's mood, driven by what the agent is doing.
   *
   * A canvas of ten windows is unreadable if they all look identical, so the
   * one that is working glows and the one waiting on you glows differently.
   * You can find the agent that needs attention without reading a word.
   */
  const glow =
    status === 'busy'
      ? 'bg-red-500/22'
      : status === 'awaiting-approval'
        ? 'bg-amber-400/28'
        : status === 'failed'
          ? 'bg-red-700/20'
          : null

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, scale: 0.94, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 26 }}
      className="relative h-full w-full"
    >
      {/* Soft bloom behind the window. Sits outside the clipped shell so it can
          bleed past the rounded corners the way a real light source would. */}
      {glow && (
        <div
          aria-hidden
          className={`studio-busy-glow pointer-events-none absolute -inset-3 rounded-3xl blur-2xl ${glow}`}
        />
      )}

      {/* Resizable, because how much terminal an agent needs depends on what it
          is running — a build log wants height, a diff wants width. Only shown
          on the selected window so an idle canvas stays clean. The terminal's own
          ResizeObserver refits the TUI and pushes the new cols/rows to the pty,
          so the CLI reflows properly rather than just being clipped. */}
      {!data.collapsed && (
        <NodeResizer
          isVisible={selected}
          minWidth={320}
          minHeight={200}
          lineClassName="line"
          handleClassName="handle"
        />
      )}

      <div
        className={`relative flex h-full w-full flex-col overflow-hidden rounded-xl border bg-zinc-950/92 backdrop-blur-2xl transition-colors ${
          selected
            ? 'border-red-500/60 shadow-[0_0_0_1px_rgba(var(--brutus-accent-c),0.25),0_22px_60px_rgba(0,0,0,0.6)]'
            : 'border-white/[0.09] shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_22px_60px_rgba(0,0,0,0.6)]'
        }`}
      >
        <Dot position={Position.Left} id="in-left" />
        <Dot position={Position.Top} id="in-top" />
        <Dot position={Position.Right} id="out-right" />
        <Dot position={Position.Bottom} id="out-bottom" />

        {/* ── Title bar (also the drag handle) ──
            Rebuilt to stop three separate things competing for one strip. The
            name leads, the agent is a quiet chip beside it, and the controls
            only appear when the pointer is over the window — a canvas of ten
            of these was pure chrome otherwise. */}
        <div className="studio-drag group/bar flex shrink-0 cursor-grab items-center gap-2 border-b border-white/[0.06] bg-gradient-to-b from-white/[0.05] to-white/[0.015] px-3 py-2 active:cursor-grabbing">
          <div className="flex items-center gap-[5px]">
            <button
              onClick={data.onClose}
              title="Close"
              className="h-[11px] w-[11px] cursor-pointer rounded-full bg-[#ff5f57] transition-transform hover:scale-125"
            />
            <button
              onClick={data.onCollapse}
              title={data.collapsed ? 'Expand' : 'Collapse'}
              className="h-[11px] w-[11px] cursor-pointer rounded-full bg-[#febc2e] transition-transform hover:scale-125"
            />
            <button
              onClick={data.onMaximize}
              title="Maximise"
              className="h-[11px] w-[11px] cursor-pointer rounded-full bg-[#28c840] transition-transform hover:scale-125"
            />
          </div>

          {/* The live dot gets a halo while the agent is actually working, so a
              busy window is findable without reading anything. */}
          <span className="relative ml-1.5 flex h-2 w-2 shrink-0 items-center justify-center">
            {status === 'busy' && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/70" />
            )}
            <span className={`relative h-1.5 w-1.5 rounded-full ${s.dot}`} />
          </span>

          <span className="truncate text-[11.5px] font-semibold tracking-tight text-zinc-100">
            {data.title}
          </span>
          <span
            className={`shrink-0 rounded-md bg-white/[0.06] px-1.5 py-[1px] text-[9px] font-medium ${data.accent}`}
          >
            {data.agentLabel}
          </span>

          <span className="ml-auto flex items-center gap-1.5">
            {data.hookManaged && (
              <span
                title="Brutus manages a permission hook in this folder"
                className="rounded bg-red-500/12 px-1.5 py-0.5 text-[8px] font-bold tracking-wider text-red-400"
              >
                HOOKED
              </span>
            )}
            <button
              onClick={data.onMaximize}
              title="Focus this window"
              className="cursor-pointer rounded p-0.5 text-zinc-600 opacity-0 transition-all hover:text-zinc-200 group-hover/bar:opacity-100"
            >
              <RiExpandDiagonalLine size={12} />
            </button>
          </span>
        </div>

        {!data.collapsed && (
          <>
            {/* ── Body ──
                Wrapped per node: a terminal or setup card that throws renders an
                inline card here instead of taking the whole canvas with it. */}
            <div className="min-h-0 flex-1 bg-canvas">
              <StudioErrorBoundary label={data.title} compact onReset={data.onRestart}>
                {live && data.sessionId ? (
                  inViewport ? (
                    <div className="studio-term">
                      <AgentTerminal sessionId={data.sessionId} focusKey={data.focusKey} />
                    </div>
                  ) : (
                    /* Off-screen: the process is still running and still buffering
                   in main. Scrolling back replays it — nothing is lost. */
                    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5">
                      <RiPauseCircleLine size={18} className="text-zinc-700" />
                      <p className="text-[10px] text-zinc-600">Running off-screen</p>
                    </div>
                  )
                ) : (
                  <SetupCard
                    data={data}
                    runMode={runMode}
                    setRunMode={setRunMode}
                    status={status}
                    exitCode={data.exitCode}
                  />
                )}
              </StudioErrorBoundary>
            </div>

            {/* ── Footer toolbar ──
                The status now reads in colour rather than as grey uppercase,
                and the working directory is here because "which repo is this
                agent in" is the question a canvas of agents raises constantly
                and previously could only be answered by stopping one. */}
            <div className="flex shrink-0 items-center gap-1.5 border-t border-white/[0.06] bg-black/25 px-2 py-1.5">
              <span
                className={`flex items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[9px] font-semibold uppercase tracking-[0.08em] ${s.ring} ${s.text}`}
              >
                {s.label}
              </span>

              <button
                onClick={data.onToggleAutoReply}
                title={
                  data.autoReply
                    ? 'Connected agents may feed this one. Click to stop that.'
                    : 'This agent ignores its incoming strings. Click to allow them.'
                }
                className={`flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-[3px] text-[9px] font-semibold tracking-wide transition-colors ${
                  data.autoReply
                    ? 'bg-red-500/12 text-red-400 hover:bg-red-500/20'
                    : 'text-zinc-600 hover:bg-white/5 hover:text-zinc-300'
                }`}
              >
                <RiFlashlightLine size={9} /> Auto
              </button>

              {data.cwd && (
                <span
                  title={data.cwd}
                  className="flex min-w-0 items-center gap-1 text-[9px] text-zinc-600"
                >
                  <RiFolder3Line size={9} className="shrink-0" />
                  <span className="truncate">{folderName(data.cwd)}</span>
                </span>
              )}

              <span className="ml-auto flex shrink-0 items-center gap-0.5">
                {[
                  {
                    icon: <RiEraserLine size={11} />,
                    title: 'Clear the screen',
                    fn: () => data.sessionId && studio.write(data.sessionId, '\f')
                  },
                  {
                    icon: <RiRefreshLine size={11} />,
                    title: 'Restart this agent',
                    fn: data.onRestart
                  }
                ].map((b) => (
                  <button
                    key={b.title}
                    onClick={b.fn}
                    title={b.title}
                    className="cursor-pointer rounded p-1 text-zinc-600 transition-colors hover:bg-white/[0.07] hover:text-zinc-200"
                  >
                    {b.icon}
                  </button>
                ))}
              </span>
            </div>
          </>
        )}
      </div>
    </motion.div>
  )
}

/** Pre-launch: choose how much power the agent gets and where it runs. */
function SetupCard({
  data,
  runMode,
  setRunMode,
  status,
  exitCode
}: {
  data: AgentNodeData
  runMode: string
  setRunMode: (v: string) => void
  status: SessionStatus
  exitCode?: number
}): ReactElement {
  const modes = data.info?.runModes ?? []
  const chosen = modes.find((m) => m.id === runMode)
  const stopped = status === 'exited' || status === 'failed'

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4 scrollbar-small">
      <div>
        <h3 className="text-[13px] font-semibold text-zinc-100">
          {stopped ? `${data.agentLabel} stopped` : `Start ${data.agentLabel}`}
        </h3>
        <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">
          {stopped
            ? `Exited with code ${exitCode ?? 0}. Reconnect to start a fresh session.`
            : 'Choose a run mode and working directory.'}
        </p>
      </div>

      {data.error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] p-2.5">
          <RiAlertLine className="mt-0.5 shrink-0 text-red-400" size={12} />
          <p className="text-[10px] leading-snug text-red-300">{data.error}</p>
        </div>
      )}

      {modes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Run mode
          </label>
          <select
            value={runMode}
            onChange={(e) => setRunMode(e.target.value)}
            className={`w-full cursor-pointer rounded-lg border bg-black/50 px-2.5 py-2 text-[11px] outline-none transition-colors focus:border-red-500/40 ${
              chosen?.danger
                ? 'border-red-500/40 text-red-300'
                : 'border-white/[0.08] text-zinc-200'
            }`}
          >
            {modes.map((m) => (
              <option key={m.id} value={m.id} className="bg-zinc-950">
                {m.label}
                {m.danger ? '  (unsafe)' : ''}
              </option>
            ))}
          </select>
          {chosen && (
            <p
              className={`text-[10px] leading-snug ${chosen.danger ? 'text-red-400/90' : 'text-zinc-600'}`}
            >
              {chosen.blurb}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Working directory
        </label>
        <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-black/50 px-2.5 py-2">
          <RiFolder3Line className="shrink-0 text-zinc-500" size={13} />
          <span className="truncate text-[11px] text-zinc-300" title={data.cwd}>
            {data.cwd}
          </span>
        </div>
        <button
          onClick={data.onPickFolder}
          className="cursor-pointer self-start text-[10px] text-zinc-500 underline decoration-zinc-700 underline-offset-2 transition-colors hover:text-zinc-300"
        >
          Browse another folder
        </button>
      </div>

      <button
        onClick={() => data.onLaunch({ runMode, cwd: data.cwd })}
        className="mt-auto flex cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-red-500/15 py-2 text-[11px] font-semibold text-red-400 transition-colors hover:bg-red-500/25"
      >
        <RiPlayFill size={13} /> {stopped ? 'Reconnect' : `Start ${data.agentLabel}`}
      </button>
    </div>
  )
}

export default memo(AgentNode)
