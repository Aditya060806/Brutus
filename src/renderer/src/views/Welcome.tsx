import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RiArrowRightLine, RiCheckLine, RiShieldFlashLine } from 'react-icons/ri'
import { Button, Card, Input, cn } from '@renderer/components/ui'
import AppBackground from '@renderer/components/AppBackground'
import { useAuthStore } from '@renderer/store/auth-store'
import {
  AVATAR_COLORS,
  avatarClass,
  useProfileStore,
  type VoiceProfile
} from '@renderer/store/profile-store'
import { ACCENT_PRESETS } from '@renderer/services/theme'
import ProviderSetup from '@renderer/components/setup/ProviderSetup'
import { completeSetup } from '@renderer/services/release-client'

/**
 * The first-run customise flow.
 *
 * Shown once, after the first successful sign-in, between the lock screen and
 * the main shell. Three short steps — who you are, how it looks, how it sounds —
 * because a first run that asks fifteen questions gets skipped, and a first run
 * that asks nothing leaves the app feeling like it was set up for somebody else.
 *
 * ── EVERYTHING HERE IS ALREADY SAVED ───────────────────────────────────────
 * Each control writes through the profile store as you touch it, so the accent
 * repaints this very screen and there is no "apply" step that could fail. The
 * final button only marks the flow complete. That also means Skip is safe: it
 * keeps whatever you already changed rather than discarding it.
 *
 * Re-runnable from Settings → Account → Reset setup.
 */
/**
 * `Brain` is third rather than first on purpose.
 *
 * Asking for an API key as the very first thing a stranger sees reads like a
 * paywall. Two cheap, satisfying choices come first, so by the time the key is
 * requested the user has already invested a little and can see what they are
 * configuring — and it is still early enough that nothing has failed yet.
 */
const STEPS = ['You', 'Look', 'Brain', 'Voice'] as const

const Welcome = (): React.JSX.Element => {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  const cloudUser = useAuthStore((s) => s.user)
  const displayName = useProfileStore((s) => s.displayName)
  const setDisplayName = useProfileStore((s) => s.setDisplayName)
  const avatarColor = useProfileStore((s) => s.avatarColor)
  const setAvatarColor = useProfileStore((s) => s.setAvatarColor)
  const accentId = useProfileStore((s) => s.accentId)
  const setAccent = useProfileStore((s) => s.setAccent)
  const voiceProfile = useProfileStore((s) => s.voiceProfile)
  const setVoiceProfile = useProfileStore((s) => s.setVoiceProfile)
  const setOnboarded = useProfileStore((s) => s.setOnboarded)

  /**
   * The name field is derived until the user touches it.
   *
   * `/auth/me` resolves after mount, so the Google display name arrives late.
   * Syncing it in with an effect would mean a `setState` during render commit —
   * and, worse, could clobber a name the user had already started typing.
   * Instead `draft` stays null until they type, and the shown value falls back
   * to the best suggestion available at that moment.
   */
  const [draft, setDraft] = useState<string | null>(null)
  const hasChosenName = Boolean(displayName) && displayName !== 'Operator'
  const suggested = !hasChosenName && cloudUser?.name ? cloudUser.name : displayName
  const name = draft ?? suggested

  /** Set once a provider verifies, so the footer can stop nagging about it. */
  const [providerReady, setProviderReady] = useState(false)
  /** True when the user chose to look around without configuring anything. */
  const [demoMode, setDemoMode] = useState(false)

  const finish = (): void => {
    if (name.trim()) setDisplayName(name.trim())
    setOnboarded(true)
    // Tell main the wizard is genuinely done, so it is not offered again, and
    // record whether the user is in demo mode — which is what lets the rest of
    // the app explain why a cloud feature is unavailable rather than just fail.
    void completeSetup(demoMode && !providerReady)
    navigate('/', { replace: true })
  }

  const next = (): void => {
    if (step === 0 && name.trim()) setDisplayName(name.trim())
    if (step < STEPS.length - 1) setStep(step + 1)
    else finish()
  }

  const initial = (name.trim() || 'B').charAt(0).toUpperCase()

  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-canvas p-6 text-content">
      <AppBackground />

      <div className="relative z-10 w-full max-w-lg">
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-500/10 text-primary-500 ring-1 ring-inset ring-primary-500/25">
            <RiShieldFlashLine size={24} />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">
            {STEPS[step] === 'You' && 'Welcome to Brutus'}
            {STEPS[step] === 'Look' && 'Make it yours'}
            {STEPS[step] === 'Brain' && 'Connect a brain'}
            {STEPS[step] === 'Voice' && 'Give it a voice'}
          </h1>
          <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-content-muted">
            {STEPS[step] === 'You' &&
              'A few quick choices, then you are in. You can change all of it later in Settings.'}
            {STEPS[step] === 'Look' &&
              'Pick an accent. Everything in the app follows it — buttons, highlights, the canvas glow.'}
            {STEPS[step] === 'Brain' &&
              'One provider is all Brutus needs to start. This is the only step that matters.'}
            {STEPS[step] === 'Voice' &&
              'Choose the voice Brutus speaks with when the link is live.'}
          </p>
        </div>

        <Card tone="elevated" className="p-6">
          {STEPS[step] === 'You' && (
            <div className="flex flex-col gap-5">
              <div className="flex items-center gap-4">
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-14 w-14 shrink-0 items-center justify-center rounded-full',
                    'text-xl font-semibold text-white ring-1 ring-inset ring-white/15',
                    'transition-colors duration-200',
                    avatarClass(avatarColor)
                  )}
                >
                  {initial}
                </span>
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor="welcome-name"
                    className="mb-1.5 block text-[13px] font-medium text-content"
                  >
                    What should Brutus call you?
                  </label>
                  <Input
                    id="welcome-name"
                    value={name}
                    autoFocus
                    placeholder="Your name"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && name.trim()) next()
                    }}
                  />
                </div>
              </div>

              {cloudUser?.email && (
                <p className="text-xs text-content-faint">
                  Signed in as <span className="text-content-secondary">{cloudUser.email}</span>
                </p>
              )}
            </div>
          )}

          {STEPS[step] === 'Look' && (
            <div className="flex flex-col gap-5">
              <div>
                <p className="mb-2.5 text-[13px] font-medium text-content">Accent</p>
                <div className="flex flex-wrap gap-2">
                  {ACCENT_PRESETS.map((preset) => {
                    const active = preset.id === accentId
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setAccent(preset.id)}
                        aria-pressed={active}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2',
                          'text-[13px] transition-colors duration-150',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                          active
                            ? 'border-primary-500/50 bg-primary-500/10 text-content'
                            : 'border-line bg-surface-muted text-content-secondary hover:border-line-strong'
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className="flex h-4 w-4 items-center justify-center rounded-full ring-1 ring-inset ring-white/15"
                          style={{ backgroundColor: preset.swatch }}
                        >
                          {active && <RiCheckLine size={10} className="text-white" />}
                        </span>
                        {preset.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <p className="mb-2.5 text-[13px] font-medium text-content">Avatar tint</p>
                <div className="flex gap-2.5">
                  {AVATAR_COLORS.map((color) => (
                    <button
                      key={color.id}
                      type="button"
                      onClick={() => setAvatarColor(color.id)}
                      aria-label={`Avatar colour ${color.id}`}
                      aria-pressed={color.id === avatarColor}
                      className={cn(
                        'h-8 w-8 cursor-pointer rounded-full transition-transform duration-150',
                        'focus-visible:outline-none focus-visible:ring-2',
                        'focus-visible:ring-primary-500/40 focus-visible:ring-offset-2',
                        'focus-visible:ring-offset-elevated',
                        avatarClass(color.id),
                        color.id === avatarColor
                          ? 'ring-2 ring-white/60 ring-offset-2 ring-offset-elevated'
                          : 'hover:scale-110'
                      )}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {STEPS[step] === 'Brain' && (
            <ProviderSetup
              onReady={() => {
                setProviderReady(true)
                setDemoMode(false)
                setStep(step + 1)
              }}
              onSkip={() => {
                setDemoMode(true)
                setStep(step + 1)
              }}
            />
          )}

          {STEPS[step] === 'Voice' && (
            <div className="flex flex-col gap-3">
              {(
                [
                  { value: 'MALE', label: 'Puck', hint: 'Measured, lower register' },
                  { value: 'FEMALE', label: 'Aoede', hint: 'Brighter, quicker' }
                ] as { value: VoiceProfile; label: string; hint: string }[]
              ).map((option) => {
                const active = option.value === voiceProfile
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setVoiceProfile(option.value)}
                    aria-pressed={active}
                    className={cn(
                      'flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3',
                      'text-left transition-colors duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                      active
                        ? 'border-primary-500/50 bg-primary-500/10'
                        : 'border-line bg-surface-muted hover:border-line-strong'
                    )}
                  >
                    <span>
                      <span className="block text-[13px] font-medium text-content">
                        {option.label}
                      </span>
                      <span className="block text-xs text-content-muted">{option.hint}</span>
                    </span>
                    {active && <RiCheckLine size={16} className="text-primary-500" />}
                  </button>
                )
              })}
              <p className="mt-1 text-xs leading-relaxed text-content-faint">
                {providerReady
                  ? 'Your provider is connected, so the voice link is ready to use.'
                  : 'Live voice needs a connected provider. You can add one any time in Settings → API Keys.'}
              </p>
            </div>
          )}
        </Card>

        <div className="mt-5 flex items-center justify-between">
          {/* Skip keeps whatever has already been changed — every control on
              this screen saves as you touch it. */}
          <Button variant="tertiary" size="sm" onClick={finish}>
            Skip
          </Button>

          <div className="flex items-center gap-3">
            <div className="flex gap-1.5" aria-hidden="true">
              {STEPS.map((label, index) => (
                <span
                  key={label}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-300',
                    index === step ? 'w-5 bg-primary-500' : 'w-1.5 bg-line-strong'
                  )}
                />
              ))}
            </div>
            {/* The Brain step owns its own advance, because "Next" past an
                untested key would defeat the point of testing it. */}
            {STEPS[step] !== 'Brain' && (
              <Button
                size="sm"
                disabled={STEPS[step] === 'You' && !name.trim()}
                onClick={next}
                trailingIcon={<RiArrowRightLine size={14} />}
              >
                {step === STEPS.length - 1 ? 'Start' : 'Next'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Welcome
