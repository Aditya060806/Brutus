// ─── Emotion Bus ─────────────────────────────────────────────────────
// Singleton bridge: Dashboard writes user expression, BrutusEyes reads it.

import type { BrutusEmotion } from '@renderer/services/Brutus-voice-ai'

export type FaceExpression =
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'neutral'
  | 'fearful'
  | 'disgusted'

class EmotionBus {
  /** Dominant face-api.js expression from Dashboard camera */
  userExpression: FaceExpression = 'neutral'

  /** Confidence of the dominant expression (0-1) */
  userExpressionConfidence: number = 0

  /** Mic input volume (0-1), written by BrutusEyes from micAnalyser */
  userVolume: number = 0

  /** Smoothed mic volume for sustained-shouting detection */
  smoothVolume: number = 0

  /** Whether a face is currently detected by face-api */
  faceDetected: boolean = false

  /** Timestamp of last expression update (for staleness check) */
  lastExpressionUpdate: number = 0

  // ─── Directional Pointing API ─────────────────────────────────────
  /** Force pupil direction (-1 to 1 range). null = no override */
  lookAtX: number | null = null
  lookAtY: number | null = null
  lookAtExpiry: number = 0

  /** Force physical eye pair position (-1 to 1 range). null = no override */
  moveToX: number | null = null
  moveToY: number | null = null
  moveToExpiry: number = 0

  // ─── Gesture Trigger API ──────────────────────────────────────────
  /** Pending gesture name to play. Consumed by animation player. */
  pendingGesture: string | null = null

  // ─── Conversation Emotion (set by sentiment analysis) ───────────────
  /** Timed emotion override driven by AI response / user message content */
  private _convEmotion: BrutusEmotion | null = null
  private _convEmotionExpiry: number = 0

  // ─── Lockdown State ───────────────────────────────────────────────
  /** Whether eye lockdown is currently active (read by Sphere.tsx) */
  lockdownActive: boolean = false

  setExpression(exp: FaceExpression, confidence: number) {
    this.userExpression = exp
    this.userExpressionConfidence = confidence
    this.faceDetected = true
    this.lastExpressionUpdate = performance.now()
  }

  /** Returns true if expression data is fresh (< 2 seconds old) */
  isFresh(): boolean {
    return performance.now() - this.lastExpressionUpdate < 2000
  }

  /** Force pupils to look in a direction for given duration (ms) */
  lookAt(x: number, y: number, durationMs: number = 2000): void {
    this.lookAtX = x
    this.lookAtY = y
    this.lookAtExpiry = performance.now() + durationMs
  }

  /** Physically move the eye pair to a position for given duration (ms) */
  moveTo(x: number, y: number, durationMs: number = 3000): void {
    this.moveToX = x
    this.moveToY = y
    this.moveToExpiry = performance.now() + durationMs
  }

  /** Trigger a named gesture animation */
  triggerGesture(name: string): void {
    this.pendingGesture = name
  }

  /** Check and clear expired overrides */
  clearExpired(): void {
    const now = performance.now()
    if (this.lookAtX !== null && now > this.lookAtExpiry) {
      this.lookAtX = null
      this.lookAtY = null
    }
    if (this.moveToX !== null && now > this.moveToExpiry) {
      this.moveToX = null
      this.moveToY = null
    }
  }

  /** Consume pending gesture (returns name and clears it) */
  consumeGesture(): string | null {
    const g = this.pendingGesture
    this.pendingGesture = null
    return g
  }

  /** Set a timed conversation-driven emotion override */
  setConversationEmotion(emotion: BrutusEmotion, durationMs: number = 4000): void {
    this._convEmotion = emotion
    this._convEmotionExpiry = performance.now() + durationMs
  }

  /** Get current conversation emotion if not expired, else null */
  getConversationEmotion(): BrutusEmotion | null {
    if (this._convEmotion && performance.now() < this._convEmotionExpiry) {
      return this._convEmotion
    }
    this._convEmotion = null
    return null
  }

  /** Directly trigger Eye Takeover lockdown (call when abuse detected) */
  triggerLockdown(): void {
    this.lockdownActive = true
  }
}

export const emotionBus = new EmotionBus()
