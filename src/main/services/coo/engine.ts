import Store from 'electron-store'
import { runChat } from '../llm-provider'
import { composeReply, extractCommitments, triageThread, type Complete } from './analyze'
import { getThread, listThreadIds, replyInThread, saveDraft, selfAddress } from './gmail-ops'
import { extractAddress, mayAutoSend } from './rails'
import {
  addCommitment,
  getCommitments,
  getConfig,
  getEngineState,
  getThreads,
  noteSend,
  recentSendsWithin,
  recordAction,
  setEngineState,
  upsertThread
} from './store'
import type { Commitment, DeskDraft, DeskThread, MailMessage } from './types'

/**
 * Brutus Desk — the recurring run.
 *
 * ── SHAPED AFTER `reminders.ts` ────────────────────────────────────────────
 * Same three properties, for the same reasons: the next run time is persisted
 * so a restart does not lose the schedule, the timer is re-chained rather than
 * set once, and a run that was missed while the app was closed happens on
 * startup instead of being silently skipped.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 * Every send goes through `rails.mayAutoSend()`. There is no other path to
 * `replyInThread` in this file, and that is deliberate — one gate, one place to
 * audit. A blocked reply is not discarded: it becomes a Gmail draft and a
 * "needs you" row carrying the reason it was held.
 */

const HOUR = 3600_000

/** Live timer handle. Null means the engine is not scheduled. */
let timer: ReturnType<typeof setTimeout> | null = null
/** Guards against a second run starting while one is still going. */
let inFlight = false
/** Set by `stop()` so a run already in progress bails at its next checkpoint. */
let cancelled = false

/** The model seam. Everything goes through the app's normal routing. */
const complete: Complete = async ({ system, user }) => {
  const res = await runChat({
    messages: [{ role: 'user', content: user }],
    systemInstruction: system,
    temperature: 0.2,
    maxTokens: 800
  })
  if (res.error) throw new Error(res.error)
  return res.text || ''
}

/**
 * The user's configured assistant personality.
 *
 * Read from the same `electron-store` key that Settings → Personality writes
 * (`brutus_personality`, via `security/Security.ts`), so drafted replies carry
 * the tone the user already chose rather than a second, separate voice.
 * Optional — an empty personality just means the default drafting style.
 */
function readPersonality(): string {
  try {
    // Same interop dance as `security/Security.ts`: electron-store ships both a
    // default and a namespace export depending on how it is resolved.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (Store as any).default || Store
    return String(new Ctor().get('brutus_personality') || '')
  } catch {
    return ''
  }
}

/** Who wrote this — us or the other party? */
function isFromSelf(message: MailMessage, self: string): boolean {
  return extractAddress(message.from) === self
}

/**
 * Process one thread.
 *
 * Returns the updated record. Never throws — one unreadable thread must not
 * end the run and leave the rest of the mailbox untouched.
 */
async function processThread(
  threadId: string,
  self: string,
  personality: string
): Promise<DeskThread | null> {
  let messages: MailMessage[]
  try {
    messages = await getThread(threadId)
  } catch (err) {
    console.error(`[desk] could not read thread ${threadId}:`, err)
    return null
  }
  if (!messages.length) return null

  const last = messages[messages.length - 1]
  const theirMessage = [...messages].reverse().find((m) => !isFromSelf(m, self))
  const contact = theirMessage ? theirMessage.from : last.from

  const existing = getThreads().find((t) => t.threadId === threadId)

  // Nothing new since we last looked. Re-triaging would spend a model call to
  // reach the same answer, and re-drafting could produce a different reply to
  // an unchanged conversation.
  if (existing && existing.lastMessageId === last.messageId) return existing

  const base: DeskThread = {
    threadId,
    subject: last.subject,
    contact,
    lastMessageId: last.messageId,
    lastMessageAt: last.date,
    // If the newest message is theirs, a reply is owed.
    awaitingUs: !isFromSelf(last, self),
    state: 'triaged',
    lastAutoReplyAt: existing?.lastAutoReplyAt
  }

  const triage = await triageThread(messages, complete)
  base.triage = triage

  // Commitments are worth extracting whatever the category — an "fyi" that says
  // "we'll ship Tuesday" is still a promise someone is relying on.
  try {
    const found = await extractCommitments(messages, complete, { threadId, contact })
    for (const c of found) addCommitment(c)
  } catch (err) {
    console.error('[desk] commitment extraction failed:', err)
  }

  if (triage.category !== 'needs-reply' || !base.awaitingUs) {
    base.state = 'triaged'
    upsertThread(base)
    return base
  }

  // Draft a reply.
  let body = ''
  try {
    body = await composeReply(messages, complete, { personality, kind: 'reply' })
  } catch (err) {
    console.error('[desk] compose failed:', err)
  }
  if (!body.trim()) {
    base.state = 'needs-you'
    base.blockedReason = 'Brutus could not draft a reply for this one.'
    upsertThread(base)
    return base
  }

  const draft: DeskDraft = {
    to: extractAddress(contact),
    subject: last.subject,
    body,
    createdAt: Date.now(),
    kind: 'reply'
  }
  base.draft = draft

  return finishDraft(base, draft, triage)
}

/**
 * Put a draft through the gate, and act on the answer.
 *
 * The ONLY place in the engine that reaches `replyInThread`.
 */
async function finishDraft(
  thread: DeskThread,
  draft: DeskDraft,
  triage: DeskThread['triage']
): Promise<DeskThread> {
  const config = getConfig()
  const decision = mayAutoSend({
    config,
    thread,
    draft,
    triage: triage!,
    recentSends: recentSendsWithin(24),
    now: Date.now()
  })

  if (!decision.ok) {
    thread.state = 'needs-you'
    thread.blockedReason = decision.reason
    // Mirror it into Gmail so a held reply is still one click from sending,
    // even if the user never opens Brutus.
    try {
      await saveDraft({
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        threadId: thread.threadId
      })
    } catch (err) {
      console.error('[desk] could not save the Gmail draft:', err)
    }
    recordAction({
      id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind: 'blocked',
      at: Date.now(),
      threadId: thread.threadId,
      contact: thread.contact,
      subject: draft.subject,
      body: draft.body,
      reason: decision.reason,
      confidence: triage?.confidence
    })
    upsertThread(thread)
    return thread
  }

  try {
    const messages = await getThread(thread.threadId)
    const last = messages[messages.length - 1]
    await replyInThread({
      threadId: thread.threadId,
      inReplyTo: last.messageId,
      references: last.references,
      to: draft.to,
      subject: draft.subject,
      body: draft.body
    })
    noteSend()
    thread.state = 'handled'
    thread.lastAutoReplyAt = Date.now()
    thread.blockedReason = undefined
    recordAction({
      id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind: draft.kind === 'follow-up' ? 'follow-up' : 'auto-reply',
      at: Date.now(),
      threadId: thread.threadId,
      contact: thread.contact,
      subject: draft.subject,
      body: draft.body,
      reason: triage?.reason || 'Replied automatically',
      confidence: triage?.confidence
    })
  } catch (err) {
    thread.state = 'needs-you'
    thread.blockedReason = `Sending failed: ${String(err)}`
    recordAction({
      id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind: 'blocked',
      at: Date.now(),
      threadId: thread.threadId,
      reason: thread.blockedReason
    })
  }

  upsertThread(thread)
  return thread
}

/**
 * Chase promises that are overdue and unanswered.
 *
 * "Nothing falls through" is the whole pitch, and this is the half of it that
 * is not about incoming mail.
 */
async function sweepFollowUps(personality: string): Promise<number> {
  const config = getConfig()
  const now = Date.now()
  const cutoff = config.followUpAfterDays * 24 * HOUR
  let chased = 0

  const due = getCommitments().filter(
    (c: Commitment) =>
      !c.doneAt && c.owedBy === 'them' && c.threadId && c.dueAt && now - c.dueAt > cutoff
  )

  for (const commitment of due) {
    if (cancelled) break
    const thread = getThreads().find((t) => t.threadId === commitment.threadId)
    if (!thread) continue

    let messages: MailMessage[]
    try {
      messages = await getThread(thread.threadId)
    } catch {
      continue
    }
    if (!messages.length) continue

    let body = ''
    try {
      body = await composeReply(messages, complete, { personality, kind: 'follow-up' })
    } catch {
      continue
    }
    if (!body.trim()) continue

    const draft: DeskDraft = {
      to: extractAddress(thread.contact),
      subject: thread.subject,
      body,
      createdAt: now,
      kind: 'follow-up'
    }
    thread.draft = draft
    await finishDraft(thread, draft, thread.triage)
    chased++
  }

  return chased
}

/** One full pass. Exported so the UI can force a run without waiting. */
export async function runOnce(): Promise<{ scanned: number; chased: number; error?: string }> {
  if (inFlight) return { scanned: 0, chased: 0, error: 'A run is already in progress' }
  inFlight = true
  cancelled = false
  setEngineState({ running: true, lastError: undefined })

  let scanned = 0
  let chased = 0
  let error: string | undefined

  try {
    const config = getConfig()
    const self = await selfAddress()

    const personality = readPersonality()

    // Only look at recent threads. A first run on a decade-old mailbox would
    // otherwise triage thousands of conversations and spend a fortune doing it.
    const query = `in:inbox newer_than:${Math.max(1, config.followUpAfterDays * 2)}d`
    const ids = await listThreadIds(query, 25)

    for (const id of ids) {
      if (cancelled) break
      await processThread(id, self, personality)
      scanned++
    }

    if (!cancelled) chased = await sweepFollowUps(personality)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    console.error('[desk] run failed:', err)
  } finally {
    inFlight = false
    const config = getConfig()
    setEngineState({
      running: false,
      lastRunAt: Date.now(),
      nextRunAt: Date.now() + config.pollMinutes * 60_000,
      lastError: error
    })
  }

  recordAction({
    id: `a_${Date.now()}_run`,
    kind: 'engine',
    at: Date.now(),
    reason: error
      ? `Run failed: ${error}`
      : `Scanned ${scanned} thread${scanned === 1 ? '' : 's'}${chased ? `, chased ${chased}` : ''}`
  })

  return { scanned, chased, error }
}

/**
 * Start the loop.
 *
 * Re-chains rather than using setInterval: a run can take longer than the
 * interval, and setInterval would stack overlapping runs on a slow mailbox.
 */
export function start(): void {
  stop()
  cancelled = false

  const schedule = (delayMs: number): void => {
    timer = setTimeout(async () => {
      const config = getConfig()
      // The kill switch: turning autonomy off stops the loop at the next tick
      // rather than needing the app restarted.
      if (config.level === 'off') {
        setEngineState({ nextRunAt: 0 })
        timer = null
        return
      }
      await runOnce()
      if (timer !== null || !cancelled) schedule(getConfig().pollMinutes * 60_000)
    }, delayMs)
  }

  const config = getConfig()
  if (config.level === 'off') return

  // Catch up rather than skip: if the app was closed through a scheduled run,
  // do it now instead of waiting a full interval for the next one.
  const state = getEngineState()
  const overdue = state.nextRunAt > 0 && state.nextRunAt <= Date.now()
  schedule(overdue ? 3_000 : config.pollMinutes * 60_000)
  setEngineState({ nextRunAt: Date.now() + (overdue ? 3_000 : config.pollMinutes * 60_000) })
}

/** Stop the loop, and ask any in-flight run to bail at its next checkpoint. */
export function stop(): void {
  cancelled = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  setEngineState({ nextRunAt: 0, running: false })
}

export function isRunning(): boolean {
  return inFlight
}
