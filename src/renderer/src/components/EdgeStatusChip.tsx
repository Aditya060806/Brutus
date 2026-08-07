import { useEffect, useState } from 'react'
import { brutusService } from '../services/Brutus-voice-ai'
import type { BrutusAIState } from '../services/Brutus-voice-ai'

/**
 * A small on-screen status pill for the edge (server) voice engine. It polls
 * the voice service and reflects the turn state — listening, thinking, or
 * speaking — so the on-device ASR→LLM→TTS loop is easy to follow and tune.
 * Renders nothing unless a server-engine voice session is active.
 */

const STATE_META: Record<BrutusAIState, { label: string; color: string }> = {
  listening: { label: 'LISTENING', color: '#34d399' },
  thinking: { label: 'THINKING', color: '#fbbf24' },
  speaking: { label: 'SPEAKING', color: '#38bdf8' },
  idle: { label: 'STANDBY', color: '#a1a1aa' }
}

export default function EdgeStatusChip({ active }: { active: boolean }) {
  const [state, setState] = useState<BrutusAIState>(brutusService.state)
  const [engine, setEngine] = useState(brutusService.engine)

  useEffect(() => {
    const id = setInterval(() => {
      setState(brutusService.state)
      setEngine(brutusService.engine)
    }, 150)
    return () => clearInterval(id)
  }, [])

  if (!active || engine !== 'server') return null

  const meta = STATE_META[state] || STATE_META.idle

  return (
    <div
      className="fixed bottom-6 left-6 z-[9065] flex items-center gap-2 px-3.5 py-2 rounded-full bg-black/60 border backdrop-blur-md text-[10px] font-mono tracking-widest uppercase select-none shadow-lg"
      style={{ borderColor: `${meta.color}55` }}
      title="On-device voice engine (Brain Node)"
    >
      <span
        className="h-2 w-2 rounded-full animate-pulse"
        style={{ backgroundColor: meta.color, boxShadow: `0 0 8px ${meta.color}` }}
      />
      <span style={{ color: meta.color }}>{meta.label}</span>
      <span className="text-zinc-500">· EDGE</span>
    </div>
  )
}
