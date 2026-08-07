/**
 * BRUTUS Orchestrator — model router
 * -----------------------------------
 * Agents ask for a *role* ("plan", "research", "worker", "fast"), never a model
 * id. Each role resolves to an ordered chain of candidates spanning providers,
 * and the router walks the chain until one answers.
 *
 * Why chains instead of one model per role:
 *   • Free-tier model ids come and go. An unknown-model error degrades to the
 *     next candidate instead of killing a whole multi-agent run.
 *   • Groq rate limits are per-key AND per-model. Falling through to a second
 *     Groq model, then another provider, keeps a run alive under load.
 *   • The Groq key pool absorbs 429s first (retry the same call on another
 *     key); only when every key is cooling do we leave the provider.
 *
 * Providers (all four SDKs are already dependencies of this project):
 *   groq        — primary workers. openai/gpt-oss-120b for long-context research.
 *   gemini      — planning and final synthesis.
 *   huggingface — OpenAI-compatible router as a broad fallback.
 *   edge        — runChat(), so the Brain Node toggle is still honoured.
 */
import Groq from 'groq-sdk'
import { GoogleGenAI } from '@google/genai'
import { KeyPool, isRateLimitError, type KeyPoolStatus } from './key-pool'
import { resolveGeminiKey, runChat } from '../llm-provider'
import type {
  LlmRequest,
  LlmResponse,
  ModelCandidate,
  ModelRole,
  OrchestratorConfig,
  ProviderName
} from './types'

/**
 * Default chains. Every id is overridable from Settings, so a model that
 * disappears from a free tier can be swapped without touching code.
 *
 * openai/gpt-oss-120b carries a 131k context on Groq, which is what makes the
 * research role viable: eight full Tavily pages fit in a single call.
 */
/**
 * Gemini candidates, newest first.
 *
 * `gemini-2.5-flash` now returns 404 "no longer available to new users" on
 * newer API keys, so it can no longer be a sole Gemini option — it stays only
 * as a last resort for older keys where it still resolves.
 */
const GEMINI_CHAIN: ModelCandidate[] = [
  { provider: 'gemini', model: 'gemini-3-flash-preview', contextTokens: 1_000_000 },
  { provider: 'gemini', model: 'gemini-flash-latest', contextTokens: 1_000_000 },
  { provider: 'gemini', model: 'gemini-2.5-flash', contextTokens: 1_000_000 }
]

const GROQ_BIG: ModelCandidate = {
  provider: 'groq',
  model: 'openai/gpt-oss-120b',
  contextTokens: 131_072
}
const GROQ_70B: ModelCandidate = {
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
  contextTokens: 128_000
}

const CHAINS: Record<ModelRole, ModelCandidate[]> = {
  // Groq leads here: it is the key the operator actually configured for agents,
  // and Gemini availability varies by account age.
  plan: [GROQ_BIG, GROQ_70B, ...GEMINI_CHAIN],
  research: [GROQ_BIG, GROQ_70B, ...GEMINI_CHAIN],
  worker: [
    GROQ_70B,
    { provider: 'groq', model: 'qwen/qwen3-32b', contextTokens: 131_072 },
    GROQ_BIG,
    { provider: 'huggingface', model: 'meta-llama/Llama-3.3-70B-Instruct' },
    ...GEMINI_CHAIN
  ],
  fast: [
    { provider: 'groq', model: 'llama-3.1-8b-instant', contextTokens: 131_072 },
    GROQ_70B,
    ...GEMINI_CHAIN
  ],
  vision: [
    { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
    ...GEMINI_CHAIN
  ],
  synth: [GROQ_BIG, GROQ_70B, ...GEMINI_CHAIN],
  edge: [{ provider: 'edge', model: 'brain-node' }]
}

/**
 * Longest we will pause for a rate-limited key before giving up on Groq. Groq's
 * free-tier windows reset in seconds, so waiting beats failing the task.
 */
const MAX_COOLDOWN_WAIT_MS = 25_000

/** Errors that mean "this model id is wrong/gone" — skip to the next candidate. */
function isModelError(err: unknown): boolean {
  const e = err as { status?: number; message?: string }
  if (e?.status === 404) return true
  const msg = String(e?.message || err || '').toLowerCase()
  return (
    msg.includes('model_not_found') ||
    msg.includes('does not exist') ||
    msg.includes('decommissioned') ||
    msg.includes('not found') ||
    msg.includes('unknown model')
  )
}

export class ModelRouter {
  private pool = new KeyPool()
  private config: OrchestratorConfig

  constructor(config: OrchestratorConfig) {
    this.config = config
    this.pool.setMinInterval(config.minKeyIntervalMs ?? 2100)
    this.pool.setKeys(config.groqKeys)
  }

  updateConfig(config: OrchestratorConfig): void {
    this.config = config
    this.pool.setMinInterval(config.minKeyIntervalMs ?? 2100)
    this.pool.setKeys(config.groqKeys)
  }

  keyPoolStatus(): KeyPoolStatus {
    return this.pool.status()
  }

  /** The chain for a role, with any Settings override applied to the head. */
  private chainFor(role: ModelRole): ModelCandidate[] {
    const base = CHAINS[role] ?? CHAINS.worker
    const override = this.config.modelOverrides?.[role]
    if (!override) return base
    // An override becomes the first candidate; the defaults stay as fallbacks.
    const head: ModelCandidate = { provider: base[0]?.provider ?? 'groq', model: override }
    return [head, ...base.filter((c) => c.model !== override)]
  }

  /** Context budget of the winning candidate, so callers can size evidence. */
  contextFor(role: ModelRole): number {
    return this.chainFor(role)[0]?.contextTokens ?? 32_000
  }

  /**
   * Run a request against the chain for its role.
   * Throws only when EVERY candidate failed; the error names each attempt.
   */
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now()
    const attempts: LlmResponse['attempts'] = []
    const chain = this.chainFor(req.role)

    for (const candidate of chain) {
      if (req.signal?.aborted) throw new Error('cancelled')
      try {
        const text = await this.callProvider(candidate, req)
        if (!text || !text.trim()) throw new Error('empty response')
        return {
          text,
          provider: candidate.provider,
          model: candidate.model,
          attempts,
          elapsedMs: Date.now() - started
        }
      } catch (err) {
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          error: String((err as { message?: string })?.message || err).slice(0, 300)
        })
        if (String((err as Error)?.message) === 'cancelled') throw err
        // Any other failure: fall through to the next candidate.
      }
    }

    const detail = attempts.map((a) => `${a.provider}/${a.model}: ${a.error}`).join(' | ')
    throw new Error(`All models failed for role "${req.role}". ${detail}`)
  }

  /** Convenience: ask for JSON and parse it, tolerating fenced output. */
  async completeJson<T = unknown>(req: LlmRequest): Promise<{ data: T; meta: LlmResponse }> {
    const meta = await this.complete({ ...req, json: true })
    return { data: parseJsonLoose<T>(meta.text), meta }
  }

  // ── Providers ─────────────────────────────────────────────────────────────

  private async callProvider(candidate: ModelCandidate, req: LlmRequest): Promise<string> {
    switch (candidate.provider) {
      case 'groq':
        return this.callGroq(candidate.model, req)
      case 'gemini':
        return this.callGemini(candidate.model, req)
      case 'huggingface':
        return this.callHuggingFace(candidate.model, req)
      case 'edge':
        return this.callEdge(req)
      default:
        throw new Error(`unknown provider ${candidate.provider}`)
    }
  }

  /**
   * Groq, through the key pool. A 429 on one key transparently retries the same
   * request on the next healthy key; we only give up when the pool says every
   * key is cooling down.
   */
  private async callGroq(model: string, req: LlmRequest): Promise<string> {
    if (!this.pool.hasKeys) throw new Error('no Groq API keys configured')

    // Bounded so a pathological pool can't spin: at most one attempt per key
    // plus a little slack for keys that recover mid-loop.
    const maxAttempts = Math.max(2, this.pool.size + 1)
    let lastErr: unknown = null

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let lease = this.pool.acquire()

      // Every key is cooling. A Groq rate-limit window is measured in seconds,
      // so waiting it out is far better than failing the task — especially with
      // one key, where parallel agents will always collide occasionally.
      if (!lease) {
        const wait = this.pool.msUntilAvailable()
        if (wait !== null && wait > 0 && wait <= MAX_COOLDOWN_WAIT_MS) {
          await new Promise((r) => setTimeout(r, wait + 250))
          if (req.signal?.aborted) throw new Error('cancelled')
          lease = this.pool.acquire()
        }
      }
      if (!lease) {
        // Genuinely unusable: report WHY (invalid key vs rate limited, and for
        // how long) instead of a bare "pool exhausted".
        throw lastErr ?? new Error(`Groq unavailable — ${this.pool.unavailableReason()}`)
      }

      try {
        const client = new Groq({ apiKey: lease.key })
        const res = await client.chat.completions.create(
          {
            model,
            messages: [
              ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
              ...req.messages.map((m) => ({ role: m.role, content: m.content }))
            ],
            temperature: req.temperature ?? 0.3,
            max_tokens: req.maxTokens ?? 4096,
            ...(req.json ? { response_format: { type: 'json_object' as const } } : {})
          },
          { signal: req.signal }
        )
        this.pool.reportSuccess(lease)
        return res.choices[0]?.message?.content ?? ''
      } catch (err) {
        lastErr = err
        const shouldRetryOnAnotherKey = this.pool.reportFailure(lease, err)
        // A wrong model id is not a key problem — bail so the router moves on.
        if (isModelError(err)) throw err
        if (!shouldRetryOnAnotherKey && !isRateLimitError(err)) throw err
      } finally {
        this.pool.release(lease)
      }
    }
    throw lastErr ?? new Error(`Groq unavailable — ${this.pool.unavailableReason()}`)
  }

  private async callGemini(model: string, req: LlmRequest): Promise<string> {
    const key = resolveGeminiKey()
    if (!key) throw new Error('no Gemini API key configured')
    const ai = new GoogleGenAI({ apiKey: key })

    // Gemini takes a single prompt string here; the conversation is short by
    // construction (one agent turn), so flattening is fine and keeps the
    // provider adapters uniform.
    const prompt = req.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
    const res = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        ...(req.system ? { systemInstruction: req.system } : {}),
        ...(req.json ? { responseMimeType: 'application/json' } : {}),
        temperature: req.temperature ?? 0.3
      }
    })
    return res.text ?? ''
  }

  /** HF Inference Providers exposes an OpenAI-compatible router endpoint. */
  private async callHuggingFace(model: string, req: LlmRequest): Promise<string> {
    const key = this.config.hfKey?.trim()
    if (!key) throw new Error('no Hugging Face API key configured')

    const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          ...req.messages
        ],
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 4096,
        ...(req.json ? { response_format: { type: 'json_object' } } : {})
      }),
      signal: req.signal
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const err = new Error(`HF ${res.status}: ${body.slice(0, 200)}`) as Error & { status: number }
      err.status = res.status
      throw err
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? ''
  }

  /** The existing gateway, so an operator running edge-only still gets agents. */
  private async callEdge(req: LlmRequest): Promise<string> {
    const result = await runChat({
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      systemInstruction: req.system
    })
    if (result.error) throw new Error(result.error)
    return result.text
  }
}

/**
 * Models wrap JSON in prose or fences even when asked not to. Recover the first
 * balanced object/array rather than failing the whole run on a stray backtick.
 */
export function parseJsonLoose<T = unknown>(raw: string): T {
  const text = String(raw || '').trim()
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  try {
    return JSON.parse(stripped) as T
  } catch {
    /* fall through to extraction */
  }

  const start = stripped.search(/[[{]/)
  if (start >= 0) {
    const open = stripped[start]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = !inString
      if (inString) continue
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(stripped.slice(start, i + 1)) as T
          } catch {
            break
          }
        }
      }
    }
  }
  throw new Error(`Model did not return valid JSON: ${stripped.slice(0, 200)}`)
}

export type { ProviderName }
