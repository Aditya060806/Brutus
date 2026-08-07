/**
 * Brutus Desk — the data model.
 *
 * Pure TypeScript on purpose: no `electron` import, no `fs`, no network. That
 * keeps it loadable by the headless test harness (`tests/build.mjs`), which is
 * how the safety rails get asserted without a mailbox or a running app.
 */

// ─── Autonomy ───────────────────────────────────────────────────────────────

/**
 * How much Brutus may do without being asked.
 *
 * `off` is the shipped default and is not a formality — this app is
 * distributed, and an installer that starts replying to a stranger's customers
 * on first launch would be indefensible. Turning it up is a deliberate,
 * confirmed act.
 */
export type AutonomyLevel = 'off' | 'draft' | 'autonomous'

export interface AutonomyConfig {
  level: AutonomyLevel
  /** Minutes between engine runs. */
  pollMinutes: number
  /**
   * Below this triage confidence, Brutus drafts instead of sending.
   *
   * This is a correctness control, not a permission one: an autonomous system
   * that acts on a guess is broken, not bold. 0 disables it.
   */
  confidenceFloor: number
  /** Only reply to addresses that have written to us first. */
  allowlistOnly: boolean
  /** Extra addresses the user has explicitly blessed. */
  allowlist: string[]
  /** Never auto-send when the thread mentions one of these. */
  neverAutoTopics: string[]
  /** Hard ceiling on autonomous sends per rolling 24 hours. */
  maxSendsPerDay: number
  /** Minimum hours before the same thread may be auto-replied to again. */
  threadCooldownHours: number
  /** Local-time hours [start, end) during which nothing is sent. */
  quietHours: { start: number; end: number }
  /** Days without a reply before a follow-up is drafted. */
  followUpAfterDays: number
}

export const DEFAULT_AUTONOMY: AutonomyConfig = {
  level: 'off',
  pollMinutes: 10,
  confidenceFloor: 0.75,
  allowlistOnly: true,
  allowlist: [],
  // Money, law and cancellations. Getting one of these wrong is expensive in a
  // way that a mistimed "thanks, received" is not.
  neverAutoTopics: [
    'invoice',
    'refund',
    'contract',
    'legal',
    'lawsuit',
    'terminate',
    'cancel',
    'password',
    'bank',
    'salary'
  ],
  maxSendsPerDay: 20,
  threadCooldownHours: 12,
  quietHours: { start: 21, end: 8 },
  followUpAfterDays: 3
}

// ─── Mail ───────────────────────────────────────────────────────────────────

export interface MailMessage {
  id: string
  threadId: string
  messageId: string
  references?: string
  from: string
  to: string
  subject: string
  body: string
  /** Epoch ms, from Gmail's internalDate. */
  date: number
  labelIds: string[]
}

export type TriageCategory = 'needs-reply' | 'fyi' | 'ignore'

export interface TriageResult {
  category: TriageCategory
  /** 1 (highest) to 3. */
  priority: 1 | 2 | 3
  /**
   * One line, shown in the UI.
   *
   * A classifier that cannot say why it decided something has not earned the
   * right to act on it, so this is required rather than optional.
   */
  reason: string
  /** 0-1. Drives the confidence floor. */
  confidence: number
}

// ─── Threads ────────────────────────────────────────────────────────────────

export type ThreadState =
  | 'new'
  | 'triaged'
  /** A draft is waiting for the human. */
  | 'needs-you'
  /** Brutus replied on its own. */
  | 'handled'
  /** Deliberately closed with no reply. */
  | 'dismissed'

export interface DeskThread {
  threadId: string
  subject: string
  /** The counterparty — not us. */
  contact: string
  lastMessageId: string
  lastMessageAt: number
  /** Did the most recent message come from them (so a reply is owed)? */
  awaitingUs: boolean
  state: ThreadState
  triage?: TriageResult
  draft?: DeskDraft
  /** Epoch ms of the last autonomous reply, for the cooldown rail. */
  lastAutoReplyAt?: number
  /** Why the rails held this back, if they did. */
  blockedReason?: string
}

export interface DeskDraft {
  to: string
  subject: string
  body: string
  createdAt: number
  /** 'reply' joins a thread; 'follow-up' chases an unanswered one. */
  kind: 'reply' | 'follow-up'
}

// ─── Commitments ────────────────────────────────────────────────────────────

export interface Commitment {
  id: string
  /** What was promised, in plain words. */
  text: string
  /** `us` = we owe them. `them` = they owe us. */
  owedBy: 'us' | 'them'
  /** Epoch ms, or null when no date was stated. */
  dueAt: number | null
  /** Where it came from, so the UI can open the conversation. */
  threadId?: string
  contact?: string
  createdAt: number
  doneAt?: number
  /** Carried over from the older `commitments.json`. */
  legacy?: boolean
}

// ─── Audit ──────────────────────────────────────────────────────────────────

export type DeskActionKind =
  | 'auto-reply'
  | 'follow-up'
  | 'blocked'
  | 'triaged'
  | 'manual-send'
  | 'engine'

export interface DeskAction {
  id: string
  kind: DeskActionKind
  at: number
  threadId?: string
  contact?: string
  subject?: string
  /** The exact text that was sent. Never a summary — this is the record. */
  body?: string
  /** Why Brutus did, or did not, act. */
  reason: string
  confidence?: number
}

// ─── Engine state ───────────────────────────────────────────────────────────

export interface EngineState {
  lastRunAt: number
  nextRunAt: number
  lastError?: string
  running: boolean
  /** Epoch ms of every autonomous send in the last day, for the rate rail. */
  recentSends: number[]
}

export const EMPTY_ENGINE_STATE: EngineState = {
  lastRunAt: 0,
  nextRunAt: 0,
  running: false,
  recentSends: []
}
