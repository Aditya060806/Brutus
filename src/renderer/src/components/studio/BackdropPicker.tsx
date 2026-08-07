import { useState, type ReactElement } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { RiPaletteLine, RiCheckLine } from 'react-icons/ri'
import { BACKDROPS } from './backdrops'

/**
 * Choose the canvas scenery.
 *
 * Small on purpose: it sits in the corner cluster next to the zoom controls and
 * only opens when asked. The swatches are the real gradients rather than flat
 * colours, so what you pick is what you get.
 */
export default function BackdropPicker({
  value,
  onPick
}: {
  value: string
  onPick: (id: string) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const reduceMotion = useReducedMotion()

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Canvas backdrop"
        className={`cursor-pointer rounded-lg border p-1.5 backdrop-blur-xl transition-colors ${
          open
            ? 'border-red-500/40 bg-red-500/10 text-red-400'
            : 'border-white/10 bg-zinc-950/80 text-zinc-500 hover:text-zinc-200'
        }`}
      >
        <RiPaletteLine size={12} />
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* Click-away, kept behind the panel so the panel stays clickable. */}
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: 8, scale: 0.96 }}
              transition={
                reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 320, damping: 28 }
              }
              className="studio-glass absolute bottom-full right-0 z-20 mb-2 w-44 rounded-2xl p-2"
            >
              <p className="px-1.5 pb-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                Backdrop
              </p>
              <div className="flex flex-col gap-0.5">
                {BACKDROPS.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => {
                      onPick(b.id)
                      setOpen(false)
                    }}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors ${
                      value === b.id ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'
                    }`}
                  >
                    <span
                      className="h-5 w-5 shrink-0 rounded-md border border-white/15"
                      style={{ background: b.swatch }}
                    />
                    <span className="flex-1 text-[11px] text-zinc-300">{b.label}</span>
                    {value === b.id && <RiCheckLine size={12} className="text-red-400" />}
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}
