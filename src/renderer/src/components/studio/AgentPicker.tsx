import { useEffect, useRef, useState, type ReactElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { RiTerminalBoxLine, RiSearchLine, RiCheckLine, RiCloseLine } from 'react-icons/ri'
import type { AgentInfo } from '@renderer/services/studio-client'

/**
 * The launcher popover.
 *
 * Agents that are not installed are shown greyed rather than hidden, with the
 * install command. Hiding them would leave the user wondering why Codex is
 * missing; showing them tells them exactly what to run.
 */
/**
 * Mounted only while open (the parent conditionally renders it), so the search
 * query resets naturally instead of needing an effect to clear it.
 */
export default function AgentPicker({
  agents,
  onPick,
  onClose,
  anchor = 'bottom'
}: {
  agents: AgentInfo[]
  onPick: (kind: string) => void
  onClose: () => void
  anchor?: 'bottom' | 'center'
}): ReactElement | null {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const q = query.trim().toLowerCase()
  const match = (a: AgentInfo): boolean =>
    !q || a.label.toLowerCase().includes(q) || a.kind.includes(q)

  const coding = agents.filter((a) => a.kind !== 'shell' && match(a))
  const tools = agents.filter((a) => a.kind === 'shell' && match(a))

  return (
    <AnimatePresence>
      <>
        {/* Click-away layer */}
        <div className="fixed inset-0 z-40" onClick={onClose} />
        <motion.div
          initial={{ opacity: 0, y: anchor === 'bottom' ? 12 : 0, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 300, damping: 28 }}
          className={`absolute z-50 w-[380px] rounded-2xl border border-white/10 bg-zinc-950/95 p-3 shadow-[0_24px_70px_rgba(0,0,0,0.7)] backdrop-blur-2xl ${
            anchor === 'bottom'
              ? 'bottom-[92px] left-1/2 -translate-x-1/2'
              : 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
          }`}
        >
          <div className="mb-2.5 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-black/50 px-2.5 py-1.5">
            <RiSearchLine size={12} className="text-zinc-600" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents"
              className="flex-1 bg-transparent text-[11px] text-zinc-200 outline-none placeholder:text-zinc-700"
            />
            <button onClick={onClose} className="cursor-pointer text-zinc-600 hover:text-zinc-300">
              <RiCloseLine size={12} />
            </button>
          </div>

          <Section title="Coding agents" items={coding} onPick={onPick} />
          {tools.length > 0 && <Section title="Tools" items={tools} onPick={onPick} />}

          {!coding.length && !tools.length && (
            <p className="px-1 py-4 text-center text-[11px] text-zinc-600">No agents match.</p>
          )}
        </motion.div>
      </>
    </AnimatePresence>
  )
}

function Section({
  title,
  items,
  onPick
}: {
  title: string
  items: AgentInfo[]
  onPick: (kind: string) => void
}): ReactElement | null {
  if (!items.length) return null
  return (
    <div className="mb-1">
      <div className="px-1 pb-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-600">
        {title}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {items.map((a) => (
          <button
            key={a.kind}
            onClick={() => a.available && onPick(a.kind)}
            disabled={!a.available}
            title={a.available ? `Add ${a.label}` : `Not installed — ${a.install}`}
            className={`group flex flex-col items-center gap-1.5 rounded-xl border p-3 transition-all ${
              a.available
                ? 'cursor-pointer border-white/[0.06] bg-white/[0.02] hover:-translate-y-0.5 hover:border-red-500/30 hover:bg-white/[0.05]'
                : 'cursor-not-allowed border-white/[0.04] bg-transparent opacity-40'
            }`}
          >
            <RiTerminalBoxLine size={20} className={a.available ? a.accent : 'text-zinc-600'} />
            <span className="text-center text-[10px] font-medium leading-tight text-zinc-300">
              {a.label}
            </span>
            {a.available ? (
              <span className="flex items-center gap-0.5 text-[8px] text-emerald-500/80">
                <RiCheckLine size={8} /> ready
              </span>
            ) : (
              <span className="text-[8px] text-zinc-600">not installed</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
