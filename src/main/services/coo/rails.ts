import type { AutonomyConfig, DeskDraft, DeskThread, TriageResult } from './types'

/**
 * Brutus Desk — the safety rails.
 *
 * ── WHAT THIS FILE IS FOR ──────────────────────────────────────────────────
 * Everything here stands between a bug and an email that reaches a real
 * customer and cannot be recalled. The user chose full autonomy with that risk
 * stated, so these are NOT permission gates — they exist to stop *wrong*
 * actions, which is a different thing. An autonomous system that acts on a bad
 * inference is broken, not bold.
 *
 * Every rail is configurable, including to zero.
 *
 * ── ONE FUNCTION, ON PURPOSE ───────────────────────────────────────────────
 * `mayAutoSend()` is the only way to reach the send path. Not a set of checks
 * sprinkled through the engine — one function, so there is exactly one place to
 * audit, one place to test, and no route around it. If a caller wants to send,
 * it asks here, and it gets a reason back either way.
 *
 * Pure: no I/O, no clock of its own, no config lookup. Everything it judges is
 * passed in, which is what makes the whole thing assertable offline.
 */

export interface SendContext {
  config: AutonomyConfig
  thread: DeskThread
  draft: DeskDraft
  triage: TriageResult
  /** Epoch ms of autonomous sends inside the last 24h. */
  recentSends: number[]
  /** Injected so tests can pin quiet hours and cooldowns. */
  now: number
}

export type RailDecision =
  | { ok: true }
  | {
      ok: false
      /** Machine-readable, for metrics and tests. */
      code: RailCode
      /** Shown to the user, verbatim. Must explain itself without context. */
      reason: string
    }

export type RailCode =
  | 'autonomy-off'
  | 'draft-only'
  | 'not-allowlisted'
  | 'low-confidence'
  | 'blocked-topic'
  | 'thread-cooldown'
  | 'rate-limit'
  | 'quiet-hours'
  | 'not-a-reply'
  | 'empty-draft'

/** Pull the bare address out of `Name <a@b.com>`, lowercased. */
export function extractAddress(value: string): string {
  const angled = value.match(/<([^>]+)>/)
  const raw = angled ? angled[1] : value
  return raw.trim().toLowerCase()
}

/**
 * Is `hour` inside a possibly-wrapping quiet window?
 *
 * Quiet hours normally wrap midnight (21:00 → 08:00), so a naive
 * `h >= start && h < end` is false for the entire night — the exact hours it is
 * meant to cover.
 */
export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
}

/**
 * Does the thread mention a topic that must never be handled unattended?
 *
 * Matched on whole words against subject and body. Substring matching would
 * catch "cancellation policy" inside an ordinary sentence and, worse, match
 * "bank" inside "bankruptcy" while missing "Bank." at the end of one.
 */
export function matchedTopic(text: string, topics: string[]): string | null {
  const haystack = text.toLowerCase()
  for (const topic of topics) {
    const t = topic.trim().toLowerCase()
    if (!t) continue
    const pattern = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (pattern.test(haystack)) return topic
  }
  return null
}

/**
 * May Brutus send this on its own?
 *
 * Order matters. The cheapest and most absolute checks run first, so a refusal
 * reports the most fundamental reason rather than an incidental one — being
 * told "outside quiet hours" when autonomy is switched off entirely would be
 * true and useless.
 */
export function mayAutoSend(ctx: SendContext): RailDecision {
  const { config, thread, draft, triage, recentSends, now } = ctx

  // ── 1. Is autonomy on at all? ──
  if (config.level === 'off') {
    return {
      ok: false,
      code: 'autonomy-off',
      reason: 'Autonomous sending is switched off. This draft is waiting for you.'
    }
  }
  if (config.level === 'draft') {
    return {
      ok: false,
      code: 'draft-only',
      reason: 'Brutus is in draft-only mode, so nothing is sent without your approval.'
    }
  }

  // ── 2. Is there anything to send? ──
  if (!draft.body.trim()) {
    return { ok: false, code: 'empty-draft', reason: 'The drafted reply was empty.' }
  }
  const recipient = extractAddress(draft.to)
  if (!recipient || !recipient.includes('@')) {
    return {
      ok: false,
      code: 'not-allowlisted',
      reason: `"${draft.to}" is not a usable email address.`
    }
  }

  // ── 3. Only ever reply to someone who wrote to us ──
  // The rail that matters most: it makes a hallucinated address unreachable.
  // A model that invents a plausible recipient cannot mail a stranger, because
  // the only addresses in play are ones already present in the thread.
  if (config.allowlistOnly) {
    const known = new Set(
      [extractAddress(thread.contact), ...config.allowlist.map(extractAddress)].filter(Boolean)
    )
    if (!known.has(recipient)) {
      return {
        ok: false,
        code: 'not-allowlisted',
        reason: `${recipient} has not written to you, and is not on your allowlist.`
      }
    }
  }

  // ── 4. Only reply where a reply is owed ──
  if (draft.kind === 'reply' && triage.category !== 'needs-reply') {
    return {
      ok: false,
      code: 'not-a-reply',
      reason: `Brutus classified this as "${triage.category}", so no reply was owed.`
    }
  }

  // ── 5. Confidence ──
  if (config.confidenceFloor > 0 && triage.confidence < config.confidenceFloor) {
    return {
      ok: false,
      code: 'low-confidence',
      reason: `Only ${Math.round(triage.confidence * 100)}% sure about this one (your floor is ${Math.round(
        config.confidenceFloor * 100
      )}%), so it is a draft.`
    }
  }

  // ── 6. Topics that are never handled unattended ──
  const topic = matchedTopic(
    `${thread.subject} ${draft.subject} ${draft.body}`,
    config.neverAutoTopics
  )
  if (topic) {
    return {
      ok: false,
      code: 'blocked-topic',
      reason: `This mentions "${topic}", which you have set to always need a human.`
    }
  }

  // ── 7. One autonomous reply per thread per window ──
  // The engine re-reads threads. Without this, a thread that stays unanswered
  // gets replied to on every single run.
  if (thread.lastAutoReplyAt && config.threadCooldownHours > 0) {
    const elapsedHours = (now - thread.lastAutoReplyAt) / 3600_000
    if (elapsedHours < config.threadCooldownHours) {
      return {
        ok: false,
        code: 'thread-cooldown',
        reason: `Brutus already replied to this thread ${Math.round(elapsedHours)}h ago (cooldown is ${config.threadCooldownHours}h).`
      }
    }
  }

  // ── 8. Daily ceiling ──
  // A loop bug should cost one wrong email, not four hundred.
  if (config.maxSendsPerDay > 0) {
    const cutoff = now - 24 * 3600_000
    const sent = recentSends.filter((t) => t >= cutoff).length
    if (sent >= config.maxSendsPerDay) {
      return {
        ok: false,
        code: 'rate-limit',
        reason: `Daily limit reached — ${sent} of ${config.maxSendsPerDay} autonomous emails already sent.`
      }
    }
  }

  // ── 9. Quiet hours ──
  const hour = new Date(now).getHours()
  if (inQuietHours(hour, config.quietHours.start, config.quietHours.end)) {
    return {
      ok: false,
      code: 'quiet-hours',
      reason: `It is ${hour}:00, inside your quiet hours (${config.quietHours.start}:00–${config.quietHours.end}:00).`
    }
  }

  return { ok: true }
}
