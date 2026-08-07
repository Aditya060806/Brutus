import type { ReactElement } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { RiStickyNoteLine, RiTerminalBoxLine, RiRobot2Line, RiSparkling2Line } from 'react-icons/ri'
import type { DockItem } from '@renderer/services/studio-client'

/** Icon per dock entry. Agents by kind, tools by id. */
function iconFor(item: DockItem): ReactElement {
  if (item.node === 'note') return <RiStickyNoteLine size={17} />
  if (item.agentKind === 'shell') return <RiTerminalBoxLine size={17} />
  if (item.agentKind === 'gemini') return <RiSparkling2Line size={17} />
  return <RiRobot2Line size={17} />
}

/**
 * The launcher strip at the bottom of the canvas.
 *
 * Click an entry, get that thing on the canvas — one action, no popover in the
 * way. Which entries appear, and in what order, is set in Settings → Studio,
 * because a canvas of four agents and a canvas of one want very different docks.
 *
 * An agent whose binary is missing is shown but dimmed, with the install command
 * in its tooltip. Hiding it would leave you wondering where Codex went; showing
 * it greyed answers the question in place.
 */
export default function CanvasDock({
  items,
  onPick
}: {
  items: DockItem[]
  onPick: (item: DockItem) => void
}): ReactElement | null {
  const reduceMotion = useReducedMotion()
  if (!items.length) return null

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 30 }}
      className="studio-glass pointer-events-auto flex items-center gap-1 rounded-2xl px-2 py-2"
    >
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onPick(item)}
          disabled={!item.available}
          title={
            item.available
              ? `Add ${item.label}`
              : `${item.label} is not installed${item.install ? ` — ${item.install}` : ''}`
          }
          className={`group relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl transition-all duration-200 ${
            item.available
              ? `${item.accent} hover:-translate-y-1 hover:bg-white/[0.08]`
              : 'cursor-not-allowed text-zinc-700'
          }`}
        >
          {iconFor(item)}
          {/* Label on hover, in the dock idiom. */}
          <span className="pointer-events-none absolute -top-8 whitespace-nowrap rounded-md border border-white/10 bg-zinc-950/95 px-2 py-1 text-[10px] text-zinc-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
            {item.label}
          </span>
        </button>
      ))}
    </motion.div>
  )
}
