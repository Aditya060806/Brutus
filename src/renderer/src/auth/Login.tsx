import { useMemo, useState } from 'react'
import { FcGoogle } from 'react-icons/fc'
import { RiShieldFlashLine, RiErrorWarningLine, RiComputerLine } from 'react-icons/ri'
import AppBackground from '@renderer/components/AppBackground'
import { Button } from '@renderer/components/ui'
import { useAuthStore } from '@renderer/store/auth-store'

const normalizeBackendUrl = (url?: string): string => (url || '').trim().replace(/\/+$/, '')

const MISSING_BACKEND =
  'No backend URL is configured. Set VITE_BACKEND_KEY in your renderer environment.'

/**
 * Sign-in.
 *
 * ── WHAT THIS REPLACED ─────────────────────────────────────────────────────
 * A three-column console: a "SYSTEM LOG" panel typing out nine fake boot lines
 * ("Neural interface drivers OK", "Mounting encrypted vault…") on a 550ms
 * timer, a TELEMETRY panel of invented statuses, a scan line sweeping the logo,
 * two pulsing 500px blur blobs, and a sign-in button that stayed **disabled for
 * 4.95 seconds** until the fake boot sequence finished.
 *
 * That last part is why it is gone. The app was ready immediately; the button
 * was held hostage by an animation. On the first screen a new user ever sees,
 * five seconds of theatre before they can do the one thing the screen exists
 * for is not atmosphere — it is a bug wearing a costume.
 *
 * Now: a mark, a sentence, a button, enabled from the first frame.
 */
export default function LoginPage(): React.JSX.Element {
  const backendBaseUrl = useMemo(
    () => normalizeBackendUrl(import.meta.env.VITE_BACKEND_KEY || import.meta.env.VITE_BACKEND_URL),
    []
  )
  const [error, setError] = useState('')
  const setLocalOnly = useAuthStore((s) => s.setLocalOnly)

  const signIn = (): void => {
    if (!backendBaseUrl) {
      setError(MISSING_BACKEND)
      return
    }
    setError('')
    window.open(backendBaseUrl + '/api/v1/auth/google', '_blank')
  }

  /**
   * Use Brutus without an account.
   *
   * Not a fallback for when sign-in fails — a first-class choice. The account
   * supplies a display name and an avatar; it does not gate a single feature.
   * API keys, Studio workspaces, records, notes and every tool are local, so
   * requiring a round-trip to a web service before the app opens was buying
   * nothing and costing everything the moment that service was unreachable.
   */
  const continueLocal = (): void => {
    setLocalOnly(true)
  }

  return (
    <div className="relative flex h-screen w-screen select-none items-center justify-center overflow-hidden bg-canvas px-6 font-sans">
      <AppBackground />

      <div className="relative z-10 flex w-full max-w-[340px] flex-col items-center text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-surface text-primary-500">
          <RiShieldFlashLine size={22} />
        </span>

        <h1 className="mt-6 text-[22px] font-semibold tracking-tight text-content">Brutus</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-content-muted">
          Sign in to sync your name and avatar. Everything else stays on this machine either way.
        </p>

        {/* Only offered when a backend is actually configured. A build with no
            backend URL would otherwise show a button that cannot work. */}
        {backendBaseUrl && (
          <>
            <Button size="lg" variant="secondary" className="mt-8 w-full" onClick={signIn}>
              <FcGoogle className="h-[18px] w-[18px]" />
              Continue with Google
            </Button>
            <p className="mt-3.5 text-[11px] leading-relaxed text-content-faint">
              Your browser will open to complete sign-in.
            </p>
          </>
        )}

        <Button
          size="lg"
          variant={backendBaseUrl ? 'tertiary' : 'secondary'}
          className={backendBaseUrl ? 'mt-4 w-full' : 'mt-8 w-full'}
          onClick={continueLocal}
        >
          <RiComputerLine className="h-[17px] w-[17px]" />
          Use Brutus without an account
        </Button>

        <p className="mt-3.5 text-[11px] leading-relaxed text-content-faint">
          No account needed. Every feature works offline once you add an API key.
        </p>

        {error && (
          <div
            role="alert"
            className="mt-6 flex w-full items-start gap-2 rounded-lg border border-coral-500/30 bg-coral-500/10 px-3 py-2.5 text-left text-[11px] leading-relaxed text-coral-400"
          >
            <RiErrorWarningLine size={14} className="mt-px shrink-0" />
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
