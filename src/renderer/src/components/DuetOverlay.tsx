import { useEffect, useRef, useState } from 'react'
import { RiCloseLine, RiVoiceprintLine } from 'react-icons/ri'
import { duetController, type DuetUiEvent } from '@renderer/services/duet-controller'

interface Line {
  id: number
  speaker: 'host' | 'mobile'
  name: string
  text: string
}

/**
 * Live visual for Duet Mode — shows the two Brutus selves bantering, PC-Brutus
 * on the left, Robo-Brutus on the right, with the newest line highlighted.
 * Only visible while a duet is running.
 */
const DuetOverlay = (): React.JSX.Element | null => {
  const [active, setActive] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const counter = useRef(0)

  useEffect(() => {
    const off = duetController.subscribe((e: DuetUiEvent) => {
      if (e.kind === 'start') {
        setActive(true)
        setLines([])
      } else if (e.kind === 'turn' && e.text && e.speaker) {
        counter.current += 1
        setLines((prev) =>
          [...prev, { id: counter.current, speaker: e.speaker!, name: e.name || '', text: e.text! }].slice(-6)
        )
      } else if (e.kind === 'stop') {
        // Let the final line linger, then fade out.
        setTimeout(() => setActive(false), 2600)
      }
    })
    return off
  }, [])

  if (!active) return null

  return (
    <div className="fixed inset-x-0 bottom-24 z-[9080] flex flex-col items-center pointer-events-none px-4">
      <div className="pointer-events-auto w-full max-w-2xl bg-black/80 backdrop-blur-xl border border-red-500/30 rounded-2xl shadow-[0_10px_60px_rgba(var(--brutus-accent-c),0.25)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 bg-white/5">
          <span className="flex items-center gap-2 text-[11px] font-bold tracking-widest text-red-300 uppercase">
            <RiVoiceprintLine className="animate-pulse" /> Duet · two minds, one Brutus
          </span>
          <button
            onClick={() => duetController.stop()}
            className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white transition-colors"
            title="Stop the duet"
          >
            <RiCloseLine size={16} /> STOP
          </button>
        </div>

        <div className="p-4 flex flex-col gap-2.5 max-h-[42vh] overflow-y-auto">
          {lines.map((l, i) => {
            const isHost = l.speaker === 'host'
            const isLast = i === lines.length - 1
            return (
              <div
                key={l.id}
                className={`flex ${isHost ? 'justify-start' : 'justify-end'}`}
                style={{ animation: 'duetIn 0.35s ease-out' }}
              >
                <div className={`max-w-[78%] ${isHost ? 'items-start' : 'items-end'} flex flex-col`}>
                  <span
                    className={`text-[10px] font-bold tracking-widest uppercase mb-1 ${
                      isHost ? 'text-cyan-400' : 'text-red-400'
                    }`}
                  >
                    {l.name}
                  </span>
                  <div
                    className={`px-3.5 py-2 rounded-2xl text-[13px] leading-snug border transition-all ${
                      isHost
                        ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-50 rounded-tl-sm'
                        : 'bg-red-500/10 border-red-500/30 text-red-50 rounded-tr-sm'
                    } ${isLast ? 'ring-1 ring-white/20 scale-[1.02]' : 'opacity-80'}`}
                  >
                    {l.text}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <style>{`@keyframes duetIn{from{opacity:0;transform:translateY(8px) scale(0.98)}to{opacity:1;transform:none}}`}</style>
    </div>
  )
}

export default DuetOverlay
