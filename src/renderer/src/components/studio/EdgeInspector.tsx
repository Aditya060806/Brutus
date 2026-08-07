import { motion, useReducedMotion } from 'framer-motion'
import { RiDeleteBin6Line, RiCloseLine } from 'react-icons/ri'
import type { ReactElement } from 'react'
import type { EdgeKind } from '@renderer/services/studio-client'

/**
 * What a string actually does.
 *
 * Dragging a connection can only ever produce a handoff, so without this there
 * is no way to build a review loop with the mouse — the whole `loop` edge kind
 * would be reachable only through the command bar. This is that missing half.
 */
const KINDS: { id: EdgeKind; label: string; blurb: string; colour: string }[] = [
  {
    id: 'handoff',
    label: 'Handoff',
    blurb: 'Pass the finished work forward.',
    colour: 'text-red-400 border-red-500/40 bg-red-500/10'
  },
  {
    id: 'branch',
    label: 'Branch',
    blurb: 'Send the same result to several agents.',
    colour: 'text-sky-400 border-sky-500/40 bg-sky-500/10'
  },
  {
    id: 'loop',
    label: 'Loop',
    blurb: 'Send it back for revision, up to a limit.',
    colour: 'text-amber-400 border-amber-500/40 bg-amber-500/10'
  }
]

export interface EdgeInspectorValue {
  kind: EdgeKind
  label: string
  maxIterations: number
}

export default function EdgeInspector({
  value,
  fromTitle,
  toTitle,
  onChange,
  onDelete,
  onClose
}: {
  value: EdgeInspectorValue
  fromTitle: string
  toTitle: string
  onChange: (patch: Partial<EdgeInspectorValue>) => void
  onDelete: () => void
  onClose: () => void
}): ReactElement {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, x: 12 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 28 }}
      className="w-64 rounded-2xl border border-white/10 bg-zinc-950/92 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.65)] backdrop-blur-2xl"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Connection
          </p>
          <p className="mt-0.5 truncate text-[11px] text-zinc-300">
            {fromTitle} → {toTitle}
          </p>
        </div>
        <button
          onClick={onClose}
          className="cursor-pointer rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
        >
          <RiCloseLine size={13} />
        </button>
      </div>

      <div className="mt-2.5 flex flex-col gap-1">
        {KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => onChange({ kind: k.id })}
            className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
              value.kind === k.id
                ? k.colour
                : 'border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:bg-white/[0.05]'
            }`}
          >
            <span className="block text-[11px] font-semibold">{k.label}</span>
            <span className="block text-[9px] leading-snug opacity-70">{k.blurb}</span>
          </button>
        ))}
      </div>

      <label className="mt-2.5 block">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
          Label on the curve
        </span>
        <input
          value={value.label}
          onChange={(e) => onChange({ label: e.target.value.slice(0, 60) })}
          placeholder="revise until green"
          className="mt-1 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-red-500/40"
        />
      </label>

      {value.kind === 'loop' && (
        <label className="mt-2 block">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
            Stop after
          </span>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={10}
              value={value.maxIterations}
              onChange={(e) => onChange({ maxIterations: Number(e.target.value) })}
              className="flex-1 accent-amber-400"
            />
            <span className="w-14 text-right text-[10px] font-mono tabular-nums text-amber-400">
              {value.maxIterations} pass{value.maxIterations === 1 ? '' : 'es'}
            </span>
          </div>
          <p className="mt-1 text-[9px] leading-snug text-zinc-600">
            Counted per prompt, so asking again starts a fresh set of passes.
          </p>
        </label>
      )}

      <button
        onClick={onDelete}
        className="mt-3 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-white/[0.03] py-1.5 text-[10px] font-semibold text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-400"
      >
        <RiDeleteBin6Line size={11} /> Remove connection
      </button>
    </motion.div>
  )
}
