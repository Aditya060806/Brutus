import { useState } from 'react'
import { RiDeleteBin6Line } from 'react-icons/ri'
import { Button } from '@renderer/components/ui'
import { SettingsHeader, SettingsRow, SettingsSection, SettingsStatus } from '../controls'
import { useStatus } from '../useStatus'

/**
 * Stored conversation transcripts.
 *
 * Deletion is two-step rather than a confirm dialog: the first click arms the
 * button and relabels it, a second within four seconds commits. That is the
 * same pattern the original used, kept because it is genuinely better here —
 * an OS confirm would block the renderer, and this cannot be dismissed by
 * reflex the way a modal can.
 */
const HistoryPanel = (): React.JSX.Element => {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const { status, setStatus } = useStatus()

  const clearHistory = async (): Promise<void> => {
    if (!armed) {
      setArmed(true)
      setTimeout(() => setArmed(false), 4000)
      return
    }
    setBusy(true)
    try {
      await window.electron.ipcRenderer.invoke('clear-history')
      setArmed(false)
      setStatus('success', 'Chat history cleared.')
    } catch (error) {
      setStatus('error', `Could not clear history: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="Chat History"
        description="Transcripts of your conversations with Brutus, stored on this machine."
      />

      <SettingsSection title="Stored data">
        <SettingsRow
          label="Clear chat history"
          description="Permanently deletes every stored transcript. Voice sessions, notes and Studio workspaces are unaffected."
          control={
            <Button
              variant="secondary"
              tone="danger"
              size="sm"
              loading={busy}
              onClick={clearHistory}
              leadingIcon={busy ? undefined : <RiDeleteBin6Line size={14} />}
            >
              {armed ? 'Click again to confirm' : 'Clear history'}
            </Button>
          }
        />
        {status && (
          <div className="px-4 py-3">
            <SettingsStatus status={status} />
          </div>
        )}
      </SettingsSection>
    </div>
  )
}

export default HistoryPanel
