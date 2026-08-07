import { useEffect, useState } from 'react'
import { RiShieldFlashLine } from 'react-icons/ri'
import { Badge, Card } from '@renderer/components/ui'
import { SettingsHeader, SettingsRow, SettingsSection } from '../controls'
import type { PanelProps } from '../types'

/**
 * Build information.
 *
 * Everything shown here is read at runtime rather than baked in: the version
 * comes from the main process, the platform from the renderer. A hardcoded
 * version string in an app with an auto-updater goes stale on the first update
 * and then quietly misreports itself forever.
 */
const AboutPanel = ({ isSystemActive }: PanelProps): React.JSX.Element => {
  const [version, setVersion] = useState('…')

  useEffect(() => {
    if (!window.electron?.ipcRenderer) return
    window.electron.ipcRenderer
      .invoke('get-app-version')
      .then((v: string) => setVersion(v))
      .catch(() => setVersion('unknown'))
  }, [])

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader title="About" description="What this build is, and what it is doing." />

      <Card tone="elevated" className="flex items-center gap-4 p-5">
        <span
          aria-hidden="true"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-500 ring-1 ring-inset ring-primary-500/25"
        >
          <RiShieldFlashLine size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold tracking-tight text-content">BRUTUS</p>
          <p className="text-xs text-content-muted">Local-first desktop assistant</p>
        </div>
        <Badge mono tone="neutral">
          v{version}
        </Badge>
      </Card>

      <SettingsSection title="Runtime">
        <SettingsRow
          label="Voice link"
          control={
            isSystemActive ? (
              <Badge tone="accent" dot>
                Live
              </Badge>
            ) : (
              <Badge tone="neutral" dot>
                Idle
              </Badge>
            )
          }
        />
        <SettingsRow label="Platform" control={<Badge mono>{navigator.platform}</Badge>} />
        <SettingsRow
          label="Renderer"
          description="Chromium in Electron, with the UI running entirely offline."
          control={<Badge mono>{navigator.hardwareConcurrency} cores</Badge>}
        />
      </SettingsSection>
    </div>
  )
}

export default AboutPanel
