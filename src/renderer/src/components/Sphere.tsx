import { useState, useEffect, useRef, useCallback } from 'react'
import BrutusEyes from './BrutusEyes/BrutusEyes'
import { emotionBus } from './BrutusEyes/emotionBus'
import { brutusService } from '@renderer/services/Brutus-voice-ai'

const STATE_LABELS: Record<string, string> = {
  idle: 'IDLE',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  speaking: 'SPEAKING'
}

const STATE_COLORS: Record<string, string> = {
  idle:      'rgba(100,100,120,0.6)',
  listening: 'rgba(80,200,255,0.8)',
  thinking:  'rgba(160,100,255,0.8)',
  speaking:  'rgba(255,80,80,0.9)'
}

const EMOTION_GLOWS: Record<string, string> = {
  neutral:   '80,80,120',
  happy:     '255,120,40',
  angry:     '220,30,30',
  sad:       '60,80,200',
  surprised: '255,220,0',
  sleepy:    '40,80,140',
  love:      '255,60,120'
}

const Sphere = () => {
  const [locked, setLocked] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [password, setPassword] = useState('')
  const [shakeInput, setShakeInput] = useState(false)
  const [aiState, setAiState] = useState<string>('idle')
  const [emotion, setEmotion] = useState<string>('neutral')
  const inputRef = useRef<HTMLInputElement>(null)

  // Poll lockdown + AI state
  useEffect(() => {
    const interval = setInterval(() => {
      setLocked(emotionBus.lockdownActive)
      setAiState(brutusService.state ?? 'idle')
      setEmotion(brutusService.emotion ?? 'neutral')
    }, 120)
    return () => clearInterval(interval)
  }, [])

  // Auto-focus input when prompt shows
  useEffect(() => {
    if (showPrompt && inputRef.current) {
      inputRef.current.focus()
    }
  }, [showPrompt])

  // Show prompt 5s after lock
  useEffect(() => {
    if (locked) {
      const timer = setTimeout(() => setShowPrompt(true), 5000)
      return () => clearTimeout(timer)
    }
    setShowPrompt(false)
    setPassword('')
    return undefined
  }, [locked])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    if (password.toLowerCase().trim() === 'tuffy') {
      emotionBus.lockdownActive = false
      setLocked(false)
      setShowPrompt(false)
      setPassword('')
    } else {
      setShakeInput(true)
      setPassword('')
      setTimeout(() => setShakeInput(false), 600)
    }
  }, [password])

  if (locked) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          background: 'black',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'none',
          userSelect: 'none'
        }}
      >
        <div style={{ width: '100vw', height: '80vh' }}>
          <BrutusEyes />
        </div>

        {showPrompt && (
          <form
            onSubmit={handleSubmit}
            style={{
              position: 'absolute',
              bottom: '12vh',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12
            }}
          >
            <span
              style={{
                color: '#aa2222',
                fontSize: 14,
                fontFamily: 'monospace',
                letterSpacing: 2,
                opacity: 0.7
              }}
            >
              Say the word.
            </span>
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                background: 'transparent',
                border: 'none',
                borderBottom: '1px solid #aa2222',
                color: '#ff3333',
                fontSize: 18,
                fontFamily: 'monospace',
                textAlign: 'center',
                outline: 'none',
                padding: '6px 16px',
                width: 200,
                letterSpacing: 4,
                animation: shakeInput ? 'lockShake 0.4s ease' : 'none'
              }}
              autoComplete="off"
            />
            <style>{`
              @keyframes lockShake {
                0%, 100% { transform: translateX(0); }
                20% { transform: translateX(-10px); }
                40% { transform: translateX(10px); }
                60% { transform: translateX(-6px); }
                80% { transform: translateX(6px); }
              }
            `}</style>
          </form>
        )}
      </div>
    )
  }

  const glowRgb = EMOTION_GLOWS[emotion] ?? EMOTION_GLOWS.neutral
  const isActive = aiState !== 'idle'
  const pulseAnim = isActive ? 'spherePulse 2.4s ease-in-out infinite' : 'spherePulseIdle 6s ease-in-out infinite'

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

      {/* Backdrop pulse */}
      <div style={{
        position: 'absolute', inset: '-12%',
        background: `radial-gradient(ellipse at center, rgba(${glowRgb},${isActive ? 0.07 : 0.03}) 0%, transparent 70%)`,
        animation: pulseAnim,
        pointerEvents: 'none', zIndex: 0
      }} />

      {/* HUD corner brackets */}
      {(['tl','tr','bl','br'] as const).map(corner => {
        const isTop = corner.startsWith('t'), isLeft = corner.endsWith('l')
        return (
          <div key={corner} style={{
            position: 'absolute',
            top:    isTop  ? '2%' : undefined,
            bottom: !isTop ? '10%' : undefined,
            left:   isLeft  ? '4%' : undefined,
            right:  !isLeft ? '4%' : undefined,
            width: 16, height: 16,
            borderTop:    isTop  ? `1.5px solid rgba(${glowRgb},0.5)` : undefined,
            borderBottom: !isTop ? `1.5px solid rgba(${glowRgb},0.5)` : undefined,
            borderLeft:   isLeft  ? `1.5px solid rgba(${glowRgb},0.5)` : undefined,
            borderRight:  !isLeft ? `1.5px solid rgba(${glowRgb},0.5)` : undefined,
            transition: 'border-color 1.2s ease',
            pointerEvents: 'none', zIndex: 10
          }} />
        )
      })}

      {/* Outer rim glow ring */}
      <div style={{
        position: 'absolute', inset: '1%',
        borderRadius: '50%',
        boxShadow: `0 0 ${isActive ? 28 : 12}px rgba(${glowRgb},${isActive ? 0.25 : 0.1}), inset 0 0 ${isActive ? 18 : 6}px rgba(${glowRgb},${isActive ? 0.08 : 0.03})`,
        transition: 'box-shadow 1.5s ease',
        pointerEvents: 'none', zIndex: 0
      }} />

      {/* Eyes canvas */}
      <div style={{ width: '100%', flex: 1, position: 'relative', zIndex: 1 }}>
        <BrutusEyes />
      </div>

      {/* Status bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '4px 14px',
        borderRadius: 20,
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(8px)',
        border: `1px solid rgba(${glowRgb},0.2)`,
        boxShadow: `0 0 12px rgba(${glowRgb},0.1)`,
        transition: 'all 1.2s ease',
        marginTop: 4,
        position: 'relative', zIndex: 10,
        userSelect: 'none'
      }}>
        {/* State dot */}
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: STATE_COLORS[aiState] ?? STATE_COLORS.idle,
          boxShadow: `0 0 8px ${STATE_COLORS[aiState] ?? STATE_COLORS.idle}`,
          animation: aiState === 'speaking' ? 'stateDotPulse 0.6s ease-in-out infinite alternate' : 'none'
        }} />
        <span style={{
          fontFamily: 'monospace', fontSize: 10,
          letterSpacing: '0.18em', color: STATE_COLORS[aiState] ?? STATE_COLORS.idle,
          textTransform: 'uppercase', opacity: 0.85
        }}>
          {STATE_LABELS[aiState] ?? 'IDLE'}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.15)', fontSize: 10 }}>/</span>
        <span style={{
          fontFamily: 'monospace', fontSize: 10,
          letterSpacing: '0.12em', color: `rgba(${glowRgb},0.75)`,
          textTransform: 'uppercase'
        }}>
          {emotion}
        </span>
      </div>

      <style>{`
        @keyframes spherePulse {
          0%,100% { opacity: 0.7; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.04); }
        }
        @keyframes spherePulseIdle {
          0%,100% { opacity: 0.4; }
          50% { opacity: 0.65; }
        }
        @keyframes stateDotPulse {
          from { opacity: 0.6; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  )
}

export default Sphere
