import { useEffect, useState, type ReactElement } from 'react'
import { motion } from 'framer-motion'
import { RiShieldCheckLine, RiCheckLine, RiCloseLine, RiTimeLine } from 'react-icons/ri'
import type { StudioApproval } from '@renderer/services/studio-client'

/**
 * The permission prompt, raised onto the canvas.
 *
 * The agent is genuinely blocked while this is open — Brutus is holding the
 * hook response (or withholding the keystroke) until you answer. The countdown
 * is honest about that: at zero, Brutus steps aside and the agent's own prompt
 * takes over in its terminal, so the decision is never silently made for you.
 */
export default function ApprovalCard({
  approval,
  onAnswer,
  timeoutMs = 25_000
}: {
  approval: StudioApproval
  onAnswer: (granted: boolean) => void
  timeoutMs?: number
}): ReactElement {
  const [left, setLeft] = useState(Math.ceil(timeoutMs / 1000))

  useEffect(() => {
    const started = Date.now()
    const id = setInterval(() => {
      setLeft(Math.max(0, Math.ceil((timeoutMs - (Date.now() - started)) / 1000)))
    }, 250)
    return () => clearInterval(id)
  }, [timeoutMs, approval.id])

  const reason = String((approval.detail?.reason as string) ?? '')
  const cwd = String((approval.detail?.cwd as string) ?? '')
  const urgent = left <= 8

  return (
    <motion.div
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -12, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 300, damping: 28 }}
      className="w-[min(560px,calc(100vw-3rem))] rounded-2xl border border-amber-500/30 bg-zinc-950/95 p-4 shadow-[0_24px_70px_rgba(0,0,0,0.7)] backdrop-blur-2xl"
    >
      <div className="flex items-start gap-3">
        <RiShieldCheckLine className="mt-0.5 shrink-0 text-amber-400" size={17} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-400/90">
              Approval needed
            </span>
            <span
              className={`flex items-center gap-1 text-[10px] font-mono tabular-nums ${
                urgent ? 'text-red-400' : 'text-zinc-600'
              }`}
            >
              <RiTimeLine size={10} /> {left}s
            </span>
          </div>

          <p className="mt-1.5 break-words text-[13px] leading-snug text-zinc-100">
            {approval.summary}
          </p>

          {reason && <p className="mt-1 text-[11px] leading-snug text-amber-400/80">{reason}</p>}

          <p className="mt-1.5 truncate text-[10px] font-mono text-zinc-600" title={cwd}>
            {approval.toolName}
            {cwd ? ` · ${cwd}` : ''}
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-1.5">
          <button
            onClick={() => onAnswer(true)}
            className="flex cursor-pointer items-center gap-1 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-[10px] font-bold tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/25"
          >
            <RiCheckLine size={12} /> ALLOW
          </button>
          <button
            onClick={() => onAnswer(false)}
            className="flex cursor-pointer items-center gap-1 rounded-lg bg-white/5 px-3 py-1.5 text-[10px] font-bold tracking-wider text-zinc-400 transition-colors hover:bg-white/10"
          >
            <RiCloseLine size={12} /> DENY
          </button>
        </div>
      </div>

      {/* Countdown bar — pure CSS transform, no layout thrash. */}
      <div className="mt-3 h-[2px] w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={`h-full origin-left rounded-full transition-transform duration-250 ease-linear ${
            urgent ? 'bg-red-500' : 'bg-amber-400'
          }`}
          style={{ transform: `scaleX(${left / Math.ceil(timeoutMs / 1000)})` }}
        />
      </div>
    </motion.div>
  )
}
