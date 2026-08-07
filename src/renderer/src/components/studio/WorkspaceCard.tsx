import { useMemo, useState, type ReactElement } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { RiMoreLine, RiFolder3Line, RiDeleteBin6Line, RiFileCopyLine } from 'react-icons/ri'
import { backdropById } from './backdrops'
import type { WorkspaceSummary } from '@renderer/services/studio-client'

const KIND_DOT: Record<string, string> = {
  claude: 'bg-orange-400',
  codex: 'bg-emerald-400',
  gemini: 'bg-sky-400',
  shell: 'bg-zinc-400'
}

function ago(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d === 1 ? '1d ago' : `${d}d ago`
}

/**
 * A deterministic little sketch of the workspace's graph.
 *
 * Screenshotting the canvas would mean keeping a live capture pipeline and
 * writing image files, and a workspace that was never opened would have no
 * thumbnail at all. Drawing the shape from the node count instead is free,
 * always available, and still tells you which workspace you are looking at.
 * The layout is seeded from the id, so a given workspace always draws the same.
 */
function Preview({ ws }: { ws: WorkspaceSummary }): ReactElement {
  const scene = backdropById(ws.backdrop)

  const dots = useMemo(() => {
    // A plain loop rather than a closure over a mutable seed: the React
    // compiler rejects a captured variable being reassigned, and it is right to
    // — a generator hidden in a closure is exactly the kind of thing that would
    // produce different output on a re-render.
    let seed = 0
    for (let i = 0; i < ws.id.length; i++) seed = (seed * 31 + ws.id.charCodeAt(i)) >>> 0

    const out: { x: number; y: number; w: number }[] = []
    for (let i = 0; i < Math.min(ws.nodeCount, 6); i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const x = 18 + (seed / 0xffffffff) * 64
      seed = (seed * 1664525 + 1013904223) >>> 0
      const y = 22 + (seed / 0xffffffff) * 56
      seed = (seed * 1664525 + 1013904223) >>> 0
      const w = 14 + (seed / 0xffffffff) * 10
      out.push({ x, y, w })
    }
    return out
  }, [ws.id, ws.nodeCount])

  return (
    <div
      className="relative h-28 w-full overflow-hidden rounded-t-xl"
      style={{ background: scene.base }}
    >
      <div className="absolute inset-0" style={{ background: scene.bloom, opacity: 0.85 }} />
      <div className="studio-grain absolute inset-0" />

      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="none"
      >
        {dots.slice(1).map((d, i) => (
          <line
            key={`e${i}`}
            x1={dots[i].x + dots[i].w / 2}
            y1={dots[i].y + 4}
            x2={d.x + d.w / 2}
            y2={d.y + 4}
            stroke="rgba(var(--brutus-accent-c),0.45)"
            strokeWidth="0.6"
          />
        ))}
        {dots.map((d, i) => (
          <rect
            key={`n${i}`}
            x={d.x}
            y={d.y}
            width={d.w}
            height="8"
            rx="2"
            fill="rgba(255,255,255,0.13)"
            stroke="rgba(255,255,255,0.22)"
            strokeWidth="0.5"
          />
        ))}
      </svg>

      {ws.nodeCount === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[10px] text-white/35">Empty canvas</span>
        </div>
      )}
    </div>
  )
}

export default function WorkspaceCard({
  ws,
  onOpen,
  onDelete,
  onExport
}: {
  ws: WorkspaceSummary
  onOpen: () => void
  onDelete: () => void
  onExport: () => void
}): ReactElement {
  const [menu, setMenu] = useState(false)
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 28 }}
      className="group relative"
    >
      <button
        onClick={onOpen}
        className="w-full cursor-pointer overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02] text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.05] hover:shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
      >
        <Preview ws={ws} />

        <div className="p-3">
          <p className="truncate text-[12.5px] font-semibold text-zinc-100">{ws.name}</p>
          <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-zinc-500">
            <span>Workspace</span>
            <span className="text-zinc-700">·</span>
            <span>{ago(ws.updatedAt)}</span>
            {ws.nodeCount > 0 && (
              <>
                <span className="text-zinc-700">·</span>
                <span>
                  {ws.nodeCount} agent{ws.nodeCount === 1 ? '' : 's'}
                </span>
              </>
            )}
          </div>

          <div className="mt-2 flex items-center gap-2">
            <div className="flex items-center gap-1">
              {ws.kinds.slice(0, 4).map((k) => (
                <span
                  key={k}
                  title={k}
                  className={`h-1.5 w-1.5 rounded-full ${KIND_DOT[k] ?? 'bg-zinc-500'}`}
                />
              ))}
            </div>
            {ws.rootDir && (
              <span
                className="flex min-w-0 items-center gap-1 text-[10px] text-zinc-600"
                title={ws.rootDir}
              >
                <RiFolder3Line size={10} className="shrink-0" />
                <span className="truncate">{ws.rootDir.split(/[/\\]/).pop()}</span>
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Card menu. Hidden until hover so a wall of cards stays calm. */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          setMenu((v) => !v)
        }}
        className={`absolute right-2 top-2 cursor-pointer rounded-lg border border-white/10 bg-black/50 p-1 text-zinc-300 backdrop-blur-md transition-opacity hover:bg-black/70 ${
          menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <RiMoreLine size={13} />
      </button>

      {menu && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
          <div className="studio-glass absolute right-2 top-10 z-20 w-40 rounded-xl p-1">
            <button
              onClick={() => {
                onExport()
                setMenu(false)
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-white/5"
            >
              <RiFileCopyLine size={12} /> Copy share link
            </button>
            <button
              onClick={() => {
                onDelete()
                setMenu(false)
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-400"
            >
              <RiDeleteBin6Line size={12} /> Delete workspace
            </button>
          </div>
        </>
      )}
    </motion.div>
  )
}
