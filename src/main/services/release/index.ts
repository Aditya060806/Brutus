import { app, dialog, shell, type BrowserWindow, type IpcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import Store from 'electron-store'
import { formatReport, runDiagnostics, type Check } from './diagnostics'
import { listLogs, logsDirectory, recentLog } from './logger'
import { previousSession, clearMarker } from './crash-guard'
import { PROVIDERS, testProvider, type ProviderId } from './providers'
import {
  configuredProviders,
  deleteKey,
  exportConfig,
  getUrl,
  importConfig,
  isEncrypted,
  keyStatuses,
  resolveKey,
  setKey,
  setUrl
} from './key-vault'

/**
 * BRUTUS — the release surface.
 *
 * Everything a shipped build needs and a development build never did: the setup
 * wizard's provider list and connection tests, diagnostics, the key manager,
 * config portability, logs, and bug reports.
 *
 *   release-providers        the catalogue, for the wizard
 *   release-test-provider    verify one provider for real
 *   release-keys             masked status of every key
 *   release-save-key         store or clear one key
 *   release-delete-key       remove one key
 *   release-set-url          endpoint for a local provider
 *   release-diagnostics      run every main-process check
 *   release-diagnostics-text a pasteable plain-text report
 *   release-config-export    write a config file
 *   release-config-import    read one back
 *   release-logs             list log files
 *   release-open-logs        reveal the folder
 *   release-bug-report       assemble a report with consent
 *   release-setup-state      is Brutus configured, and did it crash last time
 *   release-complete-setup   mark the wizard done
 *   release-portable         is this a portable (USB) run
 *
 * ── WHY A KEY IS NEVER RETURNED TO THE RENDERER ────────────────────────────
 * `release-keys` returns masks. The renderer can show that a key exists, test
 * it, and replace it, but it never holds the secret — so no devtools session,
 * screenshot or renderer crash dump can contain one.
 */

const StoreClass = (Store as unknown as { default?: typeof Store }).default || Store
const store = new StoreClass() as unknown as {
  get: (k: string, d?: unknown) => unknown
  set: (k: string, v: unknown) => void
  delete: (k: string) => void
  store: Record<string, unknown>
}

/** Keys that must never travel in an exported config. */
const NEVER_EXPORT = new Set(['brutus_vault_hash'])

/**
 * Is this a portable run?
 *
 * electron-builder's portable target sets `PORTABLE_EXECUTABLE_DIR`. Detecting it
 * lets the UI say so, and it is the honest answer to "where did my settings go?"
 * when someone moves the stick to another machine.
 */
export function isPortable(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

export interface ReleaseDeps {
  ipcMain: IpcMain
  getWindow: () => BrowserWindow | null
}

export default function registerRelease({ ipcMain, getWindow }: ReleaseDeps): void {
  // ── The wizard ────────────────────────────────────────────────────────────

  ipcMain.handle('release-providers', () => ({
    providers: PROVIDERS,
    configured: configuredProviders(),
    encryptionAvailable: isEncrypted()
  }))

  /**
   * Test a provider.
   *
   * The key may be passed in — the wizard tests what is typed before saving it,
   * because saving something that does not work is how a user ends up with a
   * broken install and no idea which field is wrong. When absent, the stored key
   * is used, which is what the Settings panel's Test button does.
   */
  ipcMain.handle(
    'release-test-provider',
    async (
      _e,
      { provider, key, baseUrl }: { provider?: string; key?: string; baseUrl?: string }
    ) => {
      const id = String(provider ?? '') as ProviderId
      const spec = PROVIDERS.find((p) => p.id === id)
      if (!spec) return { verdict: 'error', message: 'Unknown provider.', provider: id }

      const useKey = typeof key === 'string' && key.trim() ? key : undefined
      const useUrl =
        typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl : getUrl(id) || undefined

      // Falls back to the vault (and then the environment) so Settings can test
      // a key the renderer has never seen. Imported statically: it was also a
      // dynamic import here, which rollup warned about and which bought nothing
      // since the module is already in this bundle.
      const resolved = useKey ?? (spec.needsKey ? resolveKey(id) : '')
      return testProvider({ provider: id, key: resolved, baseUrl: useUrl })
    }
  )

  ipcMain.handle('release-keys', () => ({
    keys: keyStatuses(),
    encryptionAvailable: isEncrypted()
  }))

  ipcMain.handle(
    'release-save-key',
    (_e, { provider, key }: { provider?: string; key?: string }) => {
      const id = String(provider ?? '')
      if (!PROVIDERS.some((p) => p.id === id)) return { ok: false, error: 'Unknown provider.' }
      setKey(id, String(key ?? ''))
      return { ok: true }
    }
  )

  ipcMain.handle('release-delete-key', (_e, { provider }: { provider?: string }) => {
    deleteKey(String(provider ?? ''))
    return { ok: true }
  })

  ipcMain.handle(
    'release-set-url',
    (_e, { provider, url }: { provider?: string; url?: string }) => {
      const id = String(provider ?? '')
      if (!PROVIDERS.some((p) => p.id === id)) return { ok: false, error: 'Unknown provider.' }
      setUrl(id, String(url ?? ''))
      return { ok: true }
    }
  )

  // ── Setup state and crash recovery ────────────────────────────────────────

  ipcMain.handle('release-setup-state', () => {
    const configured = configuredProviders()
    return {
      // The wizard runs until it is explicitly finished, so a user who closes it
      // halfway is offered it again rather than dropped into a dead UI.
      setupComplete: Boolean(store.get('brutus_setup_complete', false)),
      configured,
      hasAnyProvider: configured.length > 0,
      demoMode: Boolean(store.get('brutus_demo_mode', false)),
      portable: isPortable(),
      version: app.getVersion(),
      previousSession: previousSession()
    }
  })

  ipcMain.handle('release-complete-setup', (_e, { demoMode }: { demoMode?: boolean } = {}) => {
    store.set('brutus_setup_complete', true)
    store.set('brutus_demo_mode', Boolean(demoMode))
    return { ok: true }
  })

  /** Acknowledge a crash so the prompt does not reappear on every launch. */
  ipcMain.handle('release-ack-crash', () => {
    clearMarker()
    return { ok: true }
  })

  // ── Diagnostics ───────────────────────────────────────────────────────────

  ipcMain.handle('release-diagnostics', async () => runDiagnostics())

  /**
   * Diagnostics as text, with the renderer's device checks folded in.
   *
   * The renderer passes what only it can see (actual microphone, speaker and
   * camera devices) so the pasteable report is complete rather than silently
   * missing the three things users most often ask about.
   */
  ipcMain.handle(
    'release-diagnostics-text',
    async (_e, { rendererChecks }: { rendererChecks?: Check[] } = {}) => {
      const report = await runDiagnostics()
      const extra = Array.isArray(rendererChecks) ? rendererChecks : []
      return { text: formatReport(report, extra) }
    }
  )

  // ── Logs ──────────────────────────────────────────────────────────────────

  ipcMain.handle('release-logs', () => ({ dir: logsDirectory(), files: listLogs() }))

  ipcMain.handle('release-open-logs', async () => {
    const dir = logsDirectory()
    await shell.openPath(dir)
    return { ok: true, dir }
  })

  // ── Bug report ────────────────────────────────────────────────────────────

  /**
   * Assemble a report and let the user save it.
   *
   * Nothing is transmitted. Brutus has no server to send it to, and quietly
   * uploading a log that may contain file paths and prompts would be a privacy
   * decision made on the user's behalf. They get a file and choose where it goes.
   */
  ipcMain.handle(
    'release-bug-report',
    async (
      _e,
      {
        description,
        includeLogs,
        rendererChecks
      }: { description?: string; includeLogs?: boolean; rendererChecks?: Check[] } = {}
    ) => {
      const report = await runDiagnostics()
      const L: string[] = []
      L.push('BRUTUS BUG REPORT')
      L.push('='.repeat(50))
      L.push('')
      L.push('## What happened')
      L.push(String(description ?? '').trim() || '(no description given)')
      L.push('')
      L.push('## Diagnostics')
      L.push(formatReport(report, Array.isArray(rendererChecks) ? rendererChecks : []))
      L.push('')
      L.push('## Configured providers')
      // Names only. Never the keys.
      L.push(configuredProviders().join(', ') || '(none)')
      L.push('')
      if (includeLogs) {
        L.push('## Recent log')
        L.push('```')
        L.push(recentLog() || '(log is empty)')
        L.push('```')
      } else {
        L.push('## Recent log')
        L.push('(not included — the user chose not to attach it)')
      }

      const win = getWindow()
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const options = {
        title: 'Save bug report',
        defaultPath: `brutus-bug-report-${stamp}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      try {
        fs.writeFileSync(result.filePath, L.join('\n'), 'utf8')
        return { ok: true, path: result.filePath }
      } catch (err) {
        return { ok: false, error: String((err as { message?: string })?.message || err) }
      }
    }
  )

  // ── Config portability ────────────────────────────────────────────────────

  ipcMain.handle(
    'release-config-export',
    async (_e, { includeSecrets }: { includeSecrets?: boolean } = {}) => {
      const settings: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(store.store ?? {})) {
        if (NEVER_EXPORT.has(k)) continue
        settings[k] = v
      }
      const payload = exportConfig(settings, Boolean(includeSecrets))

      const win = getWindow()
      const options = {
        title: includeSecrets ? 'Export config (INCLUDES API KEYS)' : 'Export config',
        defaultPath: `brutus-config-${new Date().toISOString().slice(0, 10)}.brutus`,
        filters: [
          { name: 'Brutus config', extensions: ['brutus'] },
          { name: 'JSON', extensions: ['json'] }
        ]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      try {
        fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8')
        return { ok: true, path: result.filePath, includedSecrets: Boolean(includeSecrets) }
      } catch (err) {
        return { ok: false, error: String((err as { message?: string })?.message || err) }
      }
    }
  )

  ipcMain.handle('release-config-import', async () => {
    const win = getWindow()
    const options = {
      title: 'Import Brutus config',
      properties: ['openFile' as const],
      filters: [
        { name: 'Brutus config', extensions: ['brutus', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const file = result.filePaths?.[0]
    if (result.canceled || !file) return { ok: false, canceled: true }

    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
      const outcome = importConfig(raw, (settings) => {
        let n = 0
        for (const [k, v] of Object.entries(settings)) {
          if (NEVER_EXPORT.has(k)) continue
          store.set(k, v)
          n++
        }
        return n
      })
      return outcome
    } catch (err) {
      return {
        ok: false,
        error: `Could not read that file: ${String((err as { message?: string })?.message || err)}`,
        keysImported: 0,
        urlsImported: 0,
        settingsImported: 0
      }
    }
  })

  // ── Feature toggles (item 14) ──────────────────────────────────────────────

  /**
   * Modules a user can switch off.
   *
   * Stored here rather than scattered per-feature so one call answers "what is
   * enabled?" and the renderer can hide whole tabs rather than showing a view
   * that then fails.
   */
  const FEATURES = ['vision', 'voice', 'robot', 'phone', 'studio', 'desk', 'orchestrator'] as const

  ipcMain.handle('release-features', () => {
    const saved = (store.get('brutus_features', {}) as Record<string, boolean>) ?? {}
    const out: Record<string, boolean> = {}
    // Default on: a fresh install shows everything it can do.
    for (const f of FEATURES) out[f] = saved[f] !== false
    return { features: out }
  })

  ipcMain.handle(
    'release-set-feature',
    (_e, { feature, enabled }: { feature?: string; enabled?: boolean }) => {
      const id = String(feature ?? '')
      if (!(FEATURES as readonly string[]).includes(id)) {
        return { ok: false, error: 'Unknown feature.' }
      }
      const saved = (store.get('brutus_features', {}) as Record<string, boolean>) ?? {}
      saved[id] = Boolean(enabled)
      store.set('brutus_features', saved)
      return { ok: true }
    }
  )

  // ── Documentation (item 21) ────────────────────────────────────────────────

  /**
   * Open a bundled doc.
   *
   * Ships in `resources/docs` via extraResources, so Help works with no network.
   * Falls back to the repo copy in development.
   */
  ipcMain.handle('release-open-doc', async (_e, { name }: { name?: string }) => {
    // A traversal guard, because this joins a renderer-supplied name onto a path.
    const safe = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '')
    if (!safe || !safe.endsWith('.md')) return { ok: false, error: 'Unknown document.' }

    const candidates = [
      path.join(process.resourcesPath ?? '', 'docs', safe),
      path.join(app.getAppPath(), 'docs', safe),
      path.join(app.getAppPath(), '..', '..', 'docs', safe)
    ]
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          await shell.openPath(candidate)
          return { ok: true, path: candidate }
        }
      } catch {
        /* Try the next candidate. */
      }
    }
    return { ok: false, error: 'That document is not bundled with this build.' }
  })
}
