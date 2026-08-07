import { useCallback, useEffect, useState } from 'react'
import { RiRefreshLine, RiSave3Line } from 'react-icons/ri'
import { Badge, Button, Input, Switch } from '@renderer/components/ui'
import { SettingsHeader, SettingsRow, SettingsSection, SettingsStatus } from '../controls'
import { useStatus } from '../useStatus'

interface BrainHealth {
  reachable: boolean
  chatReady: boolean
  baseUrl?: string
}

interface BrainConfig {
  baseUrl?: string
  apiKey?: string
  enabled?: boolean
}

/**
 * Edge inference routing.
 *
 * Brutus does no local inference — it routes OpenAI-shaped `/v1/chat` calls to
 * a Snapdragon Brain Node when one is configured and reachable. The health
 * probe distinguishes *reachable* from *chat-ready* on purpose: a node that
 * answers on the port but has no model loaded is the failure this panel exists
 * to make visible, and reporting it as simply "offline" sends people to check
 * their network instead of their model.
 */
const BrainNodePanel = (): React.JSX.Element => {
  const [baseUrl, setBaseUrl] = useState('http://10.113.246.106:8080')
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [health, setHealth] = useState<BrainHealth | null>(null)
  const { status, setStatus } = useStatus()

  const refreshHealth = useCallback(async (): Promise<void> => {
    if (!window.electron?.ipcRenderer) return
    setChecking(true)
    try {
      const result = (await window.electron.ipcRenderer.invoke('brain-health')) as BrainHealth
      setHealth(result || { reachable: false, chatReady: false })
    } catch {
      setHealth({ reachable: false, chatReady: false })
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    if (!window.electron?.ipcRenderer) return
    window.electron.ipcRenderer
      .invoke('llm-config-get')
      .then((cfg: BrainConfig | null) => {
        if (!cfg) return
        if (cfg.baseUrl) setBaseUrl(cfg.baseUrl)
        setApiKey(cfg.apiKey || '')
        setEnabled(cfg.enabled !== false)
      })
      .catch(() => {
        // A missing config is the normal first-run state, not an error worth
        // showing. The defaults above already describe it.
      })
    void refreshHealth()
  }, [refreshHealth])

  const save = async (): Promise<void> => {
    if (!window.electron?.ipcRenderer) return
    setBusy(true)
    try {
      const cfg = (await window.electron.ipcRenderer.invoke('llm-config-set', {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        enabled
      })) as BrainConfig | null
      if (cfg) {
        if (cfg.baseUrl) setBaseUrl(cfg.baseUrl)
        setApiKey(cfg.apiKey || '')
        setEnabled(cfg.enabled !== false)
      }
      await refreshHealth()
      setStatus('success', 'Brain Node configuration saved.')
    } catch (error) {
      setStatus('error', `Could not save: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const healthBadge = checking ? (
    <Badge tone="neutral" dot>
      Probing…
    </Badge>
  ) : health?.chatReady ? (
    <Badge tone="success" dot>
      Chat ready
    </Badge>
  ) : health?.reachable ? (
    <Badge tone="warning" dot>
      Reachable, no model
    </Badge>
  ) : (
    <Badge tone="danger" dot>
      Unreachable
    </Badge>
  )

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="Brain Node"
        description="Route language-model calls to your own edge device instead of the cloud."
        actions={
          <>
            {healthBadge}
            <Button
              variant="secondary"
              size="sm"
              iconOnly
              aria-label="Re-check Brain Node health"
              loading={checking}
              onClick={() => void refreshHealth()}
            >
              {checking ? undefined : <RiRefreshLine size={14} />}
            </Button>
          </>
        }
      />

      <SettingsSection title="Endpoint">
        <SettingsRow
          stacked
          htmlFor="brain-url"
          label="Base URL"
          description="An OpenAI-shaped server exposing /v1/chat/completions."
          control={
            <Input
              id="brain-url"
              value={baseUrl}
              placeholder="http://10.113.246.106:8080"
              spellCheck={false}
              className="font-mono text-xs"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          }
        />
        <SettingsRow
          stacked
          htmlFor="brain-key"
          label="Bearer token"
          description="Leave blank if the node is open on your network."
          control={
            <Input
              id="brain-key"
              type="password"
              value={apiKey}
              placeholder="Optional"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
              onChange={(e) => setApiKey(e.target.value)}
            />
          }
        />
        <SettingsRow
          htmlFor="brain-enabled"
          label="Route AI to Brain Node"
          description="When on, chat and tools prefer the edge device. Voice is unaffected — it has its own engine setting."
          control={
            <Switch
              id="brain-enabled"
              checked={enabled}
              onChange={setEnabled}
              aria-label="Route AI to Brain Node"
            />
          }
        />
        <SettingsRow
          label="Apply"
          description={
            health?.baseUrl ? `Last probed: ${health.baseUrl}` : 'Saving re-probes the node.'
          }
          control={
            <Button
              size="sm"
              loading={busy}
              onClick={save}
              leadingIcon={busy ? undefined : <RiSave3Line size={14} />}
            >
              Save &amp; probe
            </Button>
          }
        />
      </SettingsSection>

      <SettingsStatus status={status} />
    </div>
  )
}

export default BrainNodePanel
