import { useEffect, useState } from 'react'
import { RiAlertLine, RiCheckLine } from 'react-icons/ri'
import { Badge, Button, Input, Switch, cn } from '@renderer/components/ui'
import { SettingsHeader, SettingsRow, SettingsSection, SettingsStatus } from '../controls'
import { useStatus } from '../useStatus'

type Level = 'off' | 'draft' | 'autonomous'

interface Config {
  level: Level
  pollMinutes: number
  confidenceFloor: number
  allowlistOnly: boolean
  allowlist: string[]
  neverAutoTopics: string[]
  maxSendsPerDay: number
  threadCooldownHours: number
  quietHours: { start: number; end: number }
  followUpAfterDays: number
}

const LEVELS: { id: Level; title: string; description: string }[] = [
  {
    id: 'off',
    title: 'Off',
    description: 'Brutus does not read your inbox. Nothing runs in the background.'
  },
  {
    id: 'draft',
    title: 'Draft only',
    description:
      'Reads and triages, and drafts every reply — but sends nothing. Start here: you see exactly what it would have said before it can say it.'
  },
  {
    id: 'autonomous',
    title: 'Send on its own',
    description:
      'Brutus replies to your clients without asking. The rails below still apply, and everything it sends is logged under Handled.'
  }
]

const DeskPanel = (): React.JSX.Element => {
  const [config, setConfig] = useState<Config | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [allowlistText, setAllowlistText] = useState('')
  const [topicsText, setTopicsText] = useState('')
  const { status, setStatus } = useStatus()

  // Loaded inside the effect rather than through a `useCallback` the effect
  // calls: the linter cannot see past the indirection and reads it as a
  // synchronous setState, and the guard also stops a slow IPC reply landing on
  // an unmounted panel when the user closes settings mid-load.
  useEffect(() => {
    let live = true
    void (async () => {
      const res = await window.electron.ipcRenderer.invoke('desk-state')
      if (!live || !res?.success) return
      setConfig(res.config)
      setAllowlistText((res.config.allowlist || []).join('\n'))
      setTopicsText((res.config.neverAutoTopics || []).join(', '))
    })()
    return () => {
      live = false
    }
  }, [])

  const patch = async (next: Partial<Config>, note?: string): Promise<void> => {
    const res = await window.electron.ipcRenderer.invoke('desk-config', next)
    if (res?.success) {
      setConfig(res.config)
      if (note) setStatus('success', note)
    } else {
      setStatus('error', res?.error || 'Could not save')
    }
  }

  const chooseLevel = async (level: Level): Promise<void> => {
    // The one deliberate friction point in the whole feature. Everything else
    // is a normal setting; this one lets software email your customers.
    if (level === 'autonomous' && config?.level !== 'autonomous') {
      setConfirming(true)
      return
    }
    setConfirming(false)
    await patch({ level }, level === 'off' ? 'Desk switched off.' : `Set to "${level}".`)
  }

  if (!config) {
    return (
      <div className="flex flex-col gap-5">
        <SettingsHeader title="Desk" description="Loading…" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="Desk"
        description="Brutus reads your inbox, decides what needs you, and drafts the replies."
      />

      <SettingsSection
        title="How much it may do"
        description="Applies immediately. Changing this restarts the background loop."
      >
        <div className="flex flex-col gap-2 px-4 py-4">
          {LEVELS.map((option) => {
            const active = config.level === option.id
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => void chooseLevel(option.id)}
                aria-pressed={active}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-3.5 text-left',
                  'cursor-pointer transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                  active
                    ? 'border-primary-500/50 bg-primary-500/10'
                    : 'border-line bg-surface-muted hover:border-line-strong hover:bg-hover'
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-content">{option.title}</span>
                    {active && <RiCheckLine size={14} className="text-primary-500" />}
                    {option.id === 'autonomous' && <Badge tone="warning">Sends email</Badge>}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-content-muted">
                    {option.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        {confirming && (
          <div className="border-t border-line bg-coral-500/5 px-4 py-4">
            <p className="flex items-start gap-2 text-[13px] font-medium text-coral-400">
              <RiAlertLine size={16} className="mt-0.5 shrink-0" />
              Brutus will send email to your clients without asking you first.
            </p>
            <ul className="mt-2.5 space-y-1 pl-6 text-[12px] leading-relaxed text-content-secondary">
              <li>• It only replies to people who have written to you.</li>
              <li>
                • It drafts instead of sending when it is unsure, or when money, contracts or legal
                matters come up.
              </li>
              <li>• Everything it sends is recorded under Handled, with the exact text.</li>
              <li>• You can stop it instantly from the Desk.</li>
            </ul>
            <div className="mt-3.5 flex items-center gap-2">
              <Button
                size="sm"
                tone="danger"
                onClick={() => {
                  setConfirming(false)
                  void patch({ level: 'autonomous' }, 'Brutus is now sending on its own.')
                }}
              >
                I understand — turn it on
              </Button>
              <Button variant="tertiary" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Safety rails"
        description="These stop Brutus acting on a bad guess. Loosen them only when you trust what you are seeing under Handled."
      >
        <SettingsRow
          htmlFor="desk-allowlist-only"
          label="Only reply to people who wrote to you"
          description="The strongest rail: it makes an address the model invented unreachable."
          control={
            <Switch
              id="desk-allowlist-only"
              checked={config.allowlistOnly}
              onChange={(v) => void patch({ allowlistOnly: v })}
              aria-label="Only reply to known contacts"
            />
          }
        />

        <SettingsRow
          htmlFor="desk-confidence"
          label="Confidence floor"
          description={`Below ${Math.round(config.confidenceFloor * 100)}% sure, Brutus drafts instead of sending.`}
          control={
            <Input
              id="desk-confidence"
              type="number"
              min={0}
              max={100}
              value={Math.round(config.confidenceFloor * 100)}
              block={false}
              className="w-24"
              onChange={(e) =>
                void patch({
                  confidenceFloor: Math.min(100, Math.max(0, Number(e.target.value))) / 100
                })
              }
            />
          }
        />

        <SettingsRow
          stacked
          htmlFor="desk-topics"
          label="Never send unattended when these come up"
          description="Comma separated. Matched as whole words in the subject and body."
          control={
            <div className="flex items-center gap-2">
              <Input
                id="desk-topics"
                value={topicsText}
                onChange={(e) => setTopicsText(e.target.value)}
                className="text-xs"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void patch(
                    {
                      neverAutoTopics: topicsText
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean)
                    },
                    'Topics saved.'
                  )
                }
              >
                Save
              </Button>
            </div>
          }
        />

        <SettingsRow
          htmlFor="desk-max-sends"
          label="Most emails per day"
          description="A hard ceiling, so a bug costs one wrong email rather than hundreds."
          control={
            <Input
              id="desk-max-sends"
              type="number"
              min={0}
              max={200}
              value={config.maxSendsPerDay}
              block={false}
              className="w-24"
              onChange={(e) => void patch({ maxSendsPerDay: Number(e.target.value) || 0 })}
            />
          }
        />

        <SettingsRow
          htmlFor="desk-cooldown"
          label="Wait before replying to the same thread again"
          description="Hours. Stops a thread being answered on every run."
          control={
            <Input
              id="desk-cooldown"
              type="number"
              min={0}
              max={168}
              value={config.threadCooldownHours}
              block={false}
              className="w-24"
              onChange={(e) => void patch({ threadCooldownHours: Number(e.target.value) || 0 })}
            />
          }
        />

        <SettingsRow
          label="Quiet hours"
          description="Nothing is sent between these times. Set both to the same value to disable."
          control={
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                max={23}
                aria-label="Quiet hours start"
                value={config.quietHours.start}
                block={false}
                className="w-20"
                onChange={(e) =>
                  void patch({
                    quietHours: { ...config.quietHours, start: Number(e.target.value) || 0 }
                  })
                }
              />
              <span className="text-xs text-content-faint">to</span>
              <Input
                type="number"
                min={0}
                max={23}
                aria-label="Quiet hours end"
                value={config.quietHours.end}
                block={false}
                className="w-20"
                onChange={(e) =>
                  void patch({
                    quietHours: { ...config.quietHours, end: Number(e.target.value) || 0 }
                  })
                }
              />
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Schedule">
        <SettingsRow
          htmlFor="desk-poll"
          label="Check the inbox every"
          description="Minutes. Shorter means faster replies and more Gmail API calls."
          control={
            <Input
              id="desk-poll"
              type="number"
              min={1}
              max={180}
              value={config.pollMinutes}
              block={false}
              className="w-24"
              onChange={(e) =>
                void patch({ pollMinutes: Math.max(1, Number(e.target.value) || 10) })
              }
            />
          }
        />
        <SettingsRow
          htmlFor="desk-followup"
          label="Chase after"
          description="Days without a reply before Brutus follows up on something they promised."
          control={
            <Input
              id="desk-followup"
              type="number"
              min={1}
              max={60}
              value={config.followUpAfterDays}
              block={false}
              className="w-24"
              onChange={(e) =>
                void patch({ followUpAfterDays: Math.max(1, Number(e.target.value) || 3) })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Extra allowed addresses"
        description="People Brutus may reply to even though they have not written to you. One per line."
      >
        <SettingsRow
          stacked
          control={
            <div className="flex items-start gap-2">
              <Input
                value={allowlistText}
                placeholder="accounts@client.com"
                aria-label="Allowlist"
                className="font-mono text-xs"
                onChange={(e) => setAllowlistText(e.target.value)}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void patch(
                    {
                      allowlist: allowlistText
                        .split(/[\n,]/)
                        .map((a) => a.trim())
                        .filter(Boolean)
                    },
                    'Allowlist saved.'
                  )
                }
              >
                Save
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <SettingsStatus status={status} />
    </div>
  )
}

export default DeskPanel
