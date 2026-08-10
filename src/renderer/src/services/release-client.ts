/**
 * BRUTUS — renderer client for the release surface.
 *
 * Setup wizard, diagnostics, key manager, config portability, logs and bug
 * reports. Thin by design: every decision lives in main, because main is the
 * side that can reach the filesystem, the OS permission state and the providers.
 *
 * ── THE DEVICE CHECKS ARE THE EXCEPTION ────────────────────────────────────
 * `navigator.mediaDevices` does not exist in the main process, so microphone,
 * speaker and camera presence can only be established here. `deviceChecks()`
 * produces main's own `Check` shape so the two halves compose into one report.
 */

export type ProviderId =
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'groq'
  | 'openrouter'
  | 'ollama'
  | 'brainnode'

export type Verdict = 'ok' | 'bad-key' | 'rate-limited' | 'unreachable' | 'no-key' | 'error'

export interface ProviderSpec {
  id: ProviderId
  label: string
  blurb: string
  needsKey: boolean
  keyUrl?: string
  keyHint?: string
  recommended?: boolean
  local?: boolean
  /** Does a Brutus feature actually route to this provider today? */
  wired: boolean
  /** For unwired providers: what is missing. */
  note?: string
}

export interface TestResult {
  provider: ProviderId
  verdict: Verdict
  message: string
  ms?: number
  detail?: string
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'checking'

export interface Check {
  id: string
  label: string
  status: CheckStatus
  detail: string
  fix?: string
  group: 'system' | 'devices' | 'models' | 'providers' | 'storage'
}

export interface DiagnosticsReport {
  generatedAt: number
  version: string
  platform: string
  arch: string
  electron: string
  node: string
  packaged: boolean
  checks: Check[]
  summary: { ok: number; warn: number; fail: number }
}

export interface KeyStatus {
  provider: string
  label: string
  present: boolean
  masked: string
  mode: 'encrypted' | 'plain' | null
  savedAt: number | null
  needsKey: boolean
  local: boolean
  url?: string
}

export interface SetupState {
  setupComplete: boolean
  configured: string[]
  hasAnyProvider: boolean
  demoMode: boolean
  portable: boolean
  version: string
  previousSession: { crashed: boolean; startedAt?: number; reason?: string }
}

const invoke = async <T>(channel: string, payload?: unknown): Promise<T> =>
  (await window.electron.ipcRenderer.invoke(channel, payload)) as T

// ─── Setup ──────────────────────────────────────────────────────────────────

export const getSetupState = (): Promise<SetupState> => invoke<SetupState>('release-setup-state')

export const completeSetup = (demoMode = false): Promise<{ ok: boolean }> =>
  invoke('release-complete-setup', { demoMode })

export const acknowledgeCrash = (): Promise<{ ok: boolean }> => invoke('release-ack-crash')

export const getProviders = (): Promise<{
  providers: ProviderSpec[]
  configured: string[]
  encryptionAvailable: boolean
}> => invoke('release-providers')

/**
 * Verify a provider.
 *
 * Pass `key` to test something typed but not yet saved — which is what the wizard
 * does, so a key that does not work is never written in the first place. Omit it
 * and the stored key is used, which is what the Settings Test button does.
 */
export const testProvider = (
  provider: ProviderId,
  opts: { key?: string; baseUrl?: string } = {}
): Promise<TestResult> => invoke('release-test-provider', { provider, ...opts })

// ─── Keys ───────────────────────────────────────────────────────────────────

export const getKeys = (): Promise<{ keys: KeyStatus[]; encryptionAvailable: boolean }> =>
  invoke('release-keys')

export const saveKey = (provider: string, key: string): Promise<{ ok: boolean; error?: string }> =>
  invoke('release-save-key', { provider, key })

export const deleteKey = (provider: string): Promise<{ ok: boolean }> =>
  invoke('release-delete-key', { provider })

export const setProviderUrl = (
  provider: string,
  url: string
): Promise<{ ok: boolean; error?: string }> => invoke('release-set-url', { provider, url })

// ─── Diagnostics ────────────────────────────────────────────────────────────

export const runDiagnostics = (): Promise<DiagnosticsReport> => invoke('release-diagnostics')

export const diagnosticsText = (rendererChecks: Check[]): Promise<{ text: string }> =>
  invoke('release-diagnostics-text', { rendererChecks })

/**
 * The checks only the renderer can make.
 *
 * Labels are not readable until permission has been granted at least once, so
 * an empty label is treated as "device present, not yet authorised" rather than
 * as an error — that distinction is the difference between a scary red row and
 * an accurate one.
 */
export async function deviceChecks(): Promise<Check[]> {
  const out: Check[] = []

  const missing = (id: string, label: string, fix: string): Check => ({
    id,
    label,
    status: 'warn',
    detail: 'Not detected',
    fix,
    group: 'devices'
  })

  if (!navigator?.mediaDevices?.enumerateDevices) {
    return [missing('devices', 'Audio and video devices', 'This build cannot enumerate devices.')]
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const mics = devices.filter((d) => d.kind === 'audioinput')
    const speakers = devices.filter((d) => d.kind === 'audiooutput')
    const cams = devices.filter((d) => d.kind === 'videoinput')
    const unlabelled = devices.every((d) => !d.label)

    out.push(
      mics.length
        ? {
            id: 'mic',
            label: 'Microphone',
            status: 'ok',
            group: 'devices',
            detail: unlabelled ? `${mics.length} found (allow access to see names)` : mics[0].label
          }
        : missing('mic', 'Microphone', 'Voice input needs one. Plug in a microphone or headset.')
    )

    out.push(
      speakers.length
        ? {
            id: 'speaker',
            label: 'Speaker',
            status: 'ok',
            group: 'devices',
            detail: unlabelled ? `${speakers.length} found` : speakers[0].label
          }
        : missing('speaker', 'Speaker', 'Brutus cannot be heard without an output device.')
    )

    out.push(
      cams.length
        ? {
            id: 'camera',
            label: 'Camera',
            status: 'ok',
            group: 'devices',
            detail: unlabelled ? `${cams.length} found` : cams[0].label
          }
        : {
            id: 'camera',
            label: 'Camera',
            status: 'warn',
            group: 'devices',
            detail: 'Not detected',
            // Deliberately softer: a camera is optional, unlike audio.
            fix: 'Vision features will be unavailable. Everything else works.'
          }
    )
  } catch (err) {
    out.push({
      id: 'devices',
      label: 'Audio and video devices',
      status: 'warn',
      group: 'devices',
      detail: String((err as { message?: string })?.message ?? err)
    })
  }

  return out
}

// ─── Config, logs, reports ──────────────────────────────────────────────────

export const exportConfig = (
  includeSecrets: boolean
): Promise<{
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
  includedSecrets?: boolean
}> => invoke('release-config-export', { includeSecrets })

export const importConfig = (): Promise<{
  ok: boolean
  canceled?: boolean
  error?: string
  keysImported: number
  urlsImported: number
  settingsImported: number
}> => invoke('release-config-import')

export const getLogs = (): Promise<{
  dir: string
  files: { name: string; path: string; bytes: number; modified: number }[]
}> => invoke('release-logs')

export const openLogs = (): Promise<{ ok: boolean; dir: string }> => invoke('release-open-logs')

export const sendBugReport = (opts: {
  description: string
  includeLogs: boolean
  rendererChecks: Check[]
}): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
  invoke('release-bug-report', opts)

export const getFeatures = (): Promise<{ features: Record<string, boolean> }> =>
  invoke('release-features')

export const setFeature = (
  feature: string,
  enabled: boolean
): Promise<{ ok: boolean; error?: string }> => invoke('release-set-feature', { feature, enabled })

export const openDoc = (name: string): Promise<{ ok: boolean; error?: string; path?: string }> =>
  invoke('release-open-doc', { name })
