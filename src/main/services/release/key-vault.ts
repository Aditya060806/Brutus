import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { PROVIDERS, type ProviderId } from './providers'

/**
 * BRUTUS — the multi-provider key vault.
 *
 * The original vault stored exactly two keys, Groq and Gemini, in fixed fields.
 * Supporting six providers by adding four more fields would repeat the mistake,
 * so this is a map keyed by provider id: adding a provider to `PROVIDERS` is all
 * it takes for its key to be storable.
 *
 * ── ENCRYPTION, AND WHAT HAPPENS WITHOUT IT ────────────────────────────────
 * Keys are encrypted with Electron `safeStorage`, which on Windows is DPAPI —
 * tied to the user account, so the file is useless if copied to another machine.
 * When encryption is unavailable (a rare Linux case with no keyring) the value is
 * still stored, base64-encoded and clearly marked `plain`. That is deliberate:
 * silently refusing to save would leave the user unable to use the app at all,
 * and pretending base64 is encryption would be a lie. `isEncrypted()` reports
 * the truth so the UI can warn.
 *
 * ── WHY EXPORT REDACTS BY DEFAULT ──────────────────────────────────────────
 * "Export config" is for moving settings between machines, and a config file
 * that quietly contains live API keys is a credential leak waiting to be pasted
 * into a chat. Export omits secrets unless the caller explicitly opts in, and
 * the UI makes that opt-in a separate, warned choice.
 */

interface VaultFile {
  version: 1
  /** provider id → stored value. */
  keys: Record<string, { value: string; mode: 'encrypted' | 'plain'; savedAt: number }>
  /** Endpoints for the local providers. */
  urls?: Record<string, string>
}

const FILE = 'brutus-keys.json'
/** The two-key vault this replaced. Migrated once, then left alone. */
const LEGACY = 'iris_secure_vault.json'

const vaultPath = (): string => path.join(app.getPath('userData'), FILE)
const legacyPath = (): string => path.join(app.getPath('userData'), LEGACY)

let cache: VaultFile | null = null

const blank = (): VaultFile => ({ version: 1, keys: {}, urls: {} })

export function isEncrypted(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encode(raw: string): { value: string; mode: 'encrypted' | 'plain' } {
  if (isEncrypted()) {
    try {
      return { value: safeStorage.encryptString(raw).toString('base64'), mode: 'encrypted' }
    } catch {
      /* Fall through to plain rather than losing the key entirely. */
    }
  }
  return { value: Buffer.from(raw, 'utf8').toString('base64'), mode: 'plain' }
}

function decode(entry: { value: string; mode: string }): string {
  try {
    if (entry.mode === 'encrypted') {
      return safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
    }
    return Buffer.from(entry.value, 'base64').toString('utf8')
  } catch {
    // A key encrypted by a different Windows account cannot be read here. An
    // empty string makes it look unset, which is exactly what it effectively is.
    return ''
  }
}

/** Pull the old two-key file forward, once. */
function migrateLegacy(into: VaultFile): boolean {
  try {
    if (!fs.existsSync(legacyPath())) return false
    const raw = JSON.parse(fs.readFileSync(legacyPath(), 'utf8')) as Record<string, string>
    let moved = false
    for (const [legacyKey, provider] of [
      ['gemini', 'gemini'],
      ['groq', 'groq']
    ] as const) {
      const stored = raw[legacyKey]
      if (typeof stored !== 'string' || !stored) continue
      // The legacy file used the same encoding scheme, so the payload carries
      // over as-is; only the shape around it changes.
      if (!into.keys[provider]) {
        into.keys[provider] = {
          value: stored,
          mode: isEncrypted() ? 'encrypted' : 'plain',
          savedAt: Date.now()
        }
        moved = true
      }
    }
    return moved
  } catch {
    return false
  }
}

function load(): VaultFile {
  if (cache) return cache
  let file = blank()
  try {
    if (fs.existsSync(vaultPath())) {
      const parsed = JSON.parse(fs.readFileSync(vaultPath(), 'utf8')) as Partial<VaultFile>
      file = {
        version: 1,
        keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
        urls: parsed.urls && typeof parsed.urls === 'object' ? parsed.urls : {}
      }
    } else if (migrateLegacy(file)) {
      persist(file)
    }
  } catch {
    file = blank()
  }
  cache = file
  return file
}

function persist(file: VaultFile): void {
  try {
    fs.mkdirSync(path.dirname(vaultPath()), { recursive: true })
    // Written via a temp file and renamed: a crash mid-write must not leave a
    // truncated vault, which would read as "all keys lost".
    const tmp = `${vaultPath()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, vaultPath())
    cache = file
  } catch {
    /* Reported by the caller's own error path. */
  }
}

export function getKey(provider: ProviderId | string): string {
  const entry = load().keys[provider]
  return entry ? decode(entry) : ''
}

export function setKey(provider: ProviderId | string, raw: string): void {
  const file = load()
  const trimmed = (raw ?? '').trim()
  if (!trimmed) {
    delete file.keys[provider]
  } else {
    file.keys[provider] = { ...encode(trimmed), savedAt: Date.now() }
  }
  persist(file)
}

export function deleteKey(provider: ProviderId | string): void {
  const file = load()
  delete file.keys[provider]
  persist(file)
}

export function getUrl(provider: ProviderId | string): string {
  return load().urls?.[provider] ?? ''
}

export function setUrl(provider: ProviderId | string, url: string): void {
  const file = load()
  file.urls = file.urls ?? {}
  const trimmed = (url ?? '').trim()
  if (!trimmed) delete file.urls[provider]
  else file.urls[provider] = trimmed
  persist(file)
}

export interface KeyStatus {
  provider: string
  label: string
  /** Never the key itself — only whether one exists. */
  present: boolean
  /** e.g. `AIza…9fQ2`, enough to tell two keys apart without exposing either. */
  masked: string
  mode: 'encrypted' | 'plain' | null
  savedAt: number | null
  needsKey: boolean
  local: boolean
  url?: string
}

/**
 * What the Settings panel renders.
 *
 * Returns a mask, never a key. A renderer that never receives the secret cannot
 * leak it through a devtools inspection, a crash dump or a screenshot.
 */
export function keyStatuses(): KeyStatus[] {
  const file = load()
  return PROVIDERS.map((spec) => {
    const entry = file.keys[spec.id]
    const raw = entry ? decode(entry) : ''
    return {
      provider: spec.id,
      label: spec.label,
      present: Boolean(raw),
      masked: raw ? `${raw.slice(0, 4)}${'•'.repeat(6)}${raw.slice(-4)}` : '',
      mode: entry ? entry.mode : null,
      savedAt: entry ? entry.savedAt : null,
      needsKey: spec.needsKey,
      local: Boolean(spec.local),
      url: file.urls?.[spec.id] ?? ''
    }
  })
}

/** Which providers are usable right now — drives "is Brutus configured?". */
export function configuredProviders(): string[] {
  const file = load()
  return PROVIDERS.filter((s) =>
    s.needsKey ? Boolean(file.keys[s.id]) : Boolean(file.urls?.[s.id])
  ).map((s) => s.id)
}

/**
 * The environment fallback.
 *
 * A developer running from source has keys in `.env`; a packaged user does not.
 * Reading the vault first and the environment second means the same code path
 * serves both without the app needing to know which it is.
 */
export function resolveKey(provider: ProviderId | string): string {
  const stored = getKey(provider)
  if (stored) return stored
  const env = process.env
  const map: Record<string, string[]> = {
    gemini: ['GEMINI_API_KEY', 'MAIN_VITE_GEMINI_API_KEY', 'VITE_GEMINI_API_KEY'],
    groq: ['GROQ_API_KEY', 'MAIN_VITE_GROQ_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY']
  }
  for (const name of map[provider] ?? []) {
    const v = env[name]
    if (v && v.trim() && !v.includes('your_')) return v.trim()
  }
  return ''
}

// ─── Config export / import ─────────────────────────────────────────────────

export interface ExportedConfig {
  kind: 'brutus-config'
  version: 1
  exportedAt: string
  appVersion: string
  /** Present only when the user explicitly asked to include secrets. */
  keys?: Record<string, string>
  urls: Record<string, string>
  /** Everything non-secret from electron-store, passed through opaquely. */
  settings: Record<string, unknown>
}

export function exportConfig(
  settings: Record<string, unknown>,
  includeSecrets: boolean
): ExportedConfig {
  const file = load()
  const out: ExportedConfig = {
    kind: 'brutus-config',
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    urls: { ...(file.urls ?? {}) },
    settings
  }
  if (includeSecrets) {
    out.keys = {}
    for (const id of Object.keys(file.keys)) {
      const raw = decode(file.keys[id])
      if (raw) out.keys[id] = raw
    }
  }
  return out
}

export interface ImportResult {
  ok: boolean
  error?: string
  keysImported: number
  urlsImported: number
  settingsImported: number
}

/**
 * Restore an exported config.
 *
 * Validated rather than trusted: this file arrives from another machine, or from
 * whatever a user found in a chat, and it writes API keys and settings.
 */
export function importConfig(
  raw: unknown,
  applySettings: (settings: Record<string, unknown>) => number
): ImportResult {
  const empty = { keysImported: 0, urlsImported: 0, settingsImported: 0 }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'That file is not a Brutus config.', ...empty }
  }
  const cfg = raw as Partial<ExportedConfig>
  if (cfg.kind !== 'brutus-config') {
    return { ok: false, error: 'That file is not a Brutus config.', ...empty }
  }
  if (cfg.version !== 1) {
    return {
      ok: false,
      error: `This config was written by a newer version of Brutus (format ${String(cfg.version)}).`,
      ...empty
    }
  }

  const known = new Set(PROVIDERS.map((p) => p.id) as string[])
  let keysImported = 0
  let urlsImported = 0

  if (cfg.keys && typeof cfg.keys === 'object') {
    for (const [id, value] of Object.entries(cfg.keys)) {
      // An unknown provider id would create a key nothing can ever read.
      if (!known.has(id) || typeof value !== 'string' || !value.trim()) continue
      setKey(id, value)
      keysImported++
    }
  }
  if (cfg.urls && typeof cfg.urls === 'object') {
    for (const [id, value] of Object.entries(cfg.urls)) {
      if (!known.has(id) || typeof value !== 'string' || !value.trim()) continue
      setUrl(id, value)
      urlsImported++
    }
  }

  let settingsImported = 0
  if (cfg.settings && typeof cfg.settings === 'object') {
    try {
      settingsImported = applySettings(cfg.settings as Record<string, unknown>)
    } catch {
      settingsImported = 0
    }
  }

  return { ok: true, keysImported, urlsImported, settingsImported }
}

/** Drop the in-memory copy, so a test or an import is re-read from disk. */
export function resetVaultCacheForTests(): void {
  cache = null
}
