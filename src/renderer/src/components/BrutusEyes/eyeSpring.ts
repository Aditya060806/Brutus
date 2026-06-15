// ─── Damped Spring Physics ──────────────────────────────────────────
// Replaces linear lerp with organic overshoot + settle behavior.

export interface SpringValue {
  pos: number
  vel: number
  target: number
  stiffness: number  // how fast it snaps (higher = faster)
  damping: number    // how quickly oscillation dies (higher = less bounce)
}

export function createSpring(initial: number, stiffness: number, damping: number): SpringValue {
  return { pos: initial, vel: 0, target: initial, stiffness, damping }
}

export function updateSpring(s: SpringValue, dt: number): number {
  const force = (s.target - s.pos) * s.stiffness
  const dampForce = -s.vel * s.damping
  s.vel += (force + dampForce) * dt
  s.pos += s.vel * dt

  // Snap to target when close and slow (avoid infinite micro-oscillation)
  if (Math.abs(s.pos - s.target) < 0.0001 && Math.abs(s.vel) < 0.001) {
    s.pos = s.target
    s.vel = 0
  }
  return s.pos
}

export function setSpringTarget(s: SpringValue, target: number): void {
  s.target = target
}

export function springImmediate(s: SpringValue, value: number): void {
  s.pos = value
  s.target = value
  s.vel = 0
}

// ─── Presets ────────────────────────────────────────────────────────
// Each returns { stiffness, damping } tuple

/** Fast snap, minimal overshoot — for pupils */
export const SPRING_SNAPPY = { stiffness: 300, damping: 22 }

/** Medium speed, noticeable bounce — for eyelids */
export const SPRING_BOUNCY = { stiffness: 180, damping: 14 }

/** Slow, gentle overshoot — for shape/color transitions */
export const SPRING_GENTLE = { stiffness: 80, damping: 12 }

/** Very stiff, almost no bounce — for eyebrows */
export const SPRING_BROW = { stiffness: 250, damping: 20 }

/** Floating drift — for physical wandering */
export const SPRING_DRIFT = { stiffness: 15, damping: 6 }

// ─── Multi-dimensional spring helper ────────────────────────────────
export interface SpringVec2 {
  x: SpringValue
  y: SpringValue
}

export function createSpringVec2(
  ix: number, iy: number,
  stiffness: number, damping: number
): SpringVec2 {
  return {
    x: createSpring(ix, stiffness, damping),
    y: createSpring(iy, stiffness, damping)
  }
}

export function updateSpringVec2(sv: SpringVec2, dt: number): { x: number; y: number } {
  return {
    x: updateSpring(sv.x, dt),
    y: updateSpring(sv.y, dt)
  }
}

export function setSpringVec2Target(sv: SpringVec2, tx: number, ty: number): void {
  sv.x.target = tx
  sv.y.target = ty
}
