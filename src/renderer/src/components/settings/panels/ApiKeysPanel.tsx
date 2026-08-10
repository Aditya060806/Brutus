import { useCallback, useState } from 'react'
import {
  RiCheckLine,
  RiDownload2Line,
  RiErrorWarningLine,
  RiEyeLine,
  RiEyeOffLine,
  RiPlugLine,
  RiSave3Line,
  RiTimeLine,
  RiUpload2Line
} from 'react-icons/ri'
import { Button, Input } from '@renderer/components/ui'
import { PREF_KEYS, readPref, writePref } from '@renderer/services/preferences'
import {
  exportConfig,
  importConfig,
  saveKey,
  testProvider,
  type ProviderId,
  type TestResult
} from '@renderer/services/release-client'
import { SettingsHeader, SettingsRow, SettingsSection, SettingsStatus } from '../controls'
import { useStatus } from '../useStatus'

interface KeyField {
  id: string
  label: string
  description: string
  placeholder: string
  storageKey: (typeof PREF_KEYS)[keyof typeof PREF_KEYS]
  /**
   * Set when this credential can be verified against a live endpoint.
   *
   * Absent for Hugging Face and Tavily: neither exposes a free authenticated
   * endpoint that proves a key without doing billable work, so offering a Test
   * button there would either cost the user money or lie.
   */
  provider?: ProviderId
}

const FIELDS: KeyField[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Powers the voice link, chat, and most document tools.',
    placeholder: 'AIzaSy…',
    storageKey: PREF_KEYS.geminiKey,
    provider: 'gemini'
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Fast inference for search summarisation and agent reframing.',
    placeholder: 'gsk_…',
    storageKey: PREF_KEYS.groqKey,
    provider: 'groq'
  },
  {
    id: 'hf',
    label: 'Hugging Face',
    description: 'Image generation and wallpaper synthesis.',
    placeholder: 'hf_…',
    storageKey: PREF_KEYS.hfKey
  },
  {
    id: 'tavily',
    label: 'Tavily',
    description: 'Web search for deep research and the RAG oracle.',
    placeholder: 'tvly_…',
    storageKey: PREF_KEYS.tavilyKey
  }
]

/**
 * Credentials for the external services.
 *
 * ── WHERE THESE ACTUALLY GO ────────────────────────────────────────────────
 * Two places, and both matter. `localStorage`, under the exact keys in
 * `services/preferences.ts`, because roughly twenty renderer modules read them
 * straight from there — and the OS vault via `secure-save-keys`, which is what
 * the main process reads. Writing only one of the two leaves half the app
 * unable to see a key that the settings screen says is saved.
 *
 * Values are masked by default and never logged.
 */
const ApiKeysPanel = (): React.JSX.Element => {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((field) => [field.id, readPref(field.storageKey)]))
  )
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [portBusy, setPortBusy] = useState(false)
  const { status, setStatus } = useStatus()

  /**
   * Verify one key against its live provider.
   *
   * Tests what is currently typed rather than what is stored, so a key can be
   * checked before it is committed — the same contract as the setup wizard.
   */
  const test = useCallback(
    async (field: KeyField): Promise<void> => {
      if (!field.provider) return
      setTesting(field.id)
      try {
        const res = await testProvider(field.provider, { key: values[field.id]?.trim() })
        setResults((prev) => ({ ...prev, [field.id]: res }))
      } catch (err) {
        setResults((prev) => ({
          ...prev,
          [field.id]: {
            provider: field.provider as ProviderId,
            verdict: 'error',
            message: String((err as { message?: string })?.message ?? err)
          }
        }))
      } finally {
        setTesting(null)
      }
    },
    [values]
  )

  const doExport = useCallback(
    async (includeSecrets: boolean): Promise<void> => {
      // The consequence is spelled out before the dialog, not after, because a
      // file containing live keys is trivially forwarded by mistake.
      if (
        includeSecrets &&
        !window.confirm(
          'This file will contain your API keys in plain text.\n\nKeys are encrypted per Windows account, so they cannot be moved any other way — but treat the file like a password and delete it once imported.\n\nContinue?'
        )
      ) {
        return
      }
      setPortBusy(true)
      try {
        const res = await exportConfig(includeSecrets)
        if (res.ok) {
          setStatus(
            'success',
            includeSecrets
              ? `Exported with keys to ${res.path}. Delete it after importing.`
              : `Exported to ${res.path}. No keys were included.`
          )
        } else if (!res.canceled) {
          setStatus('error', res.error ?? 'Export failed.')
        }
      } finally {
        setPortBusy(false)
      }
    },
    [setStatus]
  )

  const doImport = useCallback(async (): Promise<void> => {
    setPortBusy(true)
    try {
      const res = await importConfig()
      if (res.ok) {
        setStatus(
          'success',
          `Imported ${res.keysImported} key(s), ${res.urlsImported} endpoint(s) and ${res.settingsImported} setting(s). Restart Brutus to apply everything.`
        )
      } else if (!res.canceled) {
        setStatus('error', res.error ?? 'Import failed.')
      }
    } finally {
      setPortBusy(false)
    }
  }, [setStatus])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      FIELDS.forEach((field) => writePref(field.storageKey, values[field.id].trim()))

      /**
       * Also written to the multi-provider vault.
       *
       * The legacy `localStorage` copy stays because roughly twenty renderer
       * modules read it directly; the vault is what the setup wizard, the
       * Diagnostics panel and every main-process consumer read. Writing one and
       * not the other is what would leave half the app unable to see a key the
       * settings screen claims is saved.
       */
      await Promise.all(
        FIELDS.filter((f) => f.provider).map((f) =>
          saveKey(f.provider as string, values[f.id].trim())
        )
      )

      if (window.electron?.ipcRenderer) {
        try {
          await window.electron.ipcRenderer.invoke('secure-save-keys', {
            groqKey: values.groq.trim(),
            geminiKey: values.gemini.trim()
          })
        } catch (error) {
          // The local copy already succeeded, so most of the app will work.
          // The original swallowed this entirely, which meant a vault failure
          // still reported success.
          setStatus('error', `Saved locally, but the OS vault rejected the write: ${String(error)}`)
          return
        }
      }

      setStatus('success', 'Keys saved. Restart the voice link to pick them up.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="API Keys"
        description="Stored on this machine and in the OS credential vault. Never sent anywhere except the service each key belongs to."
        actions={
          <Button
            size="sm"
            loading={busy}
            onClick={save}
            leadingIcon={busy ? undefined : <RiSave3Line size={14} />}
          >
            Save all
          </Button>
        }
      />

      <SettingsSection title="Credentials">
        {FIELDS.map((field) => (
          <SettingsRow
            key={field.id}
            stacked
            htmlFor={`key-${field.id}`}
            label={field.label}
            description={field.description}
            control={
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Input
                    id={`key-${field.id}`}
                    type={revealed[field.id] ? 'text' : 'password'}
                    value={values[field.id]}
                    placeholder={field.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    className="flex-1 font-mono text-xs"
                    onChange={(e) => {
                      setValues((prev) => ({ ...prev, [field.id]: e.target.value }))
                      // A changed key invalidates whatever the last test said.
                      setResults((prev) => {
                        if (!prev[field.id]) return prev
                        const next = { ...prev }
                        delete next[field.id]
                        return next
                      })
                    }}
                    trailingSlot={
                      <button
                        type="button"
                        aria-label={revealed[field.id] ? 'Hide key' : 'Show key'}
                        onClick={() =>
                          setRevealed((prev) => ({ ...prev, [field.id]: !prev[field.id] }))
                        }
                        className="cursor-pointer rounded p-1 text-content-faint transition-colors hover:text-content-secondary"
                      >
                        {revealed[field.id] ? <RiEyeOffLine size={15} /> : <RiEyeLine size={15} />}
                      </button>
                    }
                  />
                  {field.provider && (
                    <Button
                      size="sm"
                      variant="tertiary"
                      loading={testing === field.id}
                      disabled={!values[field.id]?.trim() || testing !== null}
                      onClick={() => void test(field)}
                      leadingIcon={testing === field.id ? undefined : <RiPlugLine size={13} />}
                    >
                      Test
                    </Button>
                  )}
                </div>

                {results[field.id] && (
                  <span
                    role="status"
                    className={
                      results[field.id].verdict === 'ok'
                        ? 'flex items-center gap-1.5 text-[11px] text-emerald-400'
                        : results[field.id].verdict === 'rate-limited'
                          ? 'flex items-center gap-1.5 text-[11px] text-amber-400'
                          : 'flex items-center gap-1.5 text-[11px] text-red-400'
                    }
                  >
                    {results[field.id].verdict === 'ok' ? (
                      <RiCheckLine size={12} />
                    ) : results[field.id].verdict === 'rate-limited' ? (
                      <RiTimeLine size={12} />
                    ) : (
                      <RiErrorWarningLine size={12} />
                    )}
                    {results[field.id].message}
                  </span>
                )}
              </div>
            }
          />
        ))}
      </SettingsSection>

      {/* ── Moving a setup between machines ── */}
      <SettingsSection
        title="Portability"
        description="Move your setup to another PC. Keys are excluded unless you explicitly include them."
      >
        <SettingsRow
          stacked
          label="Configuration file"
          description="Settings, endpoints and feature toggles. Import restores them on the other machine."
          control={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="tertiary"
                disabled={portBusy}
                onClick={() => void doExport(false)}
                leadingIcon={<RiDownload2Line size={13} />}
              >
                Export
              </Button>
              <Button
                size="sm"
                variant="tertiary"
                disabled={portBusy}
                onClick={() => void doExport(true)}
                leadingIcon={<RiDownload2Line size={13} />}
              >
                Export with keys
              </Button>
              <Button
                size="sm"
                variant="tertiary"
                disabled={portBusy}
                onClick={() => void doImport()}
                leadingIcon={<RiUpload2Line size={13} />}
              >
                Import
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <SettingsStatus status={status} />
    </div>
  )
}

export default ApiKeysPanel
