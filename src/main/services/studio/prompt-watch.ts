/**
 * BRUTUS Studio — prompt watcher (the pattern track)
 * ---------------------------------------------------
 * For agents with no hook system (Codex, Gemini), the only way to intercept a
 * permission prompt is to read the terminal the way a human does. That is
 * inherently less reliable than Claude Code's hook, so the safeguards matter
 * more than the matching:
 *
 *  • **Single-shot per prompt.** A TUI redraws constantly — the same question
 *    can scroll past a dozen times. Answering twice would send a stray
 *    keystroke into whatever came next, so a matched prompt is answered once
 *    and not re-armed until the screen genuinely moves on.
 *  • **Debounced.** A prompt is only acted on once output has settled, so a
 *    half-drawn frame is never matched.
 *  • **Never invents an answer.** If the pattern does not match, nothing is
 *    typed and the human sees the prompt. Silence is not consent.
 *
 * It also detects idle, which is what tells the router a turn has finished for
 * adapters that emit no structured events.
 */
import { stripAnsi, type AgentAdapter, type ApprovalPattern } from './adapters/registry'

/** How long output must be quiet before a match is acted on. */
const SETTLE_MS = 350
/** Rolling window kept for matching. Big enough for a full prompt block. */
const TAIL_CHARS = 4000

export interface PromptHit {
  pattern: ApprovalPattern
  summary: string
  tail: string
}

export interface PromptWatchHandlers {
  /** A recognised approval prompt has settled on screen. */
  onApproval: (hit: PromptHit) => void
  /** The agent appears to be waiting for input. */
  onIdle: () => void
  /** The agent produced output after being idle. */
  onBusy: () => void
}

export interface PromptWatchOptions {
  /**
   * Whether this watcher may match approval prompts.
   *
   * Off for an agent whose hook installed successfully: Claude Code would then
   * have two independent permission paths reading the same prompt, and the
   * pattern track could type an answer for a question the hook had already
   * decided. Idle detection stays on either way, because the router needs it to
   * know when a turn ended.
   */
  detectApprovals?: boolean
}

export class PromptWatcher {
  private tail = ''
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  /** Fingerprint of the prompt already answered, so it is not answered twice. */
  private answeredFingerprint: string | null = null
  private idle = false
  private disposed = false
  private detectApprovals: boolean

  constructor(
    private adapter: AgentAdapter,
    private handlers: PromptWatchHandlers,
    options: PromptWatchOptions = {}
  ) {
    this.detectApprovals = options.detectApprovals !== false
  }

  /** Feed raw pty output. */
  push(chunk: string): void {
    if (this.disposed) return

    this.tail = (this.tail + chunk).slice(-TAIL_CHARS)

    if (this.idle) {
      this.idle = false
      this.handlers.onBusy()
    }

    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => this.evaluate(), SETTLE_MS)
  }

  /**
   * Called once output has been quiet. Order matters: an approval prompt is
   * also an idle state, and the approval is the more specific signal.
   */
  private evaluate(): void {
    if (this.disposed) return
    const clean = stripAnsi(this.tail)

    // ── Approval ──
    for (const pattern of (this.detectApprovals && this.adapter.approvalPatterns) || []) {
      const matched = clean.match(pattern.match)
      if (!matched) continue

      const summary = pattern.describe
        ? pattern.describe(this.tail)
        : 'Agent is asking for approval'
      const fingerprint = this.fingerprint(matched[0], summary)
      if (fingerprint === this.answeredFingerprint) return // already handled

      this.answeredFingerprint = fingerprint
      // Consume the prompt. Without this the answered question stays in the
      // rolling window and keeps re-matching against unrelated later output.
      this.tail = ''
      this.handlers.onApproval({ pattern, summary, tail: clean })
      return
    }

    // ── Idle ──
    if (this.adapter.idlePatterns.some((p) => p.test(clean))) {
      if (!this.idle) {
        this.idle = true
        // The prompt is gone, so a future identical question is a new question.
        this.answeredFingerprint = null
        this.handlers.onIdle()
      }
    }
  }

  /**
   * Identify a prompt by the matched question itself, not by the surrounding
   * buffer.
   *
   * Fingerprinting the whole tail looked reasonable but was wrong: the tail
   * grows with every redraw, so the same question produced a different
   * fingerprint each time and got answered repeatedly. The matched text plus
   * the summary is stable no matter how much scrollback surrounds it.
   */
  private fingerprint(matchedText: string, summary: string): string {
    const normalised = matchedText.replace(/\s+/g, ' ').trim()
    return `${summary}::${normalised}`
  }

  /** Called after the answer is written, so the next prompt can be matched. */
  clearAfterAnswer(): void {
    this.tail = ''
  }

  dispose(): void {
    this.disposed = true
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
  }
}
