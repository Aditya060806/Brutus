import { useEffect, useState } from 'react'
import { RiSave3Line } from 'react-icons/ri'
import { Badge, Button, Input, Textarea, cn } from '@renderer/components/ui'
import { useProfileStore, type VoiceProfile } from '@renderer/store/profile-store'
import { SettingsHeader, SettingsRow, SettingsSection, SettingsStatus } from '../controls'
import { useStatus } from '../useStatus'
import type { PanelProps } from '../types'

const WORD_LIMIT = 150

/** Segmented two-option control — used for both voice choices. */
const Segmented = <T extends string>({
  value,
  options,
  onChange,
  disabled
}: {
  value: T
  options: { value: T; label: string; hint?: string }[]
  onChange: (next: T) => void
  disabled?: boolean
}): React.JSX.Element => (
  <div
    role="radiogroup"
    className={cn(
      'inline-flex rounded-lg border border-line bg-surface-muted p-0.5',
      disabled && 'pointer-events-none opacity-50'
    )}
  >
    {options.map((option) => {
      const active = option.value === value
      return (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={active}
          title={option.hint}
          onClick={() => onChange(option.value)}
          className={cn(
            'cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
            active
              ? 'bg-primary-500/15 text-primary-400'
              : 'text-content-muted hover:text-content-secondary'
          )}
        >
          {option.label}
        </button>
      )
    })}
  </div>
)

/**
 * Who Brutus is, and how it sounds.
 *
 * ── WHY THE VOICE CONTROLS LOCK WHILE THE LINK IS LIVE ─────────────────────
 * The Gemini voice service reads its profile and engine once, at connect time.
 * Changing either mid-session writes the new value to storage but leaves the
 * running session on the old one, so the UI would claim a change that had not
 * happened. Locking them while `isSystemActive` — and saying why — is honest;
 * that behaviour is carried over from the original view deliberately.
 */
const PersonalityPanel = ({ isSystemActive, navigate }: PanelProps): React.JSX.Element => {
  const [personality, setPersonality] = useState('')
  const [savingPersonality, setSavingPersonality] = useState(false)
  const { status, setStatus } = useStatus()

  const displayName = useProfileStore((s) => s.displayName)
  const setDisplayName = useProfileStore((s) => s.setDisplayName)
  const voiceProfile = useProfileStore((s) => s.voiceProfile)
  const setVoiceProfile = useProfileStore((s) => s.setVoiceProfile)
  const voiceEngine = useProfileStore((s) => s.voiceEngine)

  const [nameDraft, setNameDraft] = useState(displayName)

  useEffect(() => {
    if (!window.electron?.ipcRenderer) return
    window.electron.ipcRenderer.invoke('get-personality').then((res: string) => {
      if (res) setPersonality(res)
    })
  }, [])

  const wordCount = personality
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length

  const onPersonalityChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const text = event.target.value
    const words = text
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0)
    if (words.length <= WORD_LIMIT) setPersonality(text)
  }

  const savePersonality = async (): Promise<void> => {
    if (!window.electron?.ipcRenderer) return
    setSavingPersonality(true)
    try {
      await window.electron.ipcRenderer.invoke('set-personality', personality)
      setStatus('success', 'Personality saved to the OS vault.')
    } catch (error) {
      setStatus('error', `Could not save personality: ${String(error)}`)
    } finally {
      setSavingPersonality(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="Personality & Voice"
        description="How Brutus addresses you, and how it speaks."
        actions={
          isSystemActive ? (
            <Badge tone="accent" dot>
              Voice link live
            </Badge>
          ) : undefined
        }
      />

      <SettingsSection title="Identity">
        <SettingsRow
          htmlFor="operator-name"
          label="What Brutus calls you"
          description="Used in speech and in the greeting on the dashboard."
          control={
            <div className="flex items-center gap-2">
              <Input
                id="operator-name"
                value={nameDraft}
                block={false}
                className="w-52"
                placeholder="Operator"
                onChange={(e) => setNameDraft(e.target.value)}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={!nameDraft.trim() || nameDraft === displayName}
                onClick={() => {
                  setDisplayName(nameDraft.trim())
                  setStatus('success', 'Name updated.')
                }}
              >
                Save
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Personality"
        description={`Free-form instructions that shape every reply. ${WORD_LIMIT} words maximum.`}
        aside={
          <Badge mono tone={wordCount >= WORD_LIMIT ? 'warning' : 'neutral'}>
            {wordCount}/{WORD_LIMIT}
          </Badge>
        }
      >
        <SettingsRow
          stacked
          control={
            <div className="flex flex-col gap-3">
              <Textarea
                rows={6}
                value={personality}
                onChange={onPersonalityChange}
                placeholder="Define who Brutus is. For example: 'You are a terse, highly technical assistant. Skip pleasantries and lead with the answer.'"
              />
              <div className="flex items-center justify-between gap-3">
                <SettingsStatus status={status} />
                <Button
                  size="sm"
                  className="ml-auto"
                  loading={savingPersonality}
                  onClick={savePersonality}
                  leadingIcon={savingPersonality ? undefined : <RiSave3Line size={14} />}
                >
                  Save personality
                </Button>
              </div>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Voice"
        description={
          isSystemActive
            ? 'Locked while the voice link is live — the running session reads these once, at connect time. Disconnect to change them.'
            : undefined
        }
      >
        <SettingsRow
          label="Voice profile"
          description="Which Gemini voice Brutus speaks with."
          disabled={isSystemActive}
          control={
            <Segmented<VoiceProfile>
              value={voiceProfile}
              disabled={isSystemActive}
              onChange={setVoiceProfile}
              options={[
                { value: 'MALE', label: 'Puck', hint: 'Male' },
                { value: 'FEMALE', label: 'Aoede', hint: 'Female' }
              ]}
            />
          }
        />
        {/* Deliberately a link, not a second control. There are three engines
            now — cloud, Brain Node and on-device — and a two-option toggle here
            could not represent `local`, so the two screens would disagree about
            what is selected. The Voice panel owns this setting. */}
        <SettingsRow
          label="Voice engine"
          description={
            voiceEngine === 'local'
              ? 'On device — Whisper listens and your system voice speaks. Nothing leaves this machine.'
              : voiceEngine === 'server'
                ? 'Brain Node — speech is handled by your edge device over the LAN.'
                : 'Cloud — Gemini Live. Real-time and tool-capable, billed per minute.'
          }
          control={
            <Button variant="secondary" size="sm" onClick={() => navigate('voice')}>
              Change
            </Button>
          }
        />
      </SettingsSection>
    </div>
  )
}

export default PersonalityPanel
