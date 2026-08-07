import { useState, useEffect, useRef, useCallback } from 'react'
import { RiShieldFlashLine, RiCheckLine } from 'react-icons/ri'
import AppBackground from '@renderer/components/AppBackground'
import { cn } from '@renderer/components/ui'

interface LockScreenProps {
  onUnlock: () => void
}

type Phase = 'loading' | 'entry' | 'error' | 'granted'

const PIN_LENGTH = 4

/**
 * The lock screen.
 *
 * ── WHAT THIS REPLACED, AND WHY ────────────────────────────────────────────
 * The previous version was a sci-fi console: a fake telemetry bar reading
 * "KERNEL ACTIVE / ENCLAVE SECURE", three counter-rotating dashed rings, a
 * scan line sweeping a glowing shield, a shimmer running along a progress bar,
 * and eight red glows layered on top of each other. All of it in motion, all of
 * it at once.
 *
 * The worst part was not the noise, it was the **3.3 seconds of theatre**. The
 * PIN verified instantly and then a "DECRYPTING VAULT" bar counted up in random
 * increments before letting you in. Nothing was decrypting. It was a delay
 * pretending to be work, on the one screen a user crosses every single launch.
 *
 * This version does the same job with one animation: the dots fill as you type,
 * and a check mark confirms before it hands off (~550ms, enough to register the
 * state change, not enough to wait for). Red appears exactly twice — the brand
 * mark, and a wrong code. Everything else is white on black.
 */
export default function LockScreen({ onUnlock }: LockScreenProps): React.JSX.Element {
  const [pin, setPin] = useState('')
  const [needsSetup, setNeedsSetup] = useState(false)
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState('')
  const [time, setTime] = useState(new Date())

  const inputRef = useRef<HTMLInputElement>(null)
  // Every timer this component starts, so unmounting mid-transition cannot fire
  // a setState on a component that is gone.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const later = useCallback((fn: () => void, ms: number): void => {
    timers.current.push(setTimeout(fn, ms))
  }, [])

  useEffect(() => {
    const clock = setInterval(() => setTime(new Date()), 1000)
    const started = timers.current
    return () => {
      clearInterval(clock)
      started.forEach(clearTimeout)
    }
  }, [])

  useEffect(() => {
    const focus = (): void => {
      setPhase('entry')
      setTimeout(() => inputRef.current?.focus(), 60)
    }
    if (!window.electron?.ipcRenderer) {
      focus()
      return
    }
    window.electron.ipcRenderer
      .invoke('check-vault-status')
      .then((status: { hasPin: boolean }) => {
        setNeedsSetup(!status?.hasPin)
        focus()
      })
      .catch(focus)
  }, [])

  const grant = (): void => {
    setPhase('granted')
    setMessage('')
    // Long enough to read as a confirmation, short enough that nobody waits.
    later(onUnlock, 550)
  }

  const reject = (text: string): void => {
    setPhase('error')
    setMessage(text)
    later(() => {
      setPin('')
      setPhase('entry')
      setMessage('')
      inputRef.current?.focus()
    }, 900)
  }

  const submit = async (code: string): Promise<void> => {
    if (!window.electron?.ipcRenderer) return
    try {
      if (needsSetup) {
        await window.electron.ipcRenderer.invoke('setup-vault-pin', code)
        grant()
        return
      }
      const valid = await window.electron.ipcRenderer.invoke('verify-vault-pin', code)
      if (valid) grant()
      else reject('Incorrect code')
    } catch {
      reject('Vault unavailable — try again')
    }
  }

  const onChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    if (phase === 'error' || phase === 'granted') return
    const next = event.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH)
    setPin(next)
    if (next.length === PIN_LENGTH) void submit(next)
  }

  if (phase === 'loading') return <div className="h-screen w-screen bg-canvas" />

  return (
    <div
      className="relative flex h-screen w-screen select-none flex-col items-center justify-center overflow-hidden bg-canvas font-sans"
      onClick={() => phase !== 'granted' && inputRef.current?.focus()}
    >
      <AppBackground />

      <span className="absolute right-6 top-5 z-10 font-mono text-[11px] tabular-nums text-content-faint">
        {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>

      <div className="relative z-10 flex w-full max-w-xs flex-col items-center">
        {/* Brand mark — one of only two places red appears on this screen. */}
        <span
          className={cn(
            'flex h-11 w-11 items-center justify-center rounded-2xl border transition-colors duration-300',
            phase === 'granted'
              ? 'border-primary-500/40 bg-primary-500/10 text-primary-500'
              : 'border-line bg-surface text-primary-500'
          )}
        >
          {phase === 'granted' ? <RiCheckLine size={22} /> : <RiShieldFlashLine size={20} />}
        </span>

        <h1 className="mt-5 text-[17px] font-medium tracking-tight text-content">
          {phase === 'granted' ? 'Unlocked' : needsSetup ? 'Set a passcode' : 'Brutus is locked'}
        </h1>
        <p className="mt-1.5 h-4 text-[12px] text-content-muted">
          {phase === 'error' ? (
            <span className="text-coral-400">{message}</span>
          ) : phase === 'granted' ? (
            'Welcome back'
          ) : needsSetup ? (
            'Choose a 4-digit code to secure your vault'
          ) : (
            'Enter your 4-digit code'
          )}
        </p>

        {/* The dots. One animation on this screen, and this is it. */}
        <div className={cn('mt-8 flex gap-3.5', phase === 'error' && 'brutus-shake')}>
          {Array.from({ length: PIN_LENGTH }).map((_, index) => {
            const filled = pin.length > index
            const next = pin.length === index && phase === 'entry'
            return (
              <span
                key={index}
                className={cn(
                  'h-3 w-3 rounded-full border transition-all duration-200',
                  filled
                    ? phase === 'error'
                      ? 'scale-100 border-coral-500 bg-coral-500'
                      : 'scale-100 border-content bg-content'
                    : next
                      ? 'border-content-muted bg-transparent'
                      : 'border-line-strong bg-transparent'
                )}
              />
            )
          })}
        </div>

        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          pattern="\d*"
          value={pin}
          onChange={onChange}
          maxLength={PIN_LENGTH}
          autoComplete="off"
          aria-label={needsSetup ? 'New passcode' : 'Passcode'}
          disabled={phase === 'granted'}
          // Visually hidden but still focusable and still the real input, so
          // the OS keyboard, paste and Backspace all behave normally.
          className="absolute h-px w-px opacity-0"
        />
      </div>

      <p className="absolute bottom-6 z-10 text-[10px] text-content-faint">
        Everything stays on this machine
      </p>
    </div>
  )
}
