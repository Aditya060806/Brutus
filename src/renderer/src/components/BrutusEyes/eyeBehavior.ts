import { brutusService } from '@renderer/services/Brutus-voice-ai'
import type { BrutusEmotion } from '@renderer/services/Brutus-voice-ai'
import { emotionBus } from './emotionBus'
import type { FaceExpression } from './emotionBus'
import { lerp } from './eyeShapes'
import {
  createSpringVec2, updateSpringVec2, setSpringVec2Target,
  SPRING_DRIFT, type SpringVec2
} from './eyeSpring'

// ─── Smart-mix emotion mapping ───────────────────────────────────────
const FACE_MAP: Record<FaceExpression, BrutusEmotion> = {
  happy: 'happy',
  surprised: 'surprised',
  angry: 'sad',
  fearful: 'sad',
  sad: 'sad',
  disgusted: 'sad',
  neutral: 'neutral'
}

// Time-of-day personality baseline
export function getTimePersonality(): { blinkRateMult: number; wanderMult: number; emotionBias: BrutusEmotion | null } {
  const h = new Date().getHours()
  if (h >= 0 && h < 6)  return { blinkRateMult: 0.6,  wanderMult: 0.3,  emotionBias: 'sleepy' }
  if (h >= 6 && h < 10) return { blinkRateMult: 1.0,  wanderMult: 1.2,  emotionBias: null    }
  if (h >= 20)          return { blinkRateMult: 0.85, wanderMult: 0.7,  emotionBias: null    }
  return                       { blinkRateMult: 1.0,  wanderMult: 1.0,  emotionBias: null    }
}

export function resolveEmotion(): BrutusEmotion {
  const aiEmotion = brutusService.emotion || 'neutral'
  const aiState = brutusService.state

  // Priority 1: Lockdown overrides everything (handled externally by BrutusEyes)

  // Priority 2: Face expression (fresh + confident)
  if (emotionBus.isFresh() && emotionBus.userExpressionConfidence > 0.5) {
    const userExp = emotionBus.userExpression
    const mapped = FACE_MAP[userExp] || 'neutral'

    if (emotionBus.smoothVolume > 0.65) {
      return emotionBus.smoothVolume > 0.8 ? 'sad' : 'surprised'
    }
    if (emotionBus.smoothVolume > 0.01 && emotionBus.smoothVolume < 0.08 && userExp === 'neutral') {
      return 'love'
    }
    if (mapped !== 'neutral') return mapped
    if (userExp === 'happy' && emotionBus.smoothVolume > 0.4) return 'surprised'
  }

  // Priority 3: Conversation-driven emotion (timed, set by sentiment analysis)
  const convEmotion = emotionBus.getConversationEmotion()
  if (convEmotion) return convEmotion

  // Priority 4: AI state
  if (aiState === 'speaking') return 'happy'
  if (aiState === 'thinking') return 'neutral'
  if (!brutusService.isConnected) return 'sleepy'

  // Priority 5: Time-of-day bias (only when idle AND disconnected — never override active sessions)
  if (!brutusService.isConnected && (aiEmotion === 'neutral' || aiEmotion === 'sleepy')) {
    const tod = getTimePersonality()
    if (tod.emotionBias) return tod.emotionBias
  }

  return aiEmotion
}

// ─── Emotion intensity (from face confidence) ────────────────────────
export function getEmotionIntensity(): number {
  if (emotionBus.isFresh() && emotionBus.userExpressionConfidence > 0.5) {
    return Math.min(1, (emotionBus.userExpressionConfidence - 0.5) * 2 + 0.5)
  }
  return 0.85
}

// ─── Saccade system (autonomous eye jumps) ───────────────────────────
export interface SaccadeState {
  targetX: number
  targetY: number
  currentX: number
  currentY: number
  nextJumpTime: number
  isIdle: boolean
  lastMouseMoveTime: number
  lastFaceTime: number
}

export function createSaccadeState(): SaccadeState {
  return {
    targetX: 0, targetY: 0, currentX: 0, currentY: 0,
    nextJumpTime: performance.now() + 2000 + Math.random() * 2000,
    isIdle: false,
    lastMouseMoveTime: performance.now(),
    lastFaceTime: 0
  }
}

const SACCADE_POSITIONS = [
  { x: 0, y: 0 },
  { x: -0.5, y: 0 },
  { x: 0.5, y: 0 },
  { x: -0.3, y: -0.2 },
  { x: 0.3, y: -0.2 },
  { x: 0, y: 0.15 },
]

export function updateSaccade(
  state: SaccadeState,
  mouseX: number, mouseY: number,
  dt: number, now: number
): { x: number; y: number } {
  // Clear expired lookAt/moveTo overrides
  emotionBus.clearExpired()

  const timeSinceMouse = now - state.lastMouseMoveTime
  const timeSinceFace = now - state.lastFaceTime
  state.isIdle = timeSinceMouse > 5000 && timeSinceFace > 3000

  // Priority 1: External lookAt API override
  if (emotionBus.lookAtX !== null && emotionBus.lookAtY !== null) {
    state.targetX = emotionBus.lookAtX
    state.targetY = emotionBus.lookAtY!
    state.currentX += (state.targetX - state.currentX) * Math.min(dt * 12, 1)
    state.currentY += (state.targetY - state.currentY) * Math.min(dt * 12, 1)
    return { x: state.currentX, y: state.currentY }
  }

  // Priority 2: Face-lock
  if (emotionBus.isFresh() && emotionBus.faceDetected) {
    state.lastFaceTime = now
    state.targetX = 0
    state.targetY = 0
    state.currentX += (state.targetX - state.currentX) * Math.min(dt * 8, 1)
    state.currentY += (state.targetY - state.currentY) * Math.min(dt * 8, 1)
    return { x: state.currentX, y: state.currentY }
  }

  // Priority 3: Mouse tracking
  if (!state.isIdle) {
    state.targetX = mouseX * 0.75
    state.targetY = mouseY * 0.55
    state.currentX += (state.targetX - state.currentX) * Math.min(dt * 10, 1)
    state.currentY += (state.targetY - state.currentY) * Math.min(dt * 10, 1)
    return { x: state.currentX, y: state.currentY }
  }

  // Priority 4: Autonomous saccades
  if (now >= state.nextJumpTime) {
    const pos = SACCADE_POSITIONS[Math.floor(Math.random() * SACCADE_POSITIONS.length)]
    state.targetX = pos.x + (Math.random() - 0.5) * 0.15
    state.targetY = pos.y + (Math.random() - 0.5) * 0.1
    state.nextJumpTime = now + 2000 + Math.random() * 3000
  }

  const speed = Math.abs(state.targetX - state.currentX) > 0.1 ? 14 : 6
  state.currentX += (state.targetX - state.currentX) * Math.min(dt * speed, 1)
  state.currentY += (state.targetY - state.currentY) * Math.min(dt * speed, 1)

  const drift = Math.sin(now / 1000 * 0.3) * 0.05
  return { x: state.currentX + drift, y: state.currentY }
}

// ─── Asymmetric Blink state machine ─────────────────────────────────
export interface BlinkState {
  phase: 'open' | 'closing' | 'closed' | 'opening'
  tLeft: number         // 0=open, 1=closed (left eye)
  tRight: number        // 0=open, 1=closed (right eye, slightly delayed)
  nextBlinkTime: number
  doubleBlink: boolean
  doubleBlinkCount: number
  asymOffset: number    // ms delay between left and right (20-50ms)
  rightDelay: number    // accumulated delay tracking
}

export function createBlinkState(): BlinkState {
  return {
    phase: 'open',
    tLeft: 0,
    tRight: 0,
    nextBlinkTime: performance.now() + 2000 + Math.random() * 3000,
    doubleBlink: false,
    doubleBlinkCount: 0,
    asymOffset: 20 + Math.random() * 30,
    rightDelay: 0
  }
}

export function updateBlink(
  state: BlinkState, emotion: BrutusEmotion, dt: number, now: number
): { left: number; right: number } {
  const speed = emotion === 'sleepy' ? 4 : emotion === 'sad' ? 5 : 10

  if (state.phase === 'open') {
    state.tLeft = Math.max(0, state.tLeft - dt * speed)
    state.tRight = Math.max(0, state.tRight - dt * speed)
    if (now >= state.nextBlinkTime) {
      state.phase = 'closing'
      state.rightDelay = state.asymOffset / 1000 // convert ms to seconds
    }
  } else if (state.phase === 'closing') {
    state.tLeft += dt * speed
    // Right eye delayed
    state.rightDelay = Math.max(0, state.rightDelay - dt)
    if (state.rightDelay <= 0) {
      state.tRight += dt * speed
    }
    if (state.tLeft >= 1) {
      state.tLeft = 1
      state.tRight = Math.min(1, state.tRight)
      if (state.tRight >= 0.9) {
        state.tRight = 1
        state.phase = 'closed'
      }
    }
  } else if (state.phase === 'closed') {
    state.phase = 'opening'
    state.rightDelay = state.asymOffset / 1000 * 0.5 // smaller delay on open
  } else {
    state.tLeft -= dt * speed * 1.1 // open slightly faster (lid momentum feel)
    state.rightDelay = Math.max(0, state.rightDelay - dt)
    if (state.rightDelay <= 0) {
      state.tRight -= dt * speed * 1.1
    }

    // Lid momentum: slight overshoot on open
    if (state.tLeft < -0.03) state.tLeft = -0.03
    if (state.tRight < -0.03) state.tRight = -0.03

    if (state.tLeft <= 0 && state.tRight <= 0) {
      state.tLeft = 0
      state.tRight = 0
      if (state.doubleBlink && state.doubleBlinkCount < 1) {
        state.doubleBlinkCount++
        state.phase = 'closing'
      } else {
        state.phase = 'open'
        state.doubleBlink = false
        state.doubleBlinkCount = 0
        state.asymOffset = 20 + Math.random() * 30 // re-randomize for next blink
        const base = emotion === 'sleepy' ? 1500 : emotion === 'sad' ? 2000 : 3000
        state.nextBlinkTime = now + base + Math.random() * 3000
      }
    }
  }
  return { left: Math.max(0, state.tLeft), right: Math.max(0, state.tRight) }
}

export function triggerDoubleBlink(state: BlinkState) {
  state.phase = 'closing'
  state.doubleBlink = true
  state.doubleBlinkCount = 0
}

// ─── Physical Wandering System ──────────────────────────────────────
export interface WanderState {
  spring: SpringVec2
  nextPeekTime: number
  isPeeking: boolean
  peekStartTime: number
  peekDuration: number
  peekDir: { x: number; y: number }
}

export function createWanderState(): WanderState {
  return {
    spring: createSpringVec2(0, 0, SPRING_DRIFT.stiffness, SPRING_DRIFT.damping),
    nextPeekTime: performance.now() + 15000 + Math.random() * 20000,
    isPeeking: false,
    peekStartTime: 0,
    peekDuration: 2000,
    peekDir: { x: 0, y: 0 }
  }
}

export function updateWander(
  state: WanderState, dt: number, now: number,
  isIdle: boolean, emotion: BrutusEmotion
): { x: number; y: number } {
  // Priority 1: External moveTo API override
  if (emotionBus.moveToX !== null && emotionBus.moveToY !== null) {
    setSpringVec2Target(state.spring, emotionBus.moveToX, emotionBus.moveToY!)
    return updateSpringVec2(state.spring, dt)
  }

  // Speaking forward lean (toward center = toward user)
  if (brutusService.state === 'speaking') {
    setSpringVec2Target(state.spring, 0, -0.015)
    return updateSpringVec2(state.spring, dt)
  }

  // Startle recoil (on sudden loud volume)
  if (emotionBus.smoothVolume > 0.8) {
    setSpringVec2Target(state.spring, 0, -0.04)
    return updateSpringVec2(state.spring, dt)
  }

  // Not idle → return to center
  if (!isIdle) {
    setSpringVec2Target(state.spring, 0, 0)
    return updateSpringVec2(state.spring, dt)
  }

  // Curious peek (occasional large shift to one side)
  if (!state.isPeeking && now >= state.nextPeekTime) {
    state.isPeeking = true
    state.peekStartTime = now
    state.peekDuration = 1500 + Math.random() * 1500
    const angle = Math.random() * Math.PI * 2
    state.peekDir = { x: Math.cos(angle) * 0.08, y: Math.sin(angle) * 0.05 }
  }

  if (state.isPeeking) {
    const elapsed = now - state.peekStartTime
    if (elapsed < state.peekDuration * 0.4) {
      // Move to peek position
      setSpringVec2Target(state.spring, state.peekDir.x, state.peekDir.y)
    } else if (elapsed < state.peekDuration) {
      // Return from peek
      setSpringVec2Target(state.spring, 0, 0)
    } else {
      state.isPeeking = false
      state.nextPeekTime = now + 15000 + Math.random() * 25000
    }
  } else {
    // Gentle idle drift (Lissajous figure)
    const driftX = Math.sin(now / 1000 * 0.12) * 0.03 + Math.sin(now / 1000 * 0.07) * 0.015
    const driftY = Math.cos(now / 1000 * 0.1) * 0.02 + Math.cos(now / 1000 * 0.05) * 0.01
    setSpringVec2Target(state.spring, driftX, driftY)
  }

  return updateSpringVec2(state.spring, dt)
}

// ─── Boot/Shutdown state machine ─────────────────────────────────────
export type BootPhase = 'off' | 'booting' | 'running' | 'shutting_down'

export interface BootState {
  phase: BootPhase
  progress: number
  startTime: number
  wasConnected: boolean
}

export function createBootState(): BootState {
  return {
    phase: brutusService.isConnected ? 'running' : 'off',
    progress: brutusService.isConnected ? 1 : 0,
    startTime: 0,
    wasConnected: brutusService.isConnected
  }
}

const BOOT_DURATION = 2000
const SHUTDOWN_DURATION = 1200

export function updateBootState(state: BootState, now: number): void {
  const connected = brutusService.isConnected

  if (connected && !state.wasConnected) {
    state.phase = 'booting'
    state.startTime = now
    state.progress = 0
  } else if (!connected && state.wasConnected) {
    state.phase = 'shutting_down'
    state.startTime = now
    state.progress = 0
  }
  state.wasConnected = connected

  if (state.phase === 'booting') {
    state.progress = Math.min(1, (now - state.startTime) / BOOT_DURATION)
    if (state.progress >= 1) state.phase = 'running'
  } else if (state.phase === 'shutting_down') {
    state.progress = Math.min(1, (now - state.startTime) / SHUTDOWN_DURATION)
    if (state.progress >= 1) state.phase = 'off'
  }
}

// ─── Particle system ─────────────────────────────────────────────────
export interface Particle {
  x: number; y: number; vx: number; vy: number
  life: number; maxLife: number; size: number
  type: 'spark' | 'ember' | 'drop' | 'heart' | 'dust' | 'shard' | 'dot'
}

export function spawnParticle(cx: number, cy: number, w: number, emotion: BrutusEmotion): Particle {
  const bx = cx + (Math.random() - 0.5) * w * 0.8
  const base = { x: bx, y: cy, life: 0, maxLife: 1.5 + Math.random() * 1.5, size: 2 + Math.random() * 3 }
  switch (emotion) {
    case 'happy':
      // Warm embers — rise fast, orange glow
      return { ...base, vx: (Math.random() - 0.5) * 22, vy: -28 - Math.random() * 25, type: 'ember', maxLife: 1.0 + Math.random() * 0.8, size: 2 + Math.random() * 3 }
    case 'angry':
      // Jagged shards — explode radially fast
      return { ...base, vx: (Math.random() - 0.5) * 60, vy: -25 - Math.random() * 35, type: 'shard', maxLife: 0.6 + Math.random() * 0.4, size: 2.5 + Math.random() * 2.5 }
    case 'sad':
      // Teardrops — fall slowly
      return { ...base, y: cy, vx: (Math.random() - 0.5) * 6, vy: -2 + Math.random() * 8, type: 'drop', size: 1.8 + Math.random() * 2, maxLife: 2.0 + Math.random() * 1.5 }
    case 'love':
      // Hearts — float upward with sway (guaranteed, camera-independent)
      return { ...base, vx: (Math.random() - 0.5) * 16, vy: -18 - Math.random() * 20, type: 'heart', size: 3.5 + Math.random() * 5, maxLife: 1.8 + Math.random() * 1.2 }
    case 'surprised':
      // Star sparks — explode outward radially
      return { ...base, vx: (Math.random() - 0.5) * 70, vy: (Math.random() - 0.5) * 70, type: 'spark', size: 1.5 + Math.random() * 2.5, maxLife: 0.5 + Math.random() * 0.4 }
    case 'neutral':
      // Floating orbiting dots for thinking state
      return { ...base, vx: (Math.random() - 0.5) * 6, vy: -3 - Math.random() * 6, type: 'dot', size: 1.5 + Math.random() * 1.5, maxLife: 2.5 + Math.random() * 2 }
    default:
      return { ...base, vx: (Math.random() - 0.5) * 8, vy: -5 - Math.random() * 10, type: 'dust', size: 1 + Math.random() * 2, maxLife: 2 + Math.random() * 2.5 }
  }
}

// ─── Tear state ──────────────────────────────────────────────────────
export interface TearState {
  leftAlpha: number
  rightAlpha: number
  leftY: number
  rightY: number
  sadDuration: number
}

export function createTearState(): TearState {
  return { leftAlpha: 0, rightAlpha: 0, leftY: 0, rightY: 0, sadDuration: 0 }
}

export function updateTears(state: TearState, emotion: BrutusEmotion, dt: number): void {
  if (emotion === 'sad') {
    state.sadDuration += dt
    if (state.sadDuration > 3) {
      state.leftAlpha = Math.min(0.7, state.leftAlpha + dt * 0.3)
      state.rightAlpha = Math.min(0.5, state.rightAlpha + dt * 0.2)
      state.leftY += dt * 8
      state.rightY += dt * 6
      if (state.leftY > 30) { state.leftY = 0; state.leftAlpha = 0.1 }
      if (state.rightY > 25) { state.rightY = 0; state.rightAlpha = 0.05 }
    }
  } else {
    state.sadDuration = Math.max(0, state.sadDuration - dt * 2)
    state.leftAlpha = Math.max(0, state.leftAlpha - dt * 2)
    state.rightAlpha = Math.max(0, state.rightAlpha - dt * 2)
    state.leftY = 0
    state.rightY = 0
  }
}

// ─── Thinking pupil drift ────────────────────────────────────────────
export function getThinkingDrift(now: number): { x: number; y: number } {
  if (brutusService.state === 'thinking') {
    return {
      x: Math.sin(now / 1000 * 0.7) * 0.4,
      y: Math.cos(now / 1000 * 0.5) * 0.15
    }
  }
  return { x: 0, y: 0 }
}

// ─── Pupil Hippus (constant micro-oscillation) ──────────────────────
export function getPupilHippus(now: number): number {
  // 0.5-1Hz oscillation, very subtle
  return 1 + Math.sin(now / 1000 * 0.7 * Math.PI * 2) * 0.02
    + Math.sin(now / 1000 * 1.1 * Math.PI * 2) * 0.012
}

// ─── Flinch on shouting ──────────────────────────────────────────────
export function getFlinchFactor(): number {
  return emotionBus.smoothVolume > 0.6 ? lerp(1, 0.2, (emotionBus.smoothVolume - 0.6) / 0.4) : 1
}
