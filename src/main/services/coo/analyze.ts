import type { Commitment, MailMessage, TriageResult } from './types'

/**
 * Brutus Desk — reading the mail.
 *
 * Triage, commitment extraction and reply drafting. The model is reached
 * through a single injected `Complete` function, so every parser below is
 * testable offline against the malformed output models actually produce.
 *
 * ── THE PARSERS ARE THE POINT ──────────────────────────────────────────────
 * An LLM asked for JSON returns JSON *most* of the time. The rest of the time
 * it returns JSON wrapped in prose, in a ```json fence, with a trailing comma,
 * or with a confidence of "high" instead of 0.9. None of that may throw, and
 * none of it may silently become a confident send — an unparseable triage must
 * degrade to "I do not know", which the confidence floor then turns into a
 * draft rather than an email.
 */

/** The one seam to the model. Returns raw text. */
export type Complete = (opts: { system: string; user: string }) => Promise<string>

// ─── Shared parsing ─────────────────────────────────────────────────────────

/**
 * Pull the first JSON object or array out of a model response.
 *
 * Handles a bare object, a ```json fence, and prose wrapped around either.
 * Returns null rather than throwing — every caller has a defined fallback and
 * none of them should crash a background run over a stray sentence.
 */
export function extractJson(raw: string): unknown {
  if (!raw) return null
  const text = String(raw).trim()

  // Prefer a fenced block: models often add "Here is the JSON:" before it.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fence?.[1], text].filter(Boolean) as string[]

  for (const candidate of candidates) {
    const trimmed = candidate.trim()

    // ── ORDER MATTERS, AND GETTING IT WRONG IS SUBTLE ──
    // For `[{"a":1}]` a fixed `{` -before- `[` order extracts the INNER object
    // and returns it instead of the array. With two or more entries the inner
    // slice is invalid JSON so it accidentally falls through to the array and
    // works — meaning the bug only appears for single-element arrays, which is
    // the common case for "one commitment found". Whichever bracket opens
    // first is the real container.
    const objectAt = trimmed.indexOf('{')
    const arrayAt = trimmed.indexOf('[')
    const pairs: [string, string][] = []
    if (arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt)) {
      pairs.push(['[', ']'], ['{', '}'])
    } else {
      pairs.push(['{', '}'], ['[', ']'])
    }

    for (const [open, close] of pairs) {
      const start = trimmed.indexOf(open)
      const end = trimmed.lastIndexOf(close)
      if (start < 0 || end <= start) continue
      const slice = trimmed.slice(start, end + 1)
      try {
        return JSON.parse(slice)
      } catch {
        try {
          // One forgiving retry: trailing commas are the single most common
          // malformation and are trivially safe to strip.
          return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'))
        } catch {
          /* try the other bracket pair, then the next candidate */
        }
      }
    }
  }
  return null
}

/** Coerce a model's idea of confidence into 0-1. */
export function toConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Some models answer 85 rather than 0.85.
    const n = value > 1 ? value / 100 : value
    return Math.min(1, Math.max(0, n))
  }
  const word = String(value ?? '')
    .toLowerCase()
    .trim()
  // Words must map LOW, not high: an unrecognised value becoming 0.9 would
  // turn a guess into a sent email.
  if (word === 'high' || word === 'certain') return 0.9
  if (word === 'medium' || word === 'moderate') return 0.6
  if (word === 'low' || word === 'unsure') return 0.3
  const parsed = Number(word)
  if (Number.isFinite(parsed)) return Math.min(1, Math.max(0, parsed > 1 ? parsed / 100 : parsed))
  return 0
}

// ─── Triage ─────────────────────────────────────────────────────────────────

export const TRIAGE_SYSTEM = [
  "You triage a business owner's email. Decide whether THEY must personally reply.",
  '',
  'Reply with JSON only, no prose:',
  '{"category":"needs-reply|fyi|ignore","priority":1|2|3,"reason":"one short sentence","confidence":0.0-1.0}',
  '',
  '- needs-reply: a person is waiting on an answer, a decision, or something promised.',
  '- fyi: real but no response required — a receipt, a confirmation, a newsletter they chose.',
  '- ignore: bulk marketing, automated noise, spam.',
  '- priority 1 is urgent, 3 is whenever.',
  '- reason is shown to the user, so make it specific: say WHAT is being asked.',
  '- confidence is your honest certainty. If the thread is ambiguous, say so with a low',
  '  number — a low score means a human looks at it, which is the correct outcome',
  '  when you are unsure. Do not inflate it.'
].join('\n')

/** The safe answer when the model is unavailable or unintelligible. */
export const UNKNOWN_TRIAGE: TriageResult = {
  category: 'needs-reply',
  priority: 3,
  reason: 'Brutus could not read this one confidently.',
  confidence: 0
}

export function parseTriage(raw: string): TriageResult {
  const json = extractJson(raw) as Record<string, unknown> | null
  if (!json || typeof json !== 'object') return UNKNOWN_TRIAGE

  const category = String(json.category ?? '').toLowerCase()
  const valid = ['needs-reply', 'fyi', 'ignore'].includes(category)

  const priorityRaw = Number(json.priority)
  const priority = ([1, 2, 3] as const).includes(priorityRaw as 1 | 2 | 3)
    ? (priorityRaw as 1 | 2 | 3)
    : 3

  const reason = String(json.reason ?? '').trim() || UNKNOWN_TRIAGE.reason

  return {
    // An unrecognised category falls back to needs-reply with zero confidence:
    // it surfaces to the human rather than being quietly dropped as `ignore`.
    category: valid ? (category as TriageResult['category']) : 'needs-reply',
    priority,
    reason,
    confidence: valid ? toConfidence(json.confidence) : 0
  }
}

/** Render a thread for the model — newest last, so recency reads naturally. */
export function threadToPrompt(messages: MailMessage[], maxChars = 6000): string {
  const rendered = messages
    .map((m) => `From: ${m.from}\nDate: ${new Date(m.date).toISOString()}\n${m.body.trim()}`)
    .join('\n\n---\n\n')
  // Keep the tail: the latest message is what a decision hinges on.
  return rendered.length > maxChars ? `…\n${rendered.slice(-maxChars)}` : rendered
}

export async function triageThread(
  messages: MailMessage[],
  complete: Complete
): Promise<TriageResult> {
  if (!messages.length) return UNKNOWN_TRIAGE
  try {
    const raw = await complete({
      system: TRIAGE_SYSTEM,
      user: `Subject: ${messages[messages.length - 1].subject}\n\n${threadToPrompt(messages)}`
    })
    return parseTriage(raw)
  } catch {
    // A model outage must not stop the run or, worse, produce a confident
    // default. Zero confidence routes it to the human.
    return UNKNOWN_TRIAGE
  }
}

// ─── Commitments ────────────────────────────────────────────────────────────

export const COMMITMENT_SYSTEM = [
  'Extract explicit promises from an email thread. Both directions matter.',
  '',
  'Reply with a JSON array only:',
  '[{"text":"what was promised","owedBy":"us|them","due":"YYYY-MM-DD or null"}]',
  '',
  '- owedBy "us" when the account owner promised something.',
  '- owedBy "them" when the other person did.',
  '- Only explicit promises. "I will send the quote Friday" counts;',
  '  "we should catch up sometime" does not.',
  '- due is null unless a real date was stated or is unambiguous ("Friday").',
  '- Return [] when nothing was promised. An empty array is a valid, common answer.'
].join('\n')

export function parseCommitments(
  raw: string,
  ctx: { threadId?: string; contact?: string; now?: number } = {}
): Commitment[] {
  const json = extractJson(raw)
  if (!Array.isArray(json)) return []

  const now = ctx.now ?? Date.now()
  const out: Commitment[] = []

  json.forEach((entry, index) => {
    const record = entry as Record<string, unknown>
    const text = String(record?.text ?? '').trim()
    if (!text) return

    const dueRaw = record?.due
    let dueAt: number | null = null
    if (dueRaw && String(dueRaw).toLowerCase() !== 'null') {
      const parsed = Date.parse(String(dueRaw))
      if (Number.isFinite(parsed)) dueAt = parsed
    }

    out.push({
      id: `c_${now}_${index}_${Math.random().toString(36).slice(2, 7)}`,
      text,
      // Default to `us`: a promise wrongly attributed to us shows up as our
      // own to-do, which is harmless. The reverse would mean chasing a client
      // for something they never agreed to.
      owedBy: String(record?.owedBy ?? '').toLowerCase() === 'them' ? 'them' : 'us',
      dueAt,
      threadId: ctx.threadId,
      contact: ctx.contact,
      createdAt: now
    })
  })

  return out
}

export async function extractCommitments(
  messages: MailMessage[],
  complete: Complete,
  ctx: { threadId?: string; contact?: string } = {}
): Promise<Commitment[]> {
  if (!messages.length) return []
  try {
    const raw = await complete({ system: COMMITMENT_SYSTEM, user: threadToPrompt(messages) })
    return parseCommitments(raw, ctx)
  } catch {
    return []
  }
}

// ─── Composing ──────────────────────────────────────────────────────────────

export const COMPOSE_SYSTEM = [
  'Write the reply the account owner would send. Plain text, no markdown.',
  '',
  '- Answer what was actually asked. Do not restate their message back to them.',
  '- Short. Three sentences is usually plenty.',
  '- No subject line, no "Dear", no signature block — those are added around you.',
  '- Never invent a fact, a price, a date or a commitment that is not in the thread.',
  '  If answering needs information you do not have, say that a reply is coming',
  '  shortly rather than guessing.',
  '- Match the tone of the thread. Business, not chatty; human, not robotic.'
].join('\n')

export const FOLLOW_UP_SYSTEM = [
  'Write a brief, polite follow-up on an unanswered message.',
  '',
  '- One short paragraph.',
  '- Reference the specific thing being waited on.',
  '- No guilt, no urgency theatre, no "just circling back".',
  '- Plain text, no subject line, no signature.'
].join('\n')

/** Strip anything the model added around the message itself. */
export function cleanDraft(raw: string): string {
  return String(raw ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*subject:.*$/gim, '')
    .replace(/^\s*(dear|hi|hello)\b.*$/gim, (line) => line) // greetings are fine
    .trim()
}

export async function composeReply(
  messages: MailMessage[],
  complete: Complete,
  opts: { personality?: string; kind?: 'reply' | 'follow-up' } = {}
): Promise<string> {
  const base = opts.kind === 'follow-up' ? FOLLOW_UP_SYSTEM : COMPOSE_SYSTEM
  // The user's configured assistant personality carries their tone, so replies
  // sound like them rather than like a support bot.
  const system = opts.personality?.trim()
    ? `${base}\n\nThe account owner's voice:\n${opts.personality.trim()}`
    : base

  const raw = await complete({ system, user: threadToPrompt(messages) })
  return cleanDraft(raw)
}
