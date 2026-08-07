import { memo, useState, type ReactElement } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { NodeProps } from 'reactflow'

export interface NoteNodeData {
  text: string
  onChange: (text: string) => void
  onClose: () => void
}

/**
 * A sticky note on the canvas.
 *
 * The one thing on the dock that is not an agent. It exists because a canvas of
 * autonomous processes needs somewhere to write down what you are actually
 * trying to do — the plan, the acceptance criteria, the thing you will forget
 * while watching three terminals.
 *
 * Deliberately plain: no markdown, no toolbar. It is a note.
 */
function NoteNode({ data, selected }: NodeProps<NoteNodeData>): ReactElement {
  const [text, setText] = useState(data.text ?? '')
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, scale: 0.94, rotate: -1 }}
      animate={{ opacity: 1, scale: 1, rotate: 0 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 24 }}
      className={`flex h-full w-full flex-col overflow-hidden rounded-lg border shadow-[0_16px_40px_rgba(0,0,0,0.45)] ${
        selected ? 'border-amber-300/60' : 'border-amber-400/25'
      }`}
      style={{
        background: 'linear-gradient(160deg, rgba(251,191,36,0.16), rgba(180,120,10,0.10))'
      }}
    >
      <div className="studio-drag flex shrink-0 cursor-grab items-center gap-2 border-b border-amber-300/15 bg-amber-300/[0.06] px-2.5 py-1.5 active:cursor-grabbing">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300/80" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-200/80">
          Note
        </span>
        <button
          onClick={data.onClose}
          title="Remove"
          className="ml-auto cursor-pointer text-amber-200/50 transition-colors hover:text-amber-100"
        >
          ✕
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          data.onChange(e.target.value)
        }}
        placeholder="What are we actually trying to do here?"
        className="min-h-0 flex-1 resize-none bg-transparent p-3 text-[12px] leading-relaxed text-amber-50/90 outline-none placeholder:text-amber-200/30"
      />
    </motion.div>
  )
}

export default memo(NoteNode)
