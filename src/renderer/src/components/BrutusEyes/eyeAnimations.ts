// ─── Gesture Animation System + Idle Personality Scheduler ──────────
// Data-driven keyframe sequences for signature personality gestures
// and randomized idle quirks that make Brutus feel alive.

// ─── Keyframe types ─────────────────────────────────────────────────
export interface GestureKeyframe {
  time: number          // seconds from start
  // All optional — only specified fields are applied
  leftLidTop?: number
  leftLidBot?: number
  rightLidTop?: number
  rightLidBot?: number
  pupilX?: number
  pupilY?: number
  pupilScale?: number
  browLeftAngle?: number
  browRightAngle?: number
  browHeight?: number
  glowBoost?: number     // additive glow multiplier
  eyeOffsetX?: number    // physical wandering offset (fraction of canvas)
  eyeOffsetY?: number
  widthScale?: number
  heightScale?: number
}

export interface GestureSequence {
  name: string
  duration: number       // total seconds
  keyframes: GestureKeyframe[]
  priority: number       // higher = overrides lower
}

// ─── Gesture Library ────────────────────────────────────────────────
export const GESTURES: Record<string, GestureSequence> = {
  greetingWink: {
    name: 'greetingWink',
    duration: 0.9,
    priority: 5,
    keyframes: [
      { time: 0, rightLidTop: 0, leftLidTop: 0 },
      { time: 0.15, rightLidTop: 1.0, leftLidTop: 0.05, browLeftAngle: 0.1 },
      { time: 0.35, rightLidTop: 1.0, leftLidTop: 0.05 },
      { time: 0.6, rightLidTop: 0, leftLidTop: 0, browLeftAngle: 0 },
      { time: 0.9, rightLidTop: 0, leftLidTop: 0 }
    ]
  },

  acknowledgmentNod: {
    name: 'acknowledgmentNod',
    duration: 0.6,
    priority: 3,
    keyframes: [
      { time: 0, eyeOffsetY: 0 },
      { time: 0.15, eyeOffsetY: 0.04, pupilY: 0.2 },
      { time: 0.3, eyeOffsetY: 0.06, pupilY: 0.3 },
      { time: 0.45, eyeOffsetY: 0.02, pupilY: 0.1 },
      { time: 0.6, eyeOffsetY: 0, pupilY: 0 }
    ]
  },

  playfulRoll: {
    name: 'playfulRoll',
    duration: 0.8,
    priority: 2,
    keyframes: [
      { time: 0, pupilX: 0, pupilY: -0.5 },
      { time: 0.2, pupilX: 0.5, pupilY: 0 },
      { time: 0.4, pupilX: 0, pupilY: 0.4 },
      { time: 0.6, pupilX: -0.5, pupilY: 0 },
      { time: 0.8, pupilX: 0, pupilY: 0 }
    ]
  },

  mischievousSquint: {
    name: 'mischievousSquint',
    duration: 1.2,
    priority: 4,
    keyframes: [
      { time: 0, leftLidTop: 0, rightLidTop: 0, eyeOffsetX: 0 },
      { time: 0.2, leftLidTop: 0.35, rightLidTop: 0.1, eyeOffsetX: -0.02, browLeftAngle: 0.2, browRightAngle: -0.1 },
      { time: 0.8, leftLidTop: 0.35, rightLidTop: 0.1, eyeOffsetX: -0.02 },
      { time: 1.2, leftLidTop: 0, rightLidTop: 0, eyeOffsetX: 0, browLeftAngle: 0, browRightAngle: 0 }
    ]
  },

  deepFocus: {
    name: 'deepFocus',
    duration: 2.0,
    priority: 3,
    keyframes: [
      { time: 0, leftLidTop: 0, rightLidTop: 0, pupilScale: 1, glowBoost: 0 },
      { time: 0.5, leftLidTop: 0.15, rightLidTop: 0.15, pupilScale: 0.7, glowBoost: -0.2, browHeight: 0.18 },
      { time: 1.5, leftLidTop: 0.2, rightLidTop: 0.2, pupilScale: 0.6, glowBoost: -0.3, browHeight: 0.15 },
      { time: 2.0, leftLidTop: 0.2, rightLidTop: 0.2, pupilScale: 0.6, glowBoost: -0.3 }
    ]
  },

  eurekaMoment: {
    name: 'eurekaMoment',
    duration: 1.0,
    priority: 6,
    keyframes: [
      { time: 0, pupilScale: 0.6, widthScale: 0.95, heightScale: 0.85, glowBoost: -0.3 },
      { time: 0.15, pupilScale: 1.6, widthScale: 1.25, heightScale: 1.35, glowBoost: 1.0, browHeight: 0.45 },
      { time: 0.4, pupilScale: 1.3, widthScale: 1.15, heightScale: 1.2, glowBoost: 0.5 },
      { time: 1.0, pupilScale: 1.0, widthScale: 1.0, heightScale: 1.0, glowBoost: 0, browHeight: 0.28 }
    ]
  },

  confusedTilt: {
    name: 'confusedTilt',
    duration: 1.5,
    priority: 3,
    keyframes: [
      { time: 0, leftLidTop: 0, rightLidTop: 0, eyeOffsetX: 0 },
      { time: 0.3, leftLidTop: 0.1, rightLidTop: 0, browLeftAngle: -0.2, browRightAngle: 0.3, eyeOffsetX: 0.02, widthScale: 0.95, heightScale: 1.05 },
      { time: 1.0, leftLidTop: 0.1, rightLidTop: 0, browLeftAngle: -0.2, browRightAngle: 0.3 },
      { time: 1.5, leftLidTop: 0, rightLidTop: 0, browLeftAngle: 0, browRightAngle: 0, eyeOffsetX: 0, widthScale: 1, heightScale: 1 }
    ]
  },

  listeningIntently: {
    name: 'listeningIntently',
    duration: 1.5,
    priority: 3,
    keyframes: [
      { time: 0, pupilScale: 1, widthScale: 1, heightScale: 1 },
      { time: 0.3, pupilScale: 1.2, widthScale: 1.05, heightScale: 1.08, glowBoost: 0.15 },
      { time: 1.2, pupilScale: 1.2, widthScale: 1.05, heightScale: 1.08, glowBoost: 0.15 },
      { time: 1.5, pupilScale: 1, widthScale: 1, heightScale: 1, glowBoost: 0 }
    ]
  },

  processingLoading: {
    name: 'processingLoading',
    duration: 2.5,
    priority: 4,
    keyframes: [
      { time: 0, pupilScale: 1, glowBoost: 0 },
      { time: 0.3, pupilScale: 0.65, glowBoost: 0.2 },
      { time: 2.0, pupilScale: 0.6, glowBoost: 0.3 },
      { time: 2.5, pupilScale: 1, glowBoost: 0 }
    ]
  },

  dismissiveBlink: {
    name: 'dismissiveBlink',
    duration: 0.8,
    priority: 3,
    keyframes: [
      { time: 0, leftLidTop: 0, rightLidTop: 0 },
      { time: 0.2, leftLidTop: 1, rightLidTop: 1 },
      { time: 0.5, leftLidTop: 1, rightLidTop: 1 },
      { time: 0.8, leftLidTop: 0, rightLidTop: 0 }
    ]
  },

  startle: {
    name: 'startle',
    duration: 0.7,
    priority: 7,
    keyframes: [
      { time: 0, pupilScale: 1, widthScale: 1, heightScale: 1, eyeOffsetY: 0 },
      { time: 0.08, pupilScale: 1.5, widthScale: 1.3, heightScale: 1.4, glowBoost: 0.8, eyeOffsetY: -0.03 },
      { time: 0.25, pupilScale: 1.3, widthScale: 1.15, heightScale: 1.2, glowBoost: 0.3, eyeOffsetY: -0.01 },
      { time: 0.7, pupilScale: 1, widthScale: 1, heightScale: 1, glowBoost: 0, eyeOffsetY: 0 }
    ]
  },

  intimidationStare: {
    name: 'intimidationStare',
    duration: 2.0,
    priority: 8,
    keyframes: [
      { time: 0, leftLidTop: 0, rightLidTop: 0, pupilScale: 1 },
      { time: 0.5, leftLidTop: 0.4, rightLidTop: 0.4, leftLidBot: 0.15, rightLidBot: 0.15, pupilScale: 0.4, glowBoost: 0.8 },
      { time: 1.5, leftLidTop: 0.4, rightLidTop: 0.4, leftLidBot: 0.15, rightLidBot: 0.15, pupilScale: 0.35, glowBoost: 1.0 },
      { time: 2.0, leftLidTop: 0.4, rightLidTop: 0.4, pupilScale: 0.35, glowBoost: 1.0 }
    ]
  },

  heartEyes: {
    name: 'heartEyes',
    duration: 2.5,
    priority: 6,
    keyframes: [
      { time: 0,   pupilScale: 1.0, widthScale: 1.0,  heightScale: 1.0,  glowBoost: 0 },
      { time: 0.2, pupilScale: 1.5, widthScale: 1.15, heightScale: 1.2,  glowBoost: 1.2, browHeight: 0.38 },
      { time: 0.5, pupilScale: 1.7, widthScale: 1.2,  heightScale: 1.25, glowBoost: 1.5, browHeight: 0.4  },
      { time: 1.5, pupilScale: 1.6, widthScale: 1.18, heightScale: 1.22, glowBoost: 1.3 },
      { time: 2.0, pupilScale: 1.3, widthScale: 1.1,  heightScale: 1.1,  glowBoost: 0.6 },
      { time: 2.5, pupilScale: 1.0, widthScale: 1.0,  heightScale: 1.0,  glowBoost: 0  }
    ]
  },

  thinkingLookUpLeft: {
    name: 'thinkingLookUpLeft',
    duration: 2.0,
    priority: 3,
    keyframes: [
      { time: 0,   pupilX: 0,     pupilY: 0,     pupilScale: 1.0, browLeftAngle: 0,    browRightAngle: 0,    browHeight: 0.28 },
      { time: 0.3, pupilX: -0.55, pupilY: -0.45, pupilScale: 0.8, browLeftAngle: -0.2, browRightAngle: 0.15, browHeight: 0.35 },
      { time: 1.3, pupilX: -0.55, pupilY: -0.45, pupilScale: 0.75, browLeftAngle: -0.25, browRightAngle: 0.2 },
      { time: 2.0, pupilX: 0,     pupilY: 0,     pupilScale: 1.0, browLeftAngle: 0,    browRightAngle: 0,    browHeight: 0.28 }
    ]
  },

  excitedDance: {
    name: 'excitedDance',
    duration: 1.2,
    priority: 5,
    keyframes: [
      { time: 0,   pupilX: 0,     pupilY: 0,    pupilScale: 1.0, glowBoost: 0   },
      { time: 0.1, pupilX: 0.4,   pupilY: -0.2, pupilScale: 1.3, glowBoost: 0.4 },
      { time: 0.2, pupilX: -0.4,  pupilY: 0.1,  pupilScale: 1.4, glowBoost: 0.5 },
      { time: 0.3, pupilX: 0.35,  pupilY: -0.3, pupilScale: 1.3, glowBoost: 0.4 },
      { time: 0.4, pupilX: -0.35, pupilY: 0.2,  pupilScale: 1.2, glowBoost: 0.3, widthScale: 1.1, heightScale: 1.1 },
      { time: 0.55, pupilX: 0.2,  pupilY: -0.1, pupilScale: 1.15, glowBoost: 0.2 },
      { time: 0.7, pupilX: -0.2,  pupilY: 0.1,  pupilScale: 1.1,  glowBoost: 0.15 },
      { time: 1.0, pupilX: 0,     pupilY: 0,    pupilScale: 1.0,  glowBoost: 0 },
      { time: 1.2, pupilX: 0,     pupilY: 0,    pupilScale: 1.0,  glowBoost: 0 }
    ]
  },

  sadTearBlink: {
    name: 'sadTearBlink',
    duration: 3.0,
    priority: 4,
    keyframes: [
      { time: 0,   leftLidTop: 0,    rightLidTop: 0,    pupilScale: 1.0, glowBoost: 0,    browLeftAngle: -0.1, browRightAngle: 0.1 },
      { time: 0.6, leftLidTop: 0.15, rightLidTop: 0.15, pupilScale: 1.3, glowBoost: -0.3, browLeftAngle: -0.35, browRightAngle: 0.35, browHeight: 0.22 },
      { time: 1.2, leftLidTop: 1.0,  rightLidTop: 1.0,  pupilScale: 1.4, glowBoost: -0.4 },
      { time: 1.8, leftLidTop: 1.0,  rightLidTop: 1.0 },
      { time: 2.5, leftLidTop: 0.15, rightLidTop: 0.15, pupilScale: 1.3, glowBoost: -0.3 },
      { time: 3.0, leftLidTop: 0,    rightLidTop: 0,    pupilScale: 1.0, glowBoost: 0,    browLeftAngle: -0.1, browRightAngle: 0.1 }
    ]
  },

  jokeLaugh: {
    name: 'jokeLaugh',
    duration: 1.6,
    priority: 4,
    keyframes: [
      { time: 0,    leftLidTop: 0,    rightLidTop: 0,    eyeOffsetX: 0,     browLeftAngle: 0,   browRightAngle: 0,   glowBoost: 0   },
      { time: 0.1,  leftLidTop: 0.45, rightLidTop: 0.45, eyeOffsetX: 0.01,  browLeftAngle: 0.2, browRightAngle: -0.2, glowBoost: 0.4 },
      { time: 0.2,  leftLidTop: 0.35, rightLidTop: 0.35, eyeOffsetX: -0.01, glowBoost: 0.3 },
      { time: 0.3,  leftLidTop: 0.5,  rightLidTop: 0.5,  eyeOffsetX: 0.01,  glowBoost: 0.45 },
      { time: 0.45, leftLidTop: 0.4,  rightLidTop: 0.4,  eyeOffsetX: -0.01 },
      { time: 0.6,  leftLidTop: 0.5,  rightLidTop: 0.5,  eyeOffsetX: 0,     glowBoost: 0.35 },
      { time: 1.0,  leftLidTop: 0.4,  rightLidTop: 0.4,  glowBoost: 0.2 },
      { time: 1.6,  leftLidTop: 0,    rightLidTop: 0,    eyeOffsetX: 0,     browLeftAngle: 0,   browRightAngle: 0,   glowBoost: 0   }
    ]
  },

  taskComplete: {
    name: 'taskComplete',
    duration: 1.4,
    priority: 6,
    keyframes: [
      { time: 0,    pupilScale: 1.0, widthScale: 1.0,  heightScale: 1.0,  glowBoost: 0,   eyeOffsetY: 0     },
      { time: 0.08, pupilScale: 1.8, widthScale: 1.35, heightScale: 1.45, glowBoost: 1.8, eyeOffsetY: -0.04, browHeight: 0.5 },
      { time: 0.25, pupilScale: 1.5, widthScale: 1.2,  heightScale: 1.3,  glowBoost: 1.2, eyeOffsetY: -0.02 },
      { time: 0.5,  pupilScale: 1.2, widthScale: 1.1,  heightScale: 1.15, glowBoost: 0.6, eyeOffsetY: 0.02  },
      { time: 0.7,  pupilScale: 1.1, widthScale: 1.05, heightScale: 1.08, eyeOffsetY: 0   },
      { time: 1.4,  pupilScale: 1.0, widthScale: 1.0,  heightScale: 1.0,  glowBoost: 0,   eyeOffsetY: 0     }
    ]
  },

  curiousTilt: {
    name: 'curiousTilt',
    duration: 1.8,
    priority: 3,
    keyframes: [
      { time: 0,   pupilX: 0,    pupilY: 0,     pupilScale: 1.0, browLeftAngle: 0,    browRightAngle: 0,    browHeight: 0.28, eyeOffsetX: 0    },
      { time: 0.25, pupilX: 0.3, pupilY: -0.35, pupilScale: 1.15, browLeftAngle: 0.3, browRightAngle: -0.1, browHeight: 0.38, eyeOffsetX: 0.02 },
      { time: 1.1,  pupilX: 0.3, pupilY: -0.35, pupilScale: 1.1,  browLeftAngle: 0.25, browRightAngle: -0.1 },
      { time: 1.8,  pupilX: 0,   pupilY: 0,     pupilScale: 1.0, browLeftAngle: 0,    browRightAngle: 0,    browHeight: 0.28, eyeOffsetX: 0    }
    ]
  },

  shyLookAway: {
    name: 'shyLookAway',
    duration: 2.2,
    priority: 3,
    keyframes: [
      { time: 0,   pupilX: 0,     pupilY: 0,    pupilScale: 1.0, leftLidTop: 0,    rightLidTop: 0,    eyeOffsetX: 0     },
      { time: 0.4, pupilX: -0.7,  pupilY: 0.15, pupilScale: 0.85, leftLidTop: 0.2, rightLidTop: 0.25, eyeOffsetX: -0.03, glowBoost: -0.2 },
      { time: 1.4, pupilX: -0.65, pupilY: 0.1,  pupilScale: 0.82, leftLidTop: 0.2, rightLidTop: 0.25 },
      { time: 2.2, pupilX: 0,     pupilY: 0,    pupilScale: 1.0, leftLidTop: 0,    rightLidTop: 0,    eyeOffsetX: 0,    glowBoost: 0    }
    ]
  }
}

// ─── Animation Player ───────────────────────────────────────────────
export interface AnimationPlayerState {
  active: boolean
  gestureName: string | null
  startTime: number
  duration: number
  priority: number
  keyframes: GestureKeyframe[]
}

export function createAnimationPlayer(): AnimationPlayerState {
  return { active: false, gestureName: null, startTime: 0, duration: 0, priority: 0, keyframes: [] }
}

export function playGesture(player: AnimationPlayerState, name: string, now: number): boolean {
  const gesture = GESTURES[name]
  if (!gesture) return false
  // Only override if new gesture has higher or equal priority
  if (player.active && gesture.priority < player.priority) return false

  player.active = true
  player.gestureName = name
  player.startTime = now
  player.duration = gesture.duration * 1000 // convert to ms
  player.priority = gesture.priority
  player.keyframes = gesture.keyframes
  return true
}

function lerpKeyframes(a: GestureKeyframe, b: GestureKeyframe, t: number): GestureKeyframe {
  const result: GestureKeyframe = { time: 0 }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof GestureKeyframe>
  for (const key of keys) {
    if (key === 'time') continue
    const av = a[key] as number | undefined
    const bv = b[key] as number | undefined
    if (av !== undefined && bv !== undefined) {
      (result as any)[key] = av + (bv - av) * t
    } else if (bv !== undefined) {
      (result as any)[key] = bv * t
    } else if (av !== undefined) {
      (result as any)[key] = av * (1 - t)
    }
  }
  return result
}

export function sampleGesture(player: AnimationPlayerState, now: number): GestureKeyframe | null {
  if (!player.active) return null
  const elapsed = (now - player.startTime) / 1000 // in seconds
  if (elapsed >= player.keyframes[player.keyframes.length - 1].time) {
    player.active = false
    player.gestureName = null
    player.priority = 0
    return null
  }

  // Find surrounding keyframes
  let a = player.keyframes[0]
  let b = player.keyframes[1] || a
  for (let i = 0; i < player.keyframes.length - 1; i++) {
    if (elapsed >= player.keyframes[i].time && elapsed < player.keyframes[i + 1].time) {
      a = player.keyframes[i]
      b = player.keyframes[i + 1]
      break
    }
  }

  const segDur = b.time - a.time
  const t = segDur > 0 ? (elapsed - a.time) / segDur : 0
  // Smooth ease (cubic)
  const eased = t * t * (3 - 2 * t)
  return lerpKeyframes(a, b, eased)
}

// ─── Idle Personality Scheduler ─────────────────────────────────────
export type IdleQuirkType =
  | 'curiousMicroSquint'
  | 'slowContemplativeBlink'
  | 'attentionShift'
  | 'subtleSmileSquint'
  | 'irisPulse'
  | 'eyebrowMicroRaise'

export interface IdleQuirk {
  type: IdleQuirkType
  nextTime: number     // ms timestamp
  minInterval: number  // ms
  maxInterval: number  // ms
  active: boolean
  startTime: number
  duration: number     // ms
}

export interface IdleSchedulerState {
  quirks: IdleQuirk[]
  breathPhase: number       // 0-2π for breathing variation
  breathDepthTarget: number // target amplitude multiplier
  breathDepth: number       // current amplitude multiplier
}

function makeQuirk(type: IdleQuirkType, minS: number, maxS: number, durMs: number): IdleQuirk {
  const now = performance.now()
  return {
    type,
    nextTime: now + (minS + Math.random() * (maxS - minS)) * 1000,
    minInterval: minS * 1000,
    maxInterval: maxS * 1000,
    active: false,
    startTime: 0,
    duration: durMs
  }
}

export function createIdleScheduler(): IdleSchedulerState {
  return {
    quirks: [
      makeQuirk('curiousMicroSquint', 8, 15, 200),
      makeQuirk('slowContemplativeBlink', 20, 40, 700),
      makeQuirk('attentionShift', 6, 12, 350),
      makeQuirk('subtleSmileSquint', 15, 25, 500),
      makeQuirk('irisPulse', 10, 20, 400),
      makeQuirk('eyebrowMicroRaise', 12, 20, 300),
    ],
    breathPhase: 0,
    breathDepthTarget: 1.0,
    breathDepth: 1.0
  }
}

export interface IdleQuirkOutput {
  leftLidTopAdd: number
  leftLidBotAdd: number
  rightLidTopAdd: number
  rightLidBotAdd: number
  pupilXAdd: number
  pupilYAdd: number
  irisBrightnessAdd: number
  browLeftAngleAdd: number
  browRightAngleAdd: number
  breathMultiplier: number
}

export function updateIdleScheduler(
  state: IdleSchedulerState,
  now: number,
  dt: number,
  isIdle: boolean
): IdleQuirkOutput {
  const out: IdleQuirkOutput = {
    leftLidTopAdd: 0, leftLidBotAdd: 0,
    rightLidTopAdd: 0, rightLidBotAdd: 0,
    pupilXAdd: 0, pupilYAdd: 0,
    irisBrightnessAdd: 0,
    browLeftAngleAdd: 0, browRightAngleAdd: 0,
    breathMultiplier: 1.0
  }

  // Breathing depth variation (always runs)
  state.breathPhase += dt * 0.15
  if (state.breathPhase > Math.PI * 2) {
    state.breathPhase -= Math.PI * 2
    state.breathDepthTarget = 0.6 + Math.random() * 0.8 // 0.6-1.4x
  }
  state.breathDepth += (state.breathDepthTarget - state.breathDepth) * dt * 0.5
  out.breathMultiplier = state.breathDepth

  for (const q of state.quirks) {
    // Check if quirk should activate
    if (!q.active && now >= q.nextTime && isIdle) {
      q.active = true
      q.startTime = now
    }

    // Update active quirks
    if (q.active) {
      const elapsed = now - q.startTime
      if (elapsed >= q.duration) {
        q.active = false
        q.nextTime = now + q.minInterval + Math.random() * (q.maxInterval - q.minInterval)
        continue
      }

      // Smooth bell curve: ramp up then down
      const t = elapsed / q.duration
      const intensity = Math.sin(t * Math.PI) // 0→1→0

      switch (q.type) {
        case 'curiousMicroSquint':
          // Randomly pick left or right (seeded by startTime)
          if (q.startTime % 2 > 1) {
            out.leftLidTopAdd += 0.12 * intensity
          } else {
            out.rightLidTopAdd += 0.12 * intensity
          }
          break
        case 'slowContemplativeBlink':
          out.leftLidTopAdd += 0.95 * intensity
          out.rightLidTopAdd += 0.95 * intensity
          break
        case 'attentionShift': {
          const angle = (q.startTime % 6.28)
          out.pupilXAdd += Math.cos(angle) * 0.3 * intensity
          out.pupilYAdd += Math.sin(angle) * 0.15 * intensity
          break
        }
        case 'subtleSmileSquint':
          out.leftLidBotAdd += 0.15 * intensity
          out.rightLidBotAdd += 0.15 * intensity
          break
        case 'irisPulse':
          out.irisBrightnessAdd += 0.3 * intensity
          break
        case 'eyebrowMicroRaise':
          if (q.startTime % 2 > 1) {
            out.browLeftAngleAdd += 0.12 * intensity
          } else {
            out.browRightAngleAdd += 0.12 * intensity
          }
          break
      }
    }
  }

  return out
}
