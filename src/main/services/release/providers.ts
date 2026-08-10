/**
 * BRUTUS — AI provider registry and connection testing.
 *
 * The first-run promise is "paste a key, press Test, start working". That only
 * holds if Test tells the truth, so every provider here is verified with a real
 * authenticated request against a real endpoint rather than a regex on the key
 * shape.
 *
 * ── WHY A CHEAP ENDPOINT, NOT A COMPLETION ─────────────────────────────────
 * Validating by generating a token would bill the user to click a button, and on
 * a free tier it can fail for quota reasons while the key is perfectly good —
 * which is the worst possible outcome for a setup wizard, because the user
 * concludes their key is wrong and gives up. Every check below hits a models or
 * key-info endpoint: authenticated, free, and unambiguous.
 *
 * ── WHY THE FAILURES ARE CLASSIFIED ────────────────────────────────────────
 * "Test failed" is useless. A 401 means the key is wrong, a 429 means the key is
 * fine but rate-limited, and a DNS error means the network is down and the key
 * was never seen. Each maps to a different next action for the user, so each is
 * reported differently.
 *
 * Pure except for `fetch`: the classifier and the registry shape are tested
 * without a network in tests/release/test-providers.mjs.
 */

/** Every provider Brutus can reason through. */
export type ProviderId =
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'groq'
  | 'openrouter'
  | 'ollama'
  | 'brainnode'

export type Verdict = 'ok' | 'bad-key' | 'rate-limited' | 'unreachable' | 'no-key' | 'error'

export interface TestResult {
  provider: ProviderId
  verdict: Verdict
  /** One sentence a non-technical user can act on. */
  message: string
  /** Round-trip time, when a response actually arrived. */
  ms?: number
  /** Model count or version, when the endpoint reports it. Proof of life. */
  detail?: string
}

export interface ProviderSpec {
  id: ProviderId
  label: string
  /** What choosing this unlocks, in the wizard's own words. */
  blurb: string
  /** False for local providers, which need a URL instead. */
  needsKey: boolean
  /** Where to get one. Shown as a link in the wizard. */
  keyUrl?: string
  /** Rough shape, used only for a soft hint — never to reject a key. */
  keyHint?: string
  /** Is this the recommended default for a new user? */
  recommended?: boolean
  /** Runs entirely on the user's own machine. */
  local?: boolean
  /**
   * Does an inference path in Brutus actually consume this key today?
   *
   * This exists because it would be trivial — and dishonest — to offer six
   * providers in a setup wizard when only some of them are wired to anything.
   * A user who pastes an OpenAI key, sees "Connected", and then finds nothing
   * uses it has been misled by the setup flow rather than helped by it.
   *
   * `false` means the key is stored and verifiable, and the UI says plainly that
   * routing is not implemented yet. Wiring one up is a change to
   * `orchestrator/model-router.ts`, not to this file.
   */
  wired: boolean
  /** For unwired providers: what is missing, in the UI's own words. */
  note?: string
}

/**
 * The catalogue.
 *
 * Gemini leads because it is the only one whose free tier covers every Brutus
 * feature — voice, vision, Studio's command bar, Deck Studio and the Knowledge
 * Graph all currently speak Gemini — so recommending anything else to a first
 * run would leave features visibly dead.
 */
export const PROVIDERS: ProviderSpec[] = [
  // ── Wired: these drive Brutus today ──────────────────────────────────────
  {
    id: 'gemini',
    label: 'Google Gemini',
    blurb:
      'Recommended. Drives voice, vision, chat, Studio\u2019s command bar, Deck Studio and the Knowledge Graph. Free tier available.',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'Usually starts with AIza',
    recommended: true,
    wired: true
  },
  {
    id: 'groq',
    label: 'Groq',
    blurb: 'Very fast text. Drives the multi-agent Orchestrator and Deep Research.',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'Usually starts with gsk_',
    wired: true
  },
  {
    id: 'brainnode',
    label: 'Brutus Brain Node',
    blurb:
      'The Snapdragon edge server on your network. Drives the offline voice loop. No key, nothing leaves your LAN.',
    needsKey: false,
    local: true,
    wired: true
  },

  // ── Storable and verifiable, but no routing yet ──────────────────────────
  // Kept because the key manager should hold every credential a user has, and
  // because Test proves the key before anyone depends on it. The note is what
  // stops this being a promise Brutus does not keep.
  {
    id: 'openai',
    label: 'OpenAI',
    blurb: 'Chat and reasoning through the OpenAI API.',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Usually starts with sk-',
    wired: false,
    note: 'Stored and verified, but no Brutus feature routes to OpenAI yet. Use Gemini or Groq to get started.'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    blurb: 'Claude models through the Anthropic API.',
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'Usually starts with sk-ant-',
    wired: false,
    note: 'Stored and verified, but no Brutus feature routes to Anthropic yet. Studio runs the Claude Code CLI on your subscription instead \u2014 that needs no key.'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    blurb: 'One key, many models routed on your behalf.',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'Usually starts with sk-or-',
    wired: false,
    note: 'Stored and verified, but no Brutus feature routes to OpenRouter yet.'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    blurb: 'Models running on this machine. No key, no account, works offline.',
    needsKey: false,
    local: true,
    wired: false,
    note: 'Detected and verified, but no Brutus feature routes to Ollama yet. For a fully local brain, use the Brain Node.'
  }
]

export const providerById = (id: string): ProviderSpec | undefined =>
  PROVIDERS.find((p) => p.id === id)

/** Default endpoints for the two local providers. */
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
export const DEFAULT_BRAIN_URL = 'http://127.0.0.1:8080'

/**
 * Turn an HTTP status into a verdict and a sentence.
 *
 * Separated from the request so every provider classifies identically and so the
 * mapping can be asserted without a network.
 */
export function classifyStatus(status: number, label: string): TestResult['verdict'] {
  if (status === 200 || status === 201) return 'ok'
  if (status === 401 || status === 403) return 'bad-key'
  if (status === 429) return 'rate-limited'
  // 400 from a models endpoint almost always means a malformed key was rejected
  // before authentication proper — Gemini in particular does this.
  if (status === 400) return 'bad-key'
  if (status >= 500) return 'unreachable'
  void label
  return 'error'
}

export function messageFor(verdict: TestResult['verdict'], label: string): string {
  switch (verdict) {
    case 'ok':
      return `Connected to ${label}.`
    case 'bad-key':
      return `${label} rejected that key. Check for a stray space or a copy that cut off early.`
    case 'rate-limited':
      return `The key works, but ${label} is rate-limiting it right now. Try again in a minute.`
    case 'unreachable':
      return `Could not reach ${label}. Check your internet connection or a firewall.`
    case 'no-key':
      return `No key saved for ${label} yet.`
    default:
      return `${label} returned something unexpected.`
  }
}

/** A network failure never carries a status, so it is classified separately. */
function classifyNetworkError(err: unknown, label: string): TestResult {
  const raw = String((err as { message?: string })?.message ?? err)
  const lower = raw.toLowerCase()
  if (lower.includes('abort') || lower.includes('timeout')) {
    return {
      provider: 'gemini',
      verdict: 'unreachable',
      message: `${label} did not answer in time. It may be down, or your connection is very slow.`
    }
  }
  if (
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('getaddrinfo') ||
    lower.includes('dns')
  ) {
    return {
      provider: 'gemini',
      verdict: 'unreachable',
      message: `Cannot resolve ${label}. You appear to be offline.`
    }
  }
  if (lower.includes('econnrefused')) {
    return {
      provider: 'gemini',
      verdict: 'unreachable',
      message: `Nothing is listening at that address. Is ${label} running?`
    }
  }
  return { provider: 'gemini', verdict: 'unreachable', message: `Could not reach ${label}.` }
}

/** How long any single check may take before it is called a failure. */
const TIMEOUT_MS = 12_000

async function probe(
  url: string,
  init: RequestInit,
  timeoutMs = TIMEOUT_MS
): Promise<{ status: number; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    // Bodies are read for the detail line, and capped: a models list can be
    // hundreds of kilobytes and none of it needs to reach memory twice.
    const body = (await res.text()).slice(0, 20_000)
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/** Count models in an OpenAI-shaped `{ data: [...] }` response. */
function countModels(body: string, key = 'data'): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const list = parsed[key]
    if (Array.isArray(list)) return `${list.length} models available`
  } catch {
    /* A non-JSON 200 is still a pass; the detail line is a bonus. */
  }
  return undefined
}

export interface TestInput {
  provider: ProviderId
  key?: string
  /** For ollama and brainnode. */
  baseUrl?: string
}

/**
 * Verify one provider.
 *
 * Never throws: a wizard step that crashes is worse than one that reports a
 * failure, so every path returns a `TestResult`.
 */
export async function testProvider(input: TestInput): Promise<TestResult> {
  const spec = providerById(input.provider)
  if (!spec) {
    return { provider: input.provider, verdict: 'error', message: 'Unknown provider.' }
  }

  const key = (input.key ?? '').trim()
  if (spec.needsKey && !key) {
    return { provider: spec.id, verdict: 'no-key', message: messageFor('no-key', spec.label) }
  }

  const started = Date.now()
  try {
    let status = 0
    let body = ''
    let detail: string | undefined

    switch (spec.id) {
      case 'gemini': {
        // The key rides in the header rather than the query string so it cannot
        // end up in a proxy log or a crash report URL.
        const r = await probe('https://generativelanguage.googleapis.com/v1beta/models', {
          method: 'GET',
          headers: { 'x-goog-api-key': key }
        })
        status = r.status
        body = r.body
        detail = countModels(body, 'models')
        break
      }
      case 'openai': {
        const r = await probe('https://api.openai.com/v1/models', {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` }
        })
        status = r.status
        body = r.body
        detail = countModels(body)
        break
      }
      case 'anthropic': {
        // `anthropic-version` is mandatory; without it the API answers 400 and
        // a good key would be reported as bad.
        const r = await probe('https://api.anthropic.com/v1/models', {
          method: 'GET',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        })
        status = r.status
        body = r.body
        detail = countModels(body)
        break
      }
      case 'groq': {
        const r = await probe('https://api.groq.com/openai/v1/models', {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` }
        })
        status = r.status
        body = r.body
        detail = countModels(body)
        break
      }
      case 'openrouter': {
        // `/key` reflects the key's own limits, so a 200 proves the key itself
        // rather than only proving the public catalogue is reachable.
        const r = await probe('https://openrouter.ai/api/v1/key', {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` }
        })
        status = r.status
        body = r.body
        break
      }
      case 'ollama': {
        const base = (input.baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '')
        // Local, so a long timeout only delays the obvious.
        const r = await probe(`${base}/api/tags`, { method: 'GET' }, 4000)
        status = r.status
        body = r.body
        detail = countModels(body, 'models')
        if (status === 200 && detail === '0 models available') {
          return {
            provider: spec.id,
            verdict: 'ok',
            ms: Date.now() - started,
            message: 'Ollama is running, but has no models pulled yet. Try `ollama pull llama3`.',
            detail
          }
        }
        break
      }
      case 'brainnode': {
        const base = (input.baseUrl || DEFAULT_BRAIN_URL).replace(/\/+$/, '')
        const r = await probe(`${base}/health`, { method: 'GET' }, 6000)
        status = r.status
        body = r.body
        // The node reports `degraded` when it is serving but missing a model,
        // which is a pass with a caveat rather than a failure.
        if (status === 200 && body.toLowerCase().includes('degraded')) {
          return {
            provider: spec.id,
            verdict: 'ok',
            ms: Date.now() - started,
            message: 'Brain Node is reachable but reports one model missing (degraded).',
            detail: 'degraded'
          }
        }
        break
      }
    }

    const verdict = classifyStatus(status, spec.label)
    return {
      provider: spec.id,
      verdict,
      ms: Date.now() - started,
      message: messageFor(verdict, spec.label),
      detail
    }
  } catch (err) {
    const classified = classifyNetworkError(err, spec.label)
    return { ...classified, provider: spec.id, ms: Date.now() - started }
  }
}
