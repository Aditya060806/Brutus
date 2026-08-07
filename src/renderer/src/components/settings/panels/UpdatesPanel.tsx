import { useEffect, useState } from 'react'
import { RiDownloadCloud2Line, RiRefreshLine, RiRocketLine } from 'react-icons/ri'
import { Badge, Button } from '@renderer/components/ui'
import { SettingsHeader, SettingsRow, SettingsSection } from '../controls'

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

interface UpdaterEvent {
  status: UpdateStatus
  version?: string
  notes?: string
  progress?: number
}

const STATUS_COPY: Record<UpdateStatus, { label: string; tone: 'neutral' | 'accent' | 'success' }> =
  {
    idle: { label: 'Up to date', tone: 'neutral' },
    checking: { label: 'Checking…', tone: 'neutral' },
    available: { label: 'Update available', tone: 'accent' },
    downloading: { label: 'Downloading', tone: 'accent' },
    ready: { label: 'Ready to install', tone: 'success' },
    error: { label: 'Check failed', tone: 'neutral' }
  }

/**
 * App updates.
 *
 * The IPC contract is unchanged from the original settings view: three invokes
 * (`check-for-updates`, `download-update`, `install-update`) and one push
 * channel (`updater-event`) carrying `{ status, version, notes, progress }`.
 */
const UpdatesPanel = (): React.JSX.Element => {
  const [appVersion, setAppVersion] = useState('…')
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [version, setVersion] = useState('')
  const [notes, setNotes] = useState('')
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    if (!window.electron?.ipcRenderer) return
    window.electron.ipcRenderer.invoke('get-app-version').then((v: string) => setAppVersion(v))

    const handler = (_: unknown, event: UpdaterEvent): void => {
      setStatus(event.status)
      if (event.version) setVersion(event.version)
      if (event.notes) setNotes(event.notes)
      if (event.progress !== undefined) setProgress(event.progress)
    }
    window.electron.ipcRenderer.on('updater-event', handler)
    return () => {
      window.electron.ipcRenderer.removeAllListeners('updater-event')
    }
  }, [])

  const busy = status === 'checking' || status === 'downloading'

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="Updates"
        description="Brutus checks for new builds and installs them on restart."
        actions={
          <Badge mono tone="neutral">
            v{appVersion}
          </Badge>
        }
      />

      <SettingsSection title="Channel">
        <SettingsRow
          label="Status"
          description={version ? `Latest available: v${version}` : 'No newer build seen yet.'}
          control={
            <Badge tone={STATUS_COPY[status].tone} dot>
              {STATUS_COPY[status].label}
            </Badge>
          }
        />

        {status === 'downloading' && (
          <SettingsRow
            stacked
            label="Download progress"
            description={`${Math.round(progress)}% complete`}
            control={
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
                role="progressbar"
                aria-valuenow={Math.round(progress)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-primary-500 transition-[width] duration-300"
                  style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                />
              </div>
            }
          />
        )}

        <SettingsRow
          label="Actions"
          description="Installing quits and relaunches Brutus."
          control={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={status === 'checking'}
                onClick={() => {
                  setStatus('checking')
                  window.electron.ipcRenderer.invoke('check-for-updates')
                }}
                leadingIcon={status === 'checking' ? undefined : <RiRefreshLine size={14} />}
              >
                Check
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={status !== 'available'}
                loading={status === 'downloading'}
                onClick={() => window.electron.ipcRenderer.invoke('download-update')}
                leadingIcon={
                  status === 'downloading' ? undefined : <RiDownloadCloud2Line size={14} />
                }
              >
                Download
              </Button>
              <Button
                size="sm"
                disabled={status !== 'ready' || busy}
                onClick={() => window.electron.ipcRenderer.invoke('install-update')}
                leadingIcon={<RiRocketLine size={14} />}
              >
                Install &amp; restart
              </Button>
            </div>
          }
        />
      </SettingsSection>

      {notes && (
        <SettingsSection title="Patch notes">
          <div className="scrollbar-small max-h-64 overflow-y-auto whitespace-pre-wrap px-4 py-3 text-xs leading-relaxed text-content-secondary">
            {notes}
          </div>
        </SettingsSection>
      )}
    </div>
  )
}

export default UpdatesPanel
