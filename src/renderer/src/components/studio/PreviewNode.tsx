import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { Handle, NodeResizer, Position, type NodeProps } from 'reactflow'
import { motion, useReducedMotion } from 'framer-motion'
import { studio } from '@renderer/services/studio-client'
import {
  RiExternalLinkLine,
  RiGlobalLine,
  RiLoader4Line,
  RiRefreshLine,
  RiSmartphoneLine,
  RiComputerLine
} from 'react-icons/ri'

/**
 * A live preview of what the agents are building.
 *
 * When an agent starts a dev server, main spots the URL in its output and the
 * canvas opens one of these beside it. The frontend and the terminal building
 * it are then on the same surface — which is the whole point of a canvas, and
 * was previously the one thing you had to leave Brutus to see.
 *
 * ── WHY AN IFRAME AND NOT A <webview> ──────────────────────────────────────
 * `webviewTag` is not enabled on the main window, and turning it on to render
 * a page the user's own dev server is already serving would be a large
 * privilege change for no gain. An iframe is the smaller tool that does the
 * job: same-machine content, no separate process, no new attack surface.
 *
 * Framing headers are stripped for loopback sub-frames only (see the
 * `onHeadersReceived` handler in main/index.ts), so a dev server that sets
 * `X-Frame-Options: DENY` still renders here instead of showing a blank box.
 */

export interface PreviewNodeData {
  url: string
  /**
   * A running dev server, or a static page an agent wrote.
   *
   * Shown in the header, because the two behave differently and the difference
   * matters: a server reloads itself when the agent edits, a file does not, and
   * "why is my change not showing?" has a different answer for each.
   */
  kind?: 'server' | 'file'
  /** The agent that produced it, for the header. */
  sourceTitle?: string
  /**
   * The agent node this preview belongs to.
   *
   * Carried in node data rather than derived from the edge, because the edge is
   * decoration the user may delete while the relationship still matters: it is
   * what stops a second detection from opening a duplicate window, and what
   * gets persisted so a reopened workspace re-links the two.
   */
  sourceNodeId?: string
  onClose: () => void
  onCollapse?: () => void
  collapsed?: boolean
}

/** Widths the preview can be pinned to, so responsive work is checkable here. */
const VIEWPORTS = [
  { id: 'fill', label: 'Fit', icon: RiComputerLine, width: null },
  { id: 'mobile', label: '375', icon: RiSmartphoneLine, width: 375 }
] as const

function PreviewNode({ data, selected }: NodeProps<PreviewNodeData>): ReactElement {
  const [url, setUrl] = useState(data.url)
  const [draft, setDraft] = useState(data.url)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [viewport, setViewport] = useState<(typeof VIEWPORTS)[number]['id']>('fill')
  /** Bumped to force the iframe to remount, which is the only reliable reload. */
  const [nonce, setNonce] = useState(0)
  /** Set when main reported a change, cleared once the flash has been seen. */
  const [autoReloaded, setAutoReloaded] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const reduceMotion = useReducedMotion()

  /**
   * Follow the detector if the server moves to a new port.
   *
   * Adjusted during render rather than in an effect. React's documented pattern
   * for reacting to a changed prop, and the reason it matters here: an effect
   * would render the frame once against the old URL before correcting itself,
   * which for an iframe means a real wasted page load against a port that has
   * usually stopped answering.
   */
  const [prevPropUrl, setPrevPropUrl] = useState(data.url)
  if (data.url !== prevPropUrl) {
    setPrevPropUrl(data.url)
    setUrl(data.url)
    setDraft(data.url)
    setNonce((n) => n + 1)
  }

  /**
   * A dev server is often announced a beat before it can actually serve.
   *
   * Vite prints its banner while still warming up, so the first load can land
   * on a connection refused. Rather than show a dead frame, retry a few times
   * with a widening gap — by which point the server is invariably up.
   */
  const attemptRef = useRef(0)

  // Reset the load state whenever the target changes, for the same reason and by
  // the same pattern as above.
  const target = `${url}|${nonce}`
  const [prevTarget, setPrevTarget] = useState(target)
  if (target !== prevTarget) {
    setPrevTarget(target)
    setLoading(true)
    setFailed(false)
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      // `onLoad` clears this; if it has not fired, the load is stuck or refused.
      setLoading((stillLoading) => {
        if (!stillLoading) return false
        if (attemptRef.current < 3) {
          attemptRef.current += 1
          setNonce((n) => n + 1)
          return true
        }
        setFailed(true)
        return false
      })
    }, 2500)
    return () => clearTimeout(timer)
  }, [url, nonce])

  const reload = useCallback(() => {
    attemptRef.current = 0
    setNonce((n) => n + 1)
  }, [])

  /**
   * Follow the file as the agent rewrites it.
   *
   * A dev server reloads itself; a static page cannot, so without this the
   * window froze on whatever the agent wrote first — and the second pass, which
   * is usually the good one, was invisible until you clicked reload. Main
   * watches the file and says when it changed; the url check means a canvas with
   * several previews only reloads the one that actually moved.
   */
  useEffect(() => {
    return studio.onPreviewChanged((changed) => {
      if (changed !== url) return
      setAutoReloaded(true)
      attemptRef.current = 0
      setNonce((n) => n + 1)
    })
  }, [url])

  const go = useCallback(() => {
    const next = draft.trim()
    if (!next) return
    attemptRef.current = 0
    setUrl(next.startsWith('http') ? next : `http://${next}`)
  }, [draft])

  const width = VIEWPORTS.find((v) => v.id === viewport)?.width ?? null

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, scale: 0.94, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 26 }}
      className="relative h-full w-full"
    >
      {/* Resizable for the same reason the agent windows are, and more so here:
          checking a layout at a given width is the whole point of a preview. */}
      {!data.collapsed && (
        <NodeResizer
          isVisible={selected}
          minWidth={300}
          minHeight={220}
          lineClassName="line"
          handleClassName="handle"
        />
      )}

      <div
        className={`relative flex h-full w-full flex-col overflow-hidden rounded-xl border bg-zinc-950/92 backdrop-blur-2xl transition-colors ${
          selected
            ? 'border-sky-500/60 shadow-[0_0_0_1px_rgba(56,189,248,0.25),0_22px_60px_rgba(0,0,0,0.6)]'
            : 'border-white/[0.09] shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_22px_60px_rgba(0,0,0,0.6)]'
        }`}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2.5 !w-2.5 !rounded-full !border !border-white/20 !bg-zinc-700"
        />

        {/* ── Title bar (drag handle) ── */}
        <div className="studio-drag flex shrink-0 cursor-grab items-center gap-2 border-b border-white/[0.06] bg-white/[0.03] px-3 py-2 active:cursor-grabbing">
          <div className="flex items-center gap-1.5">
            <button
              onClick={data.onClose}
              title="Close"
              className="h-3 w-3 cursor-pointer rounded-full bg-[#ff5f57] transition-transform hover:scale-110"
            />
            <button
              onClick={data.onCollapse}
              title={data.collapsed ? 'Expand' : 'Collapse'}
              className="h-3 w-3 cursor-pointer rounded-full bg-[#febc2e] transition-transform hover:scale-110"
            />
            <span className="h-3 w-3 rounded-full bg-white/10" />
          </div>

          <RiGlobalLine size={11} className="ml-1 shrink-0 text-sky-400" />
          <span className="truncate text-[11px] font-semibold text-zinc-100">Preview</span>
          <span
            title={
              data.kind === 'file'
                ? 'A static file on disk. Brutus watches it and reloads when the agent changes it.'
                : 'A dev server. It reloads itself as the agent edits.'
            }
            className="shrink-0 rounded bg-white/[0.06] px-1.5 py-[1px] font-mono text-[9px] text-zinc-400"
          >
            {data.kind === 'file' ? 'file' : 'live'}
          </span>

          {/* An auto-reload that happened silently reads as a glitch. Saying so
              for a moment is the difference between "it updated" and "why did
              it flicker". */}
          {autoReloaded && (
            <motion.span
              key={nonce}
              initial={reduceMotion ? false : { opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              onAnimationComplete={() => window.setTimeout(() => setAutoReloaded(false), 1400)}
              className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-[1px] text-[9px] font-semibold text-emerald-400"
            >
              updated
            </motion.span>
          )}
          {data.sourceTitle && (
            <span className="truncate text-[10px] text-zinc-600">from {data.sourceTitle}</span>
          )}

          <span className="ml-auto flex items-center gap-0.5">
            {VIEWPORTS.map((v) => (
              <button
                key={v.id}
                onClick={() => setViewport(v.id)}
                title={`${v.label} width`}
                className={`cursor-pointer rounded p-1 transition-colors ${
                  viewport === v.id
                    ? 'bg-white/10 text-zinc-200'
                    : 'text-zinc-600 hover:bg-white/5 hover:text-zinc-300'
                }`}
              >
                <v.icon size={11} />
              </button>
            ))}
          </span>
        </div>

        {!data.collapsed && (
          <>
            {/* ── Address bar ── */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.06] bg-black/30 px-2 py-1.5">
              <button
                onClick={reload}
                title="Reload"
                className="cursor-pointer rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
              >
                {loading ? (
                  <RiLoader4Line size={11} className="animate-spin" />
                ) : (
                  <RiRefreshLine size={11} />
                )}
              </button>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    go()
                  }
                }}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent font-mono text-[10px] text-zinc-300 outline-none placeholder:text-zinc-700"
              />
              <button
                onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                title="Open in a real browser"
                className="cursor-pointer rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
              >
                <RiExternalLinkLine size={11} />
              </button>
            </div>

            {/* ── The page ── */}
            <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
              {failed ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 bg-canvas px-6 text-center">
                  <RiGlobalLine size={20} className="text-zinc-700" />
                  <p className="break-all text-[11px] text-zinc-400">
                    {data.kind === 'file'
                      ? 'Could not open that file'
                      : `Nothing is answering on ${url}`}
                  </p>
                  <p className="text-[10px] leading-relaxed text-zinc-600">
                    {data.kind === 'file'
                      ? 'The agent may still be writing it, or it was moved.'
                      : 'The server may still be starting, or it stopped. Reload once it is up.'}
                  </p>
                  <button
                    onClick={reload}
                    className="mt-1 cursor-pointer rounded-lg bg-white/[0.06] px-2.5 py-1 text-[10px] font-semibold text-zinc-300 transition-colors hover:bg-white/10"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <div className="flex h-full w-full justify-center bg-zinc-900">
                  <iframe
                    key={nonce}
                    ref={frameRef}
                    src={url}
                    title="Preview"
                    onLoad={() => {
                      attemptRef.current = 0
                      setLoading(false)
                      setFailed(false)
                    }}
                    /**
                     * Sandboxed, even though this is the user's own machine.
                     * The page is being written by an autonomous agent, so it
                     * gets scripts and same-origin (or nothing would render)
                     * but never top-level navigation — a redirect in the
                     * preview must not be able to steer the Brutus window.
                     */
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                    className="h-full border-0 bg-white transition-[width] duration-200"
                    style={{ width: width ? `${width}px` : '100%' }}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </motion.div>
  )
}

export default memo(PreviewNode)
