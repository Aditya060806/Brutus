import { useEffect, useState } from 'react'
import { RiSave3Line } from 'react-icons/ri'
import { Badge, Button, Input, Select, Textarea } from '@renderer/components/ui'
import { SettingsHeader, SettingsRow, SettingsSection, SettingsStatus } from '../controls'
import { useStatus } from '../useStatus'

interface KeyPool {
  total: number
  healthy: number
  cooling: number
  dead: number
}

interface OrchestratorStatus {
  config?: {
    tavilyKey?: string
    concurrency?: number
    maxLlmCallsPerRun?: number
    minKeyIntervalMs?: number
    autonomy?: Autonomy
  }
  keyPool?: KeyPool
}

type Autonomy = 'guarded' | 'strict' | 'autonomous'

const AUTONOMY_OPTIONS = [
  { value: 'strict', label: 'Strict — ask before every gated capability' },
  { value: 'guarded', label: 'Guarded — ask for writes and external calls' },
  { value: 'autonomous', label: 'Autonomous — only ask for destructive actions' }
]

/**
 * Multi-agent orchestration.
 *
 * ── THE `/agent` CONSTRAINT ────────────────────────────────────────────────
 * Nothing here runs on ordinary chat. The orchestrator is triggered only by an
 * explicit `/agent` in the chat box, by design — normal chat must stay a single
 * fast call. These settings shape what happens after that trigger; they never
 * cause it.
 */
const AgentsPanel = (): React.JSX.Element => {
  const [groqKeys, setGroqKeys] = useState('')
  const [tavilyKey, setTavilyKey] = useState('')
  const [concurrency, setConcurrency] = useState(3)
  const [maxCalls, setMaxCalls] = useState(20)
  const [keyInterval, setKeyInterval] = useState(2100)
  const [autonomy, setAutonomy] = useState<Autonomy>('guarded')
  const [keyPool, setKeyPool] = useState<KeyPool | null>(null)
  const [busy, setBusy] = useState(false)
  const { status, setStatus } = useStatus()

  useEffect(() => {
    if (!window.electron?.ipcRenderer) return
    window.electron.ipcRenderer
      .invoke('orchestrator-status')
      .then((s: OrchestratorStatus) => {
        if (!s?.config) return
        setTavilyKey(s.config.tavilyKey || '')
        setConcurrency(s.config.concurrency ?? 3)
        setMaxCalls(s.config.maxLlmCallsPerRun ?? 20)
        setKeyInterval(s.config.minKeyIntervalMs ?? 2100)
        setAutonomy(s.config.autonomy ?? 'guarded')
        setKeyPool(s.keyPool ?? null)
      })
      .catch(() => {
        // Orchestrator not initialised yet — the defaults above are correct.
      })
  }, [])

  const save = async (): Promise<void> => {
    if (!window.electron?.ipcRenderer) return
    setBusy(true)
    try {
      const patch: Record<string, unknown> = {
        tavilyKey: tavilyKey.trim(),
        concurrency,
        maxLlmCallsPerRun: maxCalls,
        minKeyIntervalMs: keyInterval,
        autonomy
      }
      // Only overwrite stored keys when the operator actually typed some —
      // otherwise opening this panel and pressing Save would wipe the pool.
      if (groqKeys.trim()) patch.groqKeysRaw = groqKeys

      const res = (await window.electron.ipcRenderer.invoke(
        'orchestrator-config',
        patch
      )) as OrchestratorStatus
      if (res?.keyPool) setKeyPool(res.keyPool)
      setGroqKeys('')
      setStatus('success', 'Agent configuration saved.')
    } catch (error) {
      setStatus('error', `Could not save: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="Agents"
        description="Runs only when you type /agent in chat. Ordinary chat stays a single, immediate call."
        actions={
          <Button
            size="sm"
            loading={busy}
            onClick={save}
            leadingIcon={busy ? undefined : <RiSave3Line size={14} />}
          >
            Save
          </Button>
        }
      />

      {keyPool && (
        <SettingsSection title="Key pool">
          <SettingsRow
            label="Groq keys"
            description="Requests round-robin across healthy keys. A key that returns 429 cools off rather than being retried."
            control={
              <div className="flex items-center gap-1.5">
                <Badge tone="success" dot>
                  {keyPool.healthy} healthy
                </Badge>
                {keyPool.cooling > 0 && <Badge tone="warning">{keyPool.cooling} cooling</Badge>}
                {keyPool.dead > 0 && <Badge tone="danger">{keyPool.dead} dead</Badge>}
              </div>
            }
          />
        </SettingsSection>
      )}

      <SettingsSection title="Credentials">
        <SettingsRow
          stacked
          htmlFor="agent-groq"
          label="Groq keys"
          description="One per line. Leave blank to keep the keys already stored — saving an empty box does not clear them."
          control={
            <Textarea
              id="agent-groq"
              rows={3}
              value={groqKeys}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              placeholder={'gsk_…\ngsk_…'}
              onChange={(e) => setGroqKeys(e.target.value)}
            />
          }
        />
        <SettingsRow
          stacked
          htmlFor="agent-tavily"
          label="Tavily key"
          description="Web search for the research specialist."
          control={
            <Input
              id="agent-tavily"
              type="password"
              value={tavilyKey}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              placeholder="tvly-…"
              onChange={(e) => setTavilyKey(e.target.value)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Execution">
        <SettingsRow
          htmlFor="agent-autonomy"
          label="Autonomy"
          description="How often an agent must ask before using a gated capability."
          stacked
          control={
            <Select
              id="agent-autonomy"
              value={autonomy}
              options={AUTONOMY_OPTIONS}
              onChange={(e) => setAutonomy(e.target.value as Autonomy)}
            />
          }
        />
        <SettingsRow
          htmlFor="agent-concurrency"
          label="Concurrency"
          description="Parallel agents. Capped by the number of healthy keys regardless of what is set here."
          control={
            <Input
              id="agent-concurrency"
              type="number"
              min={1}
              max={12}
              value={concurrency}
              block={false}
              className="w-24"
              onChange={(e) => setConcurrency(Number(e.target.value) || 1)}
            />
          }
        />
        <SettingsRow
          htmlFor="agent-max-calls"
          label="LLM call budget"
          description="Hard ceiling per /agent run. Reaching it ends the run rather than spending more."
          control={
            <Input
              id="agent-max-calls"
              type="number"
              min={1}
              max={200}
              value={maxCalls}
              block={false}
              className="w-24"
              onChange={(e) => setMaxCalls(Number(e.target.value) || 1)}
            />
          }
        />
        <SettingsRow
          htmlFor="agent-interval"
          label="Minimum key interval"
          description="Milliseconds between two uses of the same key. Proactive pacing — it avoids the 429 rather than reacting to it."
          control={
            <Input
              id="agent-interval"
              type="number"
              min={0}
              max={20000}
              step={100}
              value={keyInterval}
              block={false}
              className="w-28"
              onChange={(e) => setKeyInterval(Number(e.target.value) || 0)}
            />
          }
        />
      </SettingsSection>

      <SettingsStatus status={status} />
    </div>
  )
}

export default AgentsPanel
