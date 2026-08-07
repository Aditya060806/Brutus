import { useState } from 'react'
import { RiEyeLine, RiEyeOffLine, RiSave3Line } from 'react-icons/ri'
import { Button, Input } from '@renderer/components/ui'
import { PREF_KEYS, readPref, writePref } from '@renderer/services/preferences'
import { SettingsHeader, SettingsRow, SettingsSection, SettingsStatus } from '../controls'
import { useStatus } from '../useStatus'

interface KeyField {
  id: string
  label: string
  description: string
  placeholder: string
  storageKey: (typeof PREF_KEYS)[keyof typeof PREF_KEYS]
}

const FIELDS: KeyField[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Powers the voice link, chat, and most document tools.',
    placeholder: 'AIzaSy…',
    storageKey: PREF_KEYS.geminiKey
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Fast inference for search summarisation and agent reframing.',
    placeholder: 'gsk_…',
    storageKey: PREF_KEYS.groqKey
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
  const { status, setStatus } = useStatus()

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      FIELDS.forEach((field) => writePref(field.storageKey, values[field.id].trim()))

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
              <Input
                id={`key-${field.id}`}
                type={revealed[field.id] ? 'text' : 'password'}
                value={values[field.id]}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
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
            }
          />
        ))}
      </SettingsSection>

      <SettingsStatus status={status} />
    </div>
  )
}

export default ApiKeysPanel
