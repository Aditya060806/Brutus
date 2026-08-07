import { IpcMain, app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import Store from 'electron-store'
import { GoogleGenAI } from '@google/genai'

/**
 * BRUTUS LLM Provider Adapter
 * ---------------------------
 * The Command PC does NO inference of its own. This adapter is the single
 * gateway every conversational text request goes through:
 *
 *   • Brain Node routing OFF (the default) → Gemini (cloud) answers every
 *     request. This is the out-of-the-box behaviour so the app works without any
 *     local/edge inference or a reachable Brain Node.
 *   • Brain Node routing ON → an explicit, operator-chosen mode where EVERY
 *     request is served by the Snapdragon "Brain Node" (OpenAI-shaped /v1/chat,
 *     Qwen on the NPU) and nothing silently escapes to a cloud API. If the node
 *     is unreachable we re-probe, retry once, then surface an honest error — we
 *     do NOT fall back to Gemini behind the operator's back. Turn this on in
 *     Settings → API Keys → Brain Node only when an edge node is actually up.
 *
 * UI-generation features (Live Forge website builder, Architect) deliberately do
 * NOT go through routing — they call Gemini directly and only borrow
 * `resolveGeminiKey` from here so a key is always available. A small edge model
 * can't produce that class of output, so those stay Gemini-only by design.
 *
 * The real-time voice loop (Gemini Live) is intentionally untouched: the Brain
 * Node's /v1/chat exposes neither native audio nor function-calling, so routing
 * the 90-tool loop there would silently break tools. That is a separate pipeline.
 *
 * Config resolution (highest priority first):
 *   Brain URL    : env BRUTUS_BRAIN_URL   → stored config → http://10.113.246.106:8080 (LAN device)
 *   Brain key    : env BRUTUS_API_KEY     → stored config → "" (open node)
 *   Routing flag : env BRUTUS_LLM_ROUTING → stored config → disabled (cloud default)
 *   Gemini key   : caller-passed          → env GEMINI_API_KEY → encrypted vault
 */

// ─── Types ────────────────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  text: string
  emotion: string | null
  backend: 'brain' | 'gemini' | 'none'
  metrics?: unknown
  error?: string
}

export interface BrainConfig {
  baseUrl: string
  apiKey: string
  enabled: boolean
  healthTimeoutMs: number
  chatTimeoutMs: number
}

interface HealthResult {
  ok: boolean
  ts: number
  data: any
}

// ─── Store (lazy — constructed on first use, after app is ready) ────────────
let _store: any = null
function getStore(): any {
  if (!_store) {
    const StoreClass: any = (Store as any).default || Store
    _store = new StoreClass()
  }
  return _store
}

const CONFIG_KEY = 'brutus_brain_config'

function parseBoolEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null
  const v = value.trim().toLowerCase()
  if (['off', 'false', '0', 'no'].includes(v)) return false
  if (['on', 'true', '1', 'yes'].includes(v)) return true
  return null
}

export function getBrainConfig(): BrainConfig {
  let saved: Partial<BrainConfig> = {}
  try {
    saved = (getStore().get(CONFIG_KEY) as Partial<BrainConfig>) || {}
  } catch {
    saved = {}
  }

  // Defaults to the Snapdragon Brain Node on the LAN. Override any time via the
  // BRUTUS_BRAIN_URL env var or the Settings → API Keys → Brain Node field.
  const baseUrl = (process.env.BRUTUS_BRAIN_URL || saved.baseUrl || 'http://10.113.246.106:8080')
    .trim()
    .replace(/\/+$/, '')

  const apiKey = (process.env.BRUTUS_API_KEY || saved.apiKey || '').trim()

  const envRouting = parseBoolEnv(process.env.BRUTUS_LLM_ROUTING)
  const enabled =
    envRouting !== null ? envRouting : saved.enabled !== undefined ? saved.enabled : false

  // Floor on the health probe. On venue Wi-Fi the first TCP connect to the LAN
  // node can eat ~2.4s on its own, and a full /health round-trip lands around
  // ~3.5s. Anything under ~8s makes a perfectly healthy node read as OFFLINE on
  // the first hit, so we clamp up even when an older stored config asked for
  // something shorter (early builds saved 2500 here). A truly down node still
  // reports fast enough because the result is cached for HEALTH_TTL_MS.
  const MIN_HEALTH_TIMEOUT_MS = 8000
  const savedHealthTimeout =
    typeof saved.healthTimeoutMs === 'number' && saved.healthTimeoutMs > 0
      ? saved.healthTimeoutMs
      : MIN_HEALTH_TIMEOUT_MS
  const healthTimeoutMs = Math.max(savedHealthTimeout, MIN_HEALTH_TIMEOUT_MS)
  const chatTimeoutMs =
    typeof saved.chatTimeoutMs === 'number' && saved.chatTimeoutMs > 0 ? saved.chatTimeoutMs : 30000

  return { baseUrl, apiKey, enabled, healthTimeoutMs, chatTimeoutMs }
}

export function setBrainConfig(patch: Partial<BrainConfig>): BrainConfig {
  const current = getBrainConfig()
  const next: BrainConfig = { ...current, ...patch }
  if (typeof next.baseUrl === 'string') next.baseUrl = next.baseUrl.trim().replace(/\/+$/, '')
  try {
    getStore().set(CONFIG_KEY, {
      baseUrl: next.baseUrl,
      apiKey: next.apiKey,
      enabled: next.enabled,
      healthTimeoutMs: next.healthTimeoutMs,
      chatTimeoutMs: next.chatTimeoutMs
    })
  } catch {
    /* non-fatal — env/defaults still apply */
  }
  healthCache = null // force a fresh probe against the (possibly new) endpoint
  return getBrainConfig()
}

// ─── Low-level Brain Node fetch (bearer auth + abort timeout) ───────────────
async function brainFetch(pathname: string, init: any, timeoutMs: number): Promise<Response> {
  const cfg = getBrainConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { ...(init?.headers || {}) }
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`
    return await fetch(`${cfg.baseUrl}${pathname}`, {
      ...init,
      headers,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

// ─── Health (cached, short TTL so a down node doesn't add latency per call) ──
let healthCache: HealthResult | null = null
const HEALTH_TTL_MS = 10000

export async function checkBrainHealth(force = false): Promise<HealthResult> {
  if (!force && healthCache && Date.now() - healthCache.ts < HEALTH_TTL_MS) {
    return healthCache
  }
  const cfg = getBrainConfig()
  try {
    const res = await brainFetch('/health', { method: 'GET' }, cfg.healthTimeoutMs)
    if (!res.ok) throw new Error(`/health returned ${res.status}`)
    const data = await res.json()
    healthCache = { ok: true, ts: Date.now(), data }
  } catch (err) {
    healthCache = { ok: false, ts: Date.now(), data: { error: String(err) } }
  }
  return healthCache
}

/** Is the Brain Node's LLM backend ready to serve chat? */
function brainChatReady(data: any): boolean {
  if (!data) return false
  if (data.backends_loaded && typeof data.backends_loaded.llm === 'boolean') {
    return data.backends_loaded.llm === true
  }
  // Fallback if the report shape differs: accept anything that isn't "starting".
  return data.status === 'ok' || data.status === 'degraded'
}

// ─── Emotion tag parsing ("[EMOTION:happy] Hi" → { happy, "Hi" }) ───────────
export function parseEmotion(text: string): { text: string; emotion: string | null } {
  if (!text) return { text: '', emotion: null }
  const m = text.match(/^\s*\[EMOTION:\s*([a-zA-Z_]+)\s*\]\s*/i)
  if (m) return { emotion: m[1].toLowerCase(), text: text.slice(m[0].length) }
  return { text, emotion: null }
}

// ─── Gemini key resolution (passed → env → encrypted local vault) ───────────
export function resolveGeminiKey(passed?: string): string {
  const p = (passed || '').trim()
  if (p) return p

  const env = (process.env.GEMINI_API_KEY || process.env.BRUTUS_GEMINI_API_KEY || '').trim()
  if (env) return env

  try {
    const vaultPath = path.join(app.getPath('userData'), 'iris_secure_vault.json')
    if (fs.existsSync(vaultPath)) {
      const data = JSON.parse(fs.readFileSync(vaultPath, 'utf8'))
      if (data?.gemini) {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(data.gemini, 'base64')).trim()
        }
        return Buffer.from(data.gemini, 'base64').toString('utf8').trim()
      }
    }
  } catch {
    /* ignore — treated as "no key" */
  }
  return ''
}

// ─── Backends ───────────────────────────────────────────────────────────────
interface RunChatOptions {
  messages: ChatMessage[]
  systemInstruction?: string
  geminiKey?: string
  maxTokens?: number
  temperature?: number
}

async function brainChat(opts: RunChatOptions): Promise<Omit<ChatResult, 'backend'>> {
  const cfg = getBrainConfig()
  const finalMessages: ChatMessage[] = []
  if (opts.systemInstruction && opts.systemInstruction.trim()) {
    finalMessages.push({ role: 'system', content: opts.systemInstruction })
  }
  finalMessages.push(...opts.messages)

  const body: Record<string, unknown> = { messages: finalMessages, stream: false, raw: false }
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature

  const res = await brainFetch(
    '/v1/chat',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    cfg.chatTimeoutMs
  )
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Brain Node /v1/chat ${res.status}: ${errText.slice(0, 200)}`)
  }
  const json: any = await res.json()
  const raw = json?.choices?.[0]?.message?.content ?? ''
  const parsed = parseEmotion(String(raw))
  return {
    text: parsed.text,
    emotion: json?.brutus?.emotion || parsed.emotion,
    metrics: json?.brutus || null
  }
}

async function geminiChat(
  opts: RunChatOptions & { apiKey: string }
): Promise<Omit<ChatResult, 'backend'>> {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey })

  const contents = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content ?? '') }]
    }))
    .filter((c) => c.parts[0].text.trim())

  const config: any = {}
  if (opts.systemInstruction && opts.systemInstruction.trim()) {
    config.systemInstruction = opts.systemInstruction
  }
  if (typeof opts.temperature === 'number') config.temperature = opts.temperature
  if (typeof opts.maxTokens === 'number') config.maxOutputTokens = opts.maxTokens

  // Newest first. Google has started returning 404 "no longer available to new
  // users" for gemini-2.5-flash on recently-created keys, which silently broke
  // every text-chat fallback, so we try a chain instead of one hard-coded id and
  // only give up once every candidate is refused.
  const MODELS = ['gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-2.5-flash']
  let lastErr: unknown = null

  for (const model of MODELS) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents,
        config: Object.keys(config).length ? config : undefined
      })
      const text = typeof res.text === 'string' ? res.text : ''
      const parsed = parseEmotion(text)
      return { text: parsed.text, emotion: parsed.emotion, metrics: null }
    } catch (err) {
      lastErr = err
      const msg = String((err as { message?: string })?.message || err)
      // Only walk the chain for "this model is gone"; a key or quota problem
      // will fail identically on every candidate, so fail fast instead.
      if (!/not_found|404|no longer available|not found/i.test(msg)) throw err
      console.warn(`[LLM] Gemini model ${model} unavailable, trying next:`, msg.slice(0, 160))
    }
  }
  throw lastErr ?? new Error('No usable Gemini model for this API key.')
}

/**
 * The orchestrator: Brain Node primary, Gemini fallback. Never throws — always
 * resolves to a ChatResult (with `error` set when neither backend can answer).
 */
export async function runChat(opts: RunChatOptions): Promise<ChatResult> {
  const cfg = getBrainConfig()

  // ── Edge-only path (opt-in) ───────────────────────────────────────────────
  // Routing on means the Qwen Brain Node answers EVERY request. No cloud API is
  // ever touched here: if the node is down we re-probe, retry the chat once, and
  // then return an honest error instead of quietly leaking the prompt to Gemini.
  if (cfg.enabled) {
    let health = await checkBrainHealth()
    if (!health.ok || !brainChatReady(health.data)) {
      // A cold first hit on venue Wi-Fi can time out; force one fresh probe.
      health = await checkBrainHealth(true)
    }
    if (!health.ok || !brainChatReady(health.data)) {
      return {
        text: '',
        emotion: null,
        backend: 'none',
        error:
          `Brain Node unreachable at ${cfg.baseUrl}. Edge-only routing is on, so no cloud ` +
          `fallback was used. Confirm the Qwen server is running and reachable, then retry.`
      }
    }

    // Node is healthy — run the chat, with a single retry on a transient error.
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await brainChat(opts)
        return { ...r, backend: 'brain' }
      } catch (err) {
        lastErr = err
        healthCache = null // don't trust a stale "ok" after a mid-request failure
        console.error(`[LLM] Brain Node chat attempt ${attempt}/2 failed:`, err)
      }
    }
    return {
      text: '',
      emotion: null,
      backend: 'none',
      error:
        `Brain Node chat failed after a retry (edge-only routing, no cloud fallback): ` +
        String(lastErr)
    }
  }

  // ── Cloud path (default) ──────────────────────────────────────────────────
  // Reached whenever Brain Node routing is OFF (the default). Gemini answers the
  // request. Routing is only ON when the operator deliberately enables it.
  const key = resolveGeminiKey(opts.geminiKey)
  if (!key) {
    return {
      text: '',
      emotion: null,
      backend: 'none',
      error:
        'Brain Node routing is turned off and no Gemini key is configured, so there is no ' +
        'backend to answer. Turn routing back on to use the local Qwen node.'
    }
  }
  try {
    const r = await geminiChat({ ...opts, apiKey: key })
    return { ...r, backend: 'gemini' }
  } catch (err) {
    return { text: '', emotion: null, backend: 'none', error: String(err) }
  }
}

// ─── Brain Node speech endpoints (foundation for the future voice pipeline) ──
export async function brainTts(
  text: string,
  opts?: { voice?: string | null; speed?: number | null }
): Promise<{ base64: string; sampleRate: number }> {
  const cfg = getBrainConfig()
  const res = await brainFetch(
    '/tts',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: opts?.voice ?? null,
        speed: opts?.speed ?? null,
        format: 'wav'
      })
    },
    cfg.chatTimeoutMs
  )
  if (!res.ok) throw new Error(`Brain Node /tts ${res.status}`)
  const ab = await res.arrayBuffer()
  const sampleRate = Number(res.headers.get('X-Sample-Rate')) || 24000
  return { base64: Buffer.from(ab).toString('base64'), sampleRate }
}

export async function brainAsr(wavBase64: string): Promise<{ text: string; info?: unknown }> {
  const cfg = getBrainConfig()
  const buf = Buffer.from(wavBase64, 'base64')

  // Use the runtime globals (undici) via loose typing so we don't depend on DOM
  // lib types in the Node tsconfig.
  const FormDataCtor: any = (globalThis as any).FormData
  const BlobCtor: any = (globalThis as any).Blob
  const form = new FormDataCtor()
  form.append('file', new BlobCtor([buf], { type: 'audio/wav' }), 'audio.wav')

  const res = await brainFetch('/asr', { method: 'POST', body: form }, cfg.chatTimeoutMs)
  if (!res.ok) throw new Error(`Brain Node /asr ${res.status}`)
  return await res.json()
}

// ─── IPC registration ───────────────────────────────────────────────────────
export default function registerLlmProvider({ ipcMain }: { ipcMain: IpcMain }): void {
  // Live status for the dashboard / heartbeat tile.
  ipcMain.handle('brain-health', async () => {
    const cfg = getBrainConfig()
    const health = await checkBrainHealth(true)
    return {
      enabled: cfg.enabled,
      baseUrl: cfg.baseUrl,
      reachable: health.ok,
      chatReady: health.ok && brainChatReady(health.data),
      health: health.data
    }
  })

  ipcMain.handle('llm-config-get', () => getBrainConfig())

  ipcMain.handle('llm-config-set', (_event, patch: Partial<BrainConfig>) => {
    return setBrainConfig(patch || {})
  })

  // Unified chat with automatic fallback — usable by any renderer feature.
  ipcMain.handle('llm-chat', async (_event, payload: RunChatOptions) => {
    try {
      const result = await runChat(payload || ({ messages: [] } as RunChatOptions))
      return { success: !result.error, ...result }
    } catch (err) {
      return { success: false, text: '', emotion: null, backend: 'none', error: String(err) }
    }
  })

  ipcMain.handle('brain-tts', async (_event, { text, voice, speed }: any) => {
    try {
      const r = await brainTts(String(text || ''), { voice, speed })
      return { success: true, ...r }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('brain-asr', async (_event, { wavBase64 }: any) => {
    try {
      const r = await brainAsr(String(wavBase64 || ''))
      return { success: true, ...r }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── On-device speech ──────────────────────────────────────────────────────
  // Deliberately shaped identically to `brain-asr` / `brain-tts` above. The
  // voice loop picks between them by channel name alone (see `speechChannel()`
  // in Brutus-voice-ai.ts), so any difference in the response shape here would
  // surface as a bug in the caller rather than as a clear error.
  //
  // Imported lazily: `local-asr` pulls in onnxruntime, which is ~100 MB of
  // native library. Requiring it at startup would slow every launch for a
  // feature most users have not enabled.
  ipcMain.handle('local-asr', async (_event, { wavBase64 }: any) => {
    try {
      const { transcribe } = await import('./voice/local-asr')
      const r = await transcribe(String(wavBase64 || ''))
      return { success: true, ...r }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  /** Model presence + provenance, for the voice settings panel. */
  ipcMain.handle('local-voice-status', async () => {
    try {
      const asr = await import('./voice/local-asr')
      return {
        success: true,
        asr: {
          present: asr.isAsrModelPresent(),
          source: asr.asrModelSource(),
          id: asr.ASR_MODEL_ID
        }
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  /**
   * Load the models and measure real transcription latency on THIS machine.
   *
   * On-device speech is only pleasant if it is fast, and that depends entirely
   * on the user's CPU — so the setup step measures it rather than promising a
   * number the developer's laptop produced.
   */
  ipcMain.handle('local-voice-warmup', async () => {
    try {
      const { warmUp } = await import('./voice/local-asr')
      return { success: true, ...(await warmUp()) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
