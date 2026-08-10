import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  RiCheckLine,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiEyeLine,
  RiEyeOffLine,
  RiLoader4Line,
  RiPlugLine,
  RiTimeLine
} from 'react-icons/ri'
import { Button, Card, Input, cn } from '@renderer/components/ui'
import {
  getProviders,
  saveKey,
  setProviderUrl,
  testProvider,
  type ProviderId,
  type ProviderSpec,
  type TestResult
} from '@renderer/services/release-client'

/**
 * Choose a brain, paste a key, prove it works.
 *
 * This is the step the whole first run exists for. Everything else in the wizard
 * is preference; without this, Brutus opens and does nothing, and the user has no
 * way to tell whether they are missing a key or looking at a broken app.
 *
 * ── WHY THE KEY IS TESTED BEFORE IT IS SAVED ───────────────────────────────
 * Saving first and testing later is how someone ends up with a stored key that
 * does not work and a UI that fails much later, somewhere unrelated. The key is
 * verified against the real provider first and only written on success — so a
 * saved key is, by construction, a working one.
 *
 * ── WHY FAILURE IS CLASSIFIED, NOT JUST REPORTED ───────────────────────────
 * "Test failed" tells the user nothing. A rejected key, a rate-limited key and
 * an unreachable network need three different actions, and main already
 * distinguishes them, so this surfaces that distinction instead of flattening it.
 *
 * ── WHY RATE-LIMITED COUNTS AS SUCCESS ─────────────────────────────────────
 * A 429 proves the key authenticated. Refusing to continue would strand a user
 * whose key is perfectly good behind a wall they cannot clear by waiting inside a
 * modal, so it saves and moves on with the caveat shown.
 */

export interface ProviderSetupProps {
  /** Called once at least one provider is verified and stored. */
  onReady: () => void
  /** Called when the user wants to look around without configuring anything. */
  onSkip?: () => void
  /** Compact framing for the Settings panel, which supplies its own heading. */
  embedded?: boolean
}

const TONE: Record<TestResult['verdict'], { icon: ReactElement; className: string; ok: boolean }> =
  {
    ok: {
      icon: <RiCheckLine size={14} />,
      className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
      ok: true
    },
    'rate-limited': {
      icon: <RiTimeLine size={14} />,
      className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      ok: true
    },
    'bad-key': {
      icon: <RiErrorWarningLine size={14} />,
      className: 'border-red-500/40 bg-red-500/10 text-red-300',
      ok: false
    },
    unreachable: {
      icon: <RiErrorWarningLine size={14} />,
      className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      ok: false
    },
    'no-key': {
      icon: <RiErrorWarningLine size={14} />,
      className: 'border-line bg-surface-muted text-content-muted',
      ok: false
    },
    error: {
      icon: <RiErrorWarningLine size={14} />,
      className: 'border-red-500/40 bg-red-500/10 text-red-300',
      ok: false
    }
  }

export default function ProviderSetup({
  onReady,
  onSkip,
  embedded
}: ProviderSetupProps): ReactElement {
  const [specs, setSpecs] = useState<ProviderSpec[]>([])
  const [encrypted, setEncrypted] = useState(true)
  const [chosen, setChosen] = useState<ProviderId>('gemini')
  const [key, setKey] = useState('')
  const [url, setUrl] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getProviders().then((res) => {
      if (cancelled) return
      setSpecs(res.providers)
      setEncrypted(res.encryptionAvailable)
      // Land on the recommended provider so the common path is zero clicks.
      const recommended = res.providers.find((p) => p.recommended)
      if (recommended) setChosen(recommended.id)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const spec = specs.find((s) => s.id === chosen)

  // A new provider means the previous verdict is meaningless.
  const pick = useCallback((id: ProviderId) => {
    setChosen(id)
    setResult(null)
    setSaved(false)
    setKey('')
    setUrl('')
  }, [])

  const canTest = spec ? (spec.needsKey ? key.trim().length > 0 : true) : false

  const test = useCallback(async () => {
    if (!spec || busy) return
    setBusy(true)
    setResult(null)
    try {
      const res = await testProvider(spec.id, {
        key: spec.needsKey ? key.trim() : undefined,
        baseUrl: spec.local ? url.trim() || undefined : undefined
      })
      setResult(res)

      // Only a verified provider is written. `rate-limited` counts: the key
      // authenticated, which is the thing being established here.
      if (TONE[res.verdict].ok) {
        if (spec.needsKey) await saveKey(spec.id, key.trim())
        if (spec.local && url.trim()) await setProviderUrl(spec.id, url.trim())
        setSaved(true)
      }
    } catch (err) {
      setResult({
        provider: spec.id,
        verdict: 'error',
        message: String((err as { message?: string })?.message ?? err)
      })
    } finally {
      setBusy(false)
    }
  }, [spec, busy, key, url])

  const tone = result ? TONE[result.verdict] : null

  return (
    <div className="flex flex-col gap-4" data-tour="setup.provider">
      {!embedded && (
        <p className="text-[13px] leading-relaxed text-content-muted">
          Brutus needs one AI provider to think with. Pick one, paste its key, and press{' '}
          <span className="text-content">Test connection</span> — nothing is saved until it works.
        </p>
      )}

      {/* ── Provider choice ── */}
      <div className="grid gap-1.5">
        {specs.map((p) => {
          const active = p.id === chosen
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => pick(p.id)}
              aria-pressed={active}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left',
                'transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                active
                  ? 'border-primary-500/50 bg-primary-500/10'
                  : 'border-line bg-surface-muted hover:border-line-strong'
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                  active ? 'border-primary-500 bg-primary-500' : 'border-line-strong'
                )}
              >
                {active && <RiCheckLine size={10} className="text-white" />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-content">{p.label}</span>
                  {p.recommended && (
                    <span className="rounded bg-primary-500/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-primary-500">
                      Recommended
                    </span>
                  )}
                  {p.local && (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-400">
                      Offline
                    </span>
                  )}
                  {/* Said out loud, because a provider that tests green and then
                      does nothing is worse than one that is not offered. */}
                  {!p.wired && (
                    <span className="rounded bg-white/[0.07] px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-content-faint">
                      Not routed yet
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-content-muted">
                  {p.blurb}
                </span>
                {!p.wired && p.note && (
                  <span className="mt-1 block text-[10.5px] leading-snug text-amber-300/70">
                    {p.note}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── The credential ── */}
      {spec && (
        <Card tone="surface" className="flex flex-col gap-2.5 p-3.5">
          {spec.needsKey ? (
            <>
              <div className="flex items-center justify-between">
                <label htmlFor="setup-key" className="text-[12px] font-medium text-content">
                  {spec.label} API key
                </label>
                {spec.keyUrl && (
                  <a
                    href={spec.keyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[11px] text-primary-500 hover:underline"
                  >
                    Get a key <RiExternalLinkLine size={11} />
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="setup-key"
                  type={reveal ? 'text' : 'password'}
                  value={key}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={spec.keyHint ?? 'Paste your key'}
                  onChange={(e) => {
                    setKey(e.target.value)
                    setResult(null)
                    setSaved(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canTest) void test()
                  }}
                  className="flex-1"
                />
                <Button
                  variant="tertiary"
                  size="sm"
                  onClick={() => setReveal((v) => !v)}
                  aria-label={reveal ? 'Hide key' : 'Show key'}
                >
                  {reveal ? <RiEyeOffLine size={14} /> : <RiEyeLine size={14} />}
                </Button>
              </div>
              <p className="text-[10.5px] leading-snug text-content-faint">
                {encrypted
                  ? 'Stored encrypted on this machine only, tied to your Windows account. It never leaves your computer except to reach the provider.'
                  : 'This system has no secure keyring available, so the key will be stored obfuscated rather than encrypted. Anyone with access to your user profile could read it.'}
              </p>
            </>
          ) : (
            <>
              <label htmlFor="setup-url" className="text-[12px] font-medium text-content">
                {spec.label} address
              </label>
              <Input
                id="setup-url"
                value={url}
                spellCheck={false}
                placeholder={
                  spec.id === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:8080'
                }
                onChange={(e) => {
                  setUrl(e.target.value)
                  setResult(null)
                  setSaved(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void test()
                }}
              />
              <p className="text-[10.5px] leading-snug text-content-faint">
                Leave blank to use the default. Nothing is sent outside your own network.
              </p>
            </>
          )}
        </Card>
      )}

      {/* ── The verdict ── */}
      {result && tone && (
        <div
          role="status"
          className={cn(
            'flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[12px]',
            tone.className
          )}
        >
          <span className="mt-px shrink-0">{tone.icon}</span>
          <span className="min-w-0">
            <span className="block leading-snug">{result.message}</span>
            {(result.detail || typeof result.ms === 'number') && (
              <span className="mt-0.5 block text-[10.5px] opacity-70">
                {[result.detail, typeof result.ms === 'number' ? `${result.ms} ms` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            {saved && (
              <span className="mt-1 block text-[10.5px] font-medium opacity-90">
                Saved. You can add more providers later in Settings.
              </span>
            )}
          </span>
        </div>
      )}

      {/* ── Actions ── */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!canTest || busy}
          onClick={() => void test()}
          leadingIcon={
            busy ? <RiLoader4Line size={14} className="animate-spin" /> : <RiPlugLine size={14} />
          }
        >
          {busy ? 'Testing…' : 'Test connection'}
        </Button>

        {saved && (
          <Button
            size="sm"
            variant="primary"
            onClick={onReady}
            trailingIcon={<RiCheckLine size={14} />}
          >
            Continue
          </Button>
        )}

        {/* Item 17: the interface is explorable with nothing configured, so a
            user can see what they are setting up before committing a key. */}
        {onSkip && !saved && (
          <Button variant="tertiary" size="sm" onClick={onSkip}>
            Skip — explore in demo mode
          </Button>
        )}
      </div>
    </div>
  )
}
