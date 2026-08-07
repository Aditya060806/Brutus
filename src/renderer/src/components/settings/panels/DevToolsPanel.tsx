import { useCallback, useEffect, useState } from 'react'
import { RiFolderOpenLine, RiRefreshLine } from 'react-icons/ri'
import { Badge, Button, Input, Switch } from '@renderer/components/ui'
import {
  SettingsHeader,
  SettingsOutput,
  SettingsRow,
  SettingsSection,
  SettingsStatus
} from '../controls'
import { useStatus } from '../useStatus'

interface LibreOfficeStatus {
  available: boolean
  path: string | null
  preferred?: boolean
  error?: string
  canceled?: boolean
  success?: boolean
}

interface VscodeStatus {
  available: boolean
  path: string | null
  extensions: number
  settingsPath?: string
  keybindingsPath?: string
}

/**
 * External binaries Brutus can drive.
 *
 * All three probes are best-effort: none of these tools is required for the app
 * to work, so a missing one reports its absence and offers a way to point at
 * it rather than being treated as a failure.
 */
const DevToolsPanel = (): React.JSX.Element => {
  const { status, setStatus } = useStatus()

  // ── LibreOffice ──────────────────────────────────────────────────────────
  const [lo, setLo] = useState<LibreOfficeStatus>({ available: false, path: null })
  const [loPath, setLoPath] = useState('')
  const [loPreferred, setLoPreferred] = useState(false)
  const [loBusy, setLoBusy] = useState(false)

  useEffect(() => {
    if (!window.electron?.ipcRenderer) return
    window.electron.ipcRenderer
      .invoke('get-libreoffice-status')
      .then((r: LibreOfficeStatus) => {
        setLo(r || { available: false, path: null })
        setLoPreferred(!!r?.preferred)
      })
      .catch(() => {
        // Not installed is the common case; the empty state already says so.
      })
  }, [])

  const toggleLoPreference = async (): Promise<void> => {
    setLoBusy(true)
    try {
      const r = (await window.electron.ipcRenderer.invoke(
        'set-libreoffice-preference',
        !loPreferred
      )) as LibreOfficeStatus
      setLoPreferred(!!r.preferred)
      if (r.available !== undefined) setLo({ available: r.available, path: r.path })
    } finally {
      setLoBusy(false)
    }
  }

  const browseLo = async (): Promise<void> => {
    setLoBusy(true)
    try {
      const r = (await window.electron.ipcRenderer.invoke(
        'pick-libreoffice-path'
      )) as LibreOfficeStatus
      if (r.success) {
        setLo({ available: true, path: r.path })
        if (r.preferred !== undefined) setLoPreferred(!!r.preferred)
        setLoPath('')
        setStatus('success', 'LibreOffice located.')
      } else if (!r.canceled) {
        setStatus('error', r.error || 'No LibreOffice found in the selected location.')
      }
    } finally {
      setLoBusy(false)
    }
  }

  const saveLoPath = async (): Promise<void> => {
    if (!loPath.trim()) return
    setLoBusy(true)
    try {
      const r = (await window.electron.ipcRenderer.invoke(
        'set-libreoffice-path',
        loPath.trim()
      )) as LibreOfficeStatus
      if (r.success) {
        setLo({ available: true, path: r.path })
        if (r.preferred !== undefined) setLoPreferred(!!r.preferred)
        setLoPath('')
        setStatus('success', 'LibreOffice path saved.')
      } else {
        setStatus('error', r.error || 'That path is not a LibreOffice installation.')
      }
    } finally {
      setLoBusy(false)
    }
  }

  // ── VS Code ──────────────────────────────────────────────────────────────
  const [vscode, setVscode] = useState<VscodeStatus>({
    available: false,
    path: null,
    extensions: 0
  })
  const [vscodeBusy, setVscodeBusy] = useState(false)
  const [extList, setExtList] = useState<string | null>(null)

  const refreshVscode = useCallback(async (): Promise<void> => {
    setVscodeBusy(true)
    try {
      const r = (await window.electron.ipcRenderer.invoke('vscode-status')) as VscodeStatus
      setVscode(r || { available: false, path: null, extensions: 0 })
    } catch {
      setVscode({ available: false, path: null, extensions: 0 })
    } finally {
      setVscodeBusy(false)
    }
  }, [])

  useEffect(() => {
    void refreshVscode()
  }, [refreshVscode])

  const toggleExtensions = async (): Promise<void> => {
    if (extList !== null) {
      setExtList(null)
      return
    }
    setVscodeBusy(true)
    try {
      const r = await window.electron.ipcRenderer.invoke('vscode-op', {
        action: 'list_extensions'
      })
      setExtList(typeof r === 'string' ? r : 'No extensions found.')
    } finally {
      setVscodeBusy(false)
    }
  }

  const openVscodeFile = async (which: 'settings' | 'keybindings'): Promise<void> => {
    const target = which === 'settings' ? vscode.settingsPath : vscode.keybindingsPath
    if (!target) return
    await window.electron.ipcRenderer.invoke('vscode-op', { action: 'open', path: target })
  }

  // ── Git ──────────────────────────────────────────────────────────────────
  const [gitPath, setGitPath] = useState('')
  const [gitOutput, setGitOutput] = useState<string | null>(null)
  const [gitBusy, setGitBusy] = useState(false)

  const browseGit = async (): Promise<void> => {
    const r = await window.electron.ipcRenderer.invoke('git-pick-folder')
    if (r.success) setGitPath(r.path)
  }

  const runGit = async (action: 'status' | 'log'): Promise<void> => {
    if (!gitPath.trim()) {
      setGitOutput('Pick or enter a project folder first.')
      return
    }
    setGitBusy(true)
    try {
      const r = await window.electron.ipcRenderer.invoke('git-op', {
        action,
        cwd: gitPath.trim(),
        count: 10
      })
      setGitOutput(typeof r === 'string' ? r : JSON.stringify(r))
    } finally {
      setGitBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="Developer Tools"
        description="External programs Brutus can drive on your behalf. All optional."
      />

      <SettingsSection
        title="Document conversion"
        description="LibreOffice converts Office documents at much higher fidelity than the built-in path."
        aside={
          lo.available ? (
            <Badge tone="success" dot>
              Detected
            </Badge>
          ) : (
            <Badge tone="neutral" dot>
              Not found
            </Badge>
          )
        }
      >
        {lo.available && (
          <>
            <SettingsRow
              label="Location"
              description={lo.path ?? undefined}
              control={
                <Button variant="tertiary" size="sm" loading={loBusy} onClick={browseLo}>
                  Change
                </Button>
              }
            />
            <SettingsRow
              htmlFor="lo-preferred"
              label="Prefer LibreOffice"
              description="Use it for every conversion it supports, rather than only where the built-in path fails."
              control={
                <Switch
                  id="lo-preferred"
                  checked={loPreferred}
                  disabled={loBusy}
                  onChange={() => void toggleLoPreference()}
                  aria-label="Prefer LibreOffice"
                />
              }
            />
          </>
        )}
        {!lo.available && (
          <SettingsRow
            stacked
            htmlFor="lo-path"
            label="Point Brutus at LibreOffice"
            description="Give the install folder, the program folder, or soffice.exe directly."
            control={
              <div className="flex items-center gap-2">
                <Input
                  id="lo-path"
                  value={loPath}
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="C:\Program Files\LibreOffice"
                  onChange={(e) => setLoPath(e.target.value)}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  iconOnly
                  aria-label="Browse for LibreOffice"
                  loading={loBusy}
                  onClick={browseLo}
                >
                  {loBusy ? undefined : <RiFolderOpenLine size={15} />}
                </Button>
                <Button size="sm" disabled={!loPath.trim()} loading={loBusy} onClick={saveLoPath}>
                  Save
                </Button>
              </div>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection
        title="VS Code"
        aside={
          vscode.available ? (
            <Badge tone="success" dot>
              {vscode.extensions} extensions
            </Badge>
          ) : (
            <Badge tone="neutral" dot>
              Not found
            </Badge>
          )
        }
      >
        <SettingsRow
          label="Status"
          description={vscode.path ?? 'The `code` command is not on your PATH.'}
          control={
            <Button
              variant="secondary"
              size="sm"
              iconOnly
              aria-label="Re-check VS Code"
              loading={vscodeBusy}
              onClick={() => void refreshVscode()}
            >
              {vscodeBusy ? undefined : <RiRefreshLine size={14} />}
            </Button>
          }
        />
        {vscode.available && (
          <SettingsRow
            label="Configuration"
            description="Open VS Code's own JSON files, or list what is installed."
            control={
              <div className="flex items-center gap-2">
                <Button
                  variant="tertiary"
                  size="sm"
                  disabled={!vscode.settingsPath}
                  onClick={() => void openVscodeFile('settings')}
                >
                  settings.json
                </Button>
                <Button
                  variant="tertiary"
                  size="sm"
                  disabled={!vscode.keybindingsPath}
                  onClick={() => void openVscodeFile('keybindings')}
                >
                  keybindings.json
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={vscodeBusy}
                  onClick={() => void toggleExtensions()}
                >
                  {extList === null ? 'List extensions' : 'Hide'}
                </Button>
              </div>
            }
          />
        )}
        {extList !== null && (
          <div className="px-4 py-3">
            <SettingsOutput>{extList}</SettingsOutput>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Git"
        description="Read-only. Brutus reports status and history; it never commits, pushes or resets from here."
        aside={<Badge tone="info">Safe mode</Badge>}
      >
        <SettingsRow
          stacked
          htmlFor="git-path"
          label="Repository"
          control={
            <div className="flex items-center gap-2">
              <Input
                id="git-path"
                value={gitPath}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder="Project folder (a git repository)…"
                onChange={(e) => setGitPath(e.target.value)}
              />
              <Button
                variant="secondary"
                size="sm"
                iconOnly
                aria-label="Browse for a repository"
                onClick={browseGit}
              >
                <RiFolderOpenLine size={15} />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                loading={gitBusy}
                onClick={() => void runGit('status')}
              >
                Status
              </Button>
              <Button
                variant="secondary"
                size="sm"
                loading={gitBusy}
                onClick={() => void runGit('log')}
              >
                Log
              </Button>
            </div>
          }
        />
        {gitOutput && (
          <div className="px-4 py-3">
            <SettingsOutput>{gitOutput}</SettingsOutput>
          </div>
        )}
      </SettingsSection>

      <SettingsStatus status={status} />
    </div>
  )
}

export default DevToolsPanel
