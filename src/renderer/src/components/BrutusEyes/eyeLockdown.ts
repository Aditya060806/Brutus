// ─── Eye Takeover + System Lock (Autonomy Mode) ────────────────────
// Detects sustained inappropriate behavior (angry + shouting >10s)
// and triggers a full-screen eye takeover. Only "tuffy" unlocks.

import { emotionBus } from './emotionBus'

export type LockdownPhase = 'normal' | 'warning' | 'locking' | 'locked' | 'unlocking'

export interface LockdownState {
  phase: LockdownPhase
  /** How long (ms) the angry+shouting condition has been sustained */
  angerAccumulator: number
  /** Timestamp when lockdown animation started */
  lockStartTime: number
  /** Timestamp when unlock animation started */
  unlockStartTime: number
  /** Progress 0-1 for lock/unlock animations */
  animProgress: number
  /** Scale multiplier for eye takeover (1=normal, 5=fullscreen) */
  scale: number
  /** Background opacity (0=transparent, 1=black) */
  bgOpacity: number
  /** Whether password prompt is visible */
  showPrompt: boolean
  /** Current password attempt */
  passwordInput: string
  /** Whether password was just rejected (for shake animation) */
  rejected: boolean
  rejectedTime: number
}

const WARNING_THRESHOLD = 8000   // 8s to start warning
const LOCKDOWN_THRESHOLD = 10000 // 10s to trigger lockdown
const LOCK_ANIM_DURATION = 1500  // 1.5s takeover animation
const UNLOCK_ANIM_DURATION = 1000 // 1s unlock animation
const PROMPT_DELAY = 5000         // 5s before showing password prompt
const SECRET_PASSWORD = 'tuffy'

export function createLockdownState(): LockdownState {
  return {
    phase: 'normal',
    angerAccumulator: 0,
    lockStartTime: 0,
    unlockStartTime: 0,
    animProgress: 0,
    scale: 1,
    bgOpacity: 0,
    showPrompt: false,
    passwordInput: '',
    rejected: false,
    rejectedTime: 0
  }
}

export function updateLockdown(state: LockdownState, dt: number, now: number): void {
  const dtMs = dt * 1000

  switch (state.phase) {
    case 'normal': {
      // Detect sustained angry + shouting
      const isAngry = emotionBus.userExpression === 'angry' && emotionBus.userExpressionConfidence > 0.6
      const isShouting = emotionBus.smoothVolume > 0.7

      if (isAngry && isShouting && emotionBus.isFresh()) {
        state.angerAccumulator += dtMs
      } else {
        // Decay slowly so brief pauses don't reset
        state.angerAccumulator = Math.max(0, state.angerAccumulator - dtMs * 0.5)
      }

      if (state.angerAccumulator >= LOCKDOWN_THRESHOLD) {
        state.phase = 'locking'
        state.lockStartTime = now
        state.animProgress = 0
        emotionBus.lockdownActive = true
      }
      break
    }

    case 'locking': {
      const elapsed = now - state.lockStartTime
      state.animProgress = Math.min(1, elapsed / LOCK_ANIM_DURATION)

      // Ease-out cubic for dramatic effect
      const eased = 1 - Math.pow(1 - state.animProgress, 3)
      state.scale = 1 + eased * 4  // 1 → 5
      state.bgOpacity = eased

      if (state.animProgress >= 1) {
        state.phase = 'locked'
        state.showPrompt = false
        state.lockStartTime = now // reuse for prompt delay timing
      }
      break
    }

    case 'locked': {
      state.scale = 5
      state.bgOpacity = 1

      // Show prompt after delay
      if (!state.showPrompt && now - state.lockStartTime > PROMPT_DELAY) {
        state.showPrompt = true
      }

      // Menacing pulse
      state.scale = 5 + Math.sin(now / 1000 * 1.5) * 0.15

      // Rejected shake decay
      if (state.rejected && now - state.rejectedTime > 600) {
        state.rejected = false
      }
      break
    }

    case 'unlocking': {
      const elapsed = now - state.unlockStartTime
      state.animProgress = Math.min(1, elapsed / UNLOCK_ANIM_DURATION)

      // Ease-in-out
      const eased = state.animProgress < 0.5
        ? 2 * state.animProgress * state.animProgress
        : 1 - Math.pow(-2 * state.animProgress + 2, 2) / 2

      state.scale = 5 - eased * 4  // 5 → 1
      state.bgOpacity = 1 - eased

      if (state.animProgress >= 1) {
        state.phase = 'normal'
        state.angerAccumulator = 0
        state.scale = 1
        state.bgOpacity = 0
        state.showPrompt = false
        state.passwordInput = ''
        emotionBus.lockdownActive = false
      }
      break
    }
  }
}

export function isWarningPhase(state: LockdownState): boolean {
  return state.phase === 'normal' && state.angerAccumulator > WARNING_THRESHOLD
}

export function getWarningIntensity(state: LockdownState): number {
  if (state.angerAccumulator <= WARNING_THRESHOLD) return 0
  return Math.min(1, (state.angerAccumulator - WARNING_THRESHOLD) / (LOCKDOWN_THRESHOLD - WARNING_THRESHOLD))
}

export function isLocked(state: LockdownState): boolean {
  return state.phase === 'locked' || state.phase === 'locking' || state.phase === 'unlocking'
}

export function attemptUnlock(state: LockdownState, password: string, now: number): boolean {
  if (password.toLowerCase().trim() === SECRET_PASSWORD) {
    state.phase = 'unlocking'
    state.unlockStartTime = now
    state.animProgress = 0
    return true
  }
  state.rejected = true
  state.rejectedTime = now
  state.passwordInput = ''
  return false
}
