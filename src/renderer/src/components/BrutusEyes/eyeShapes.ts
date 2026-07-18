import type { BrutusEmotion } from '@renderer/services/Brutus-voice-ai'

// ─── Eyelid shape (per-eye, asymmetric) ──────────────────────────────
export interface EyeLidShape {
  topLid: number       // 0=open, 1=closed
  bottomLid: number
  topAngle: number     // tilt of top eyelid (radians)
  bottomAngle: number  // tilt of bottom eyelid (radians)
}

// ─── Pupil shape (morphs smoothly via slitAmount) ───────────────────
// slitAmount: 0 = full circle, 1 = full vertical slit
export type PupilShape = 'circle' | 'slit' | 'oval' | 'star'

// ─── Full eye shape pair ─────────────────────────────────────────────
export interface EyeShapePair {
  left: EyeLidShape
  right: EyeLidShape
  roundness: number
  widthScale: number
  heightScale: number
  pupilScale: number
  glowIntensity: number
  isHeart?: boolean    // love: morph whole eye into heart
  squashStretch: number // >1 = stretch tall, <1 = squash wide (cartoon physics)
  pupilSlitAmount: number  // 0=circle, 1=slit (vertical cat-eye)
  pupilOvalAmount: number  // 0=circle, 1=wide oval
}

// ─── Eyebrow shape ───────────────────────────────────────────────────
export interface EyebrowShape {
  angle: number        // tilt (positive = inner high, negative = outer droop)
  height: number       // distance above eye (0-1 relative)
  thickness: number    // stroke width multiplier
  curvature: number    // 0 = flat, 1 = highly arched
  length: number       // 0-1 relative to eye width
}

// ─── Color palette per emotion ───────────────────────────────────────
export interface EmotionColors {
  primary: string
  dark: string
  glow: string
  iris: string
  pupil: string
  glowR: number; glowG: number; glowB: number
  browColor: string
  auraColor: string
}

// ─── Emotion palettes ────────────────────────────────────────────────
export const PALETTES: Record<BrutusEmotion, EmotionColors> = {
  neutral:   { primary: '#cc1a1a', dark: '#8b0000', glow: '#ff2222', iris: '#ff4444', pupil: '#1a0000', glowR: 255, glowG: 34, glowB: 34, browColor: '#cc3333', auraColor: 'rgba(200,20,20,0.08)' },
  happy:     { primary: '#dd3311', dark: '#8b1500', glow: '#ff6622', iris: '#ff7744', pupil: '#1a0500', glowR: 255, glowG: 102, glowB: 34, browColor: '#dd5522', auraColor: 'rgba(255,100,30,0.1)' },
  angry:     { primary: '#ff0000', dark: '#990000', glow: '#ff0000', iris: '#ff2200', pupil: '#2a0000', glowR: 255, glowG: 0, glowB: 0, browColor: '#ff2200', auraColor: 'rgba(255,0,0,0.12)' },
  sad:       { primary: '#881122', dark: '#550011', glow: '#aa2244', iris: '#cc3355', pupil: '#0a0005', glowR: 170, glowG: 34, glowB: 68, browColor: '#993355', auraColor: 'rgba(150,30,60,0.08)' },
  surprised: { primary: '#ee2222', dark: '#881111', glow: '#ff4444', iris: '#ff6655', pupil: '#1a0000', glowR: 255, glowG: 68, glowB: 68, browColor: '#ff4444', auraColor: 'rgba(255,60,60,0.1)' },
  sleepy:    { primary: '#661111', dark: '#330808', glow: '#882222', iris: '#993333', pupil: '#0a0000', glowR: 136, glowG: 34, glowB: 34, browColor: '#662222', auraColor: 'rgba(100,20,20,0.05)' },
  love:      { primary: '#cc1155', dark: '#770033', glow: '#ff2277', iris: '#ff4488', pupil: '#1a0008', glowR: 255, glowG: 34, glowB: 119, browColor: '#ff3388', auraColor: 'rgba(255,30,100,0.12)' }
}

// ─── Emotion eye shapes ──────────────────────────────────────────────
export const SHAPES: Record<BrutusEmotion, EyeShapePair> = {
  neutral:   { left: { topLid: 0, bottomLid: 0, topAngle: 0, bottomAngle: 0 }, right: { topLid: 0, bottomLid: 0, topAngle: 0, bottomAngle: 0 }, roundness: 0.42, widthScale: 1.0,  heightScale: 1.0,  pupilScale: 1.0,  glowIntensity: 0.55, squashStretch: 1.0,  pupilSlitAmount: 0,   pupilOvalAmount: 0 },
  happy:     { left: { topLid: 0.05, bottomLid: 0.4, topAngle: 0, bottomAngle: 0.18 }, right: { topLid: 0.05, bottomLid: 0.4, topAngle: 0, bottomAngle: -0.18 }, roundness: 0.48, widthScale: 1.06, heightScale: 0.78, pupilScale: 1.12, glowIntensity: 0.88, squashStretch: 0.92, pupilSlitAmount: 0,   pupilOvalAmount: 0.15 },
  angry:     { left: { topLid: 0.18, bottomLid: 0, topAngle: 0.4, bottomAngle: 0 }, right: { topLid: 0.18, bottomLid: 0, topAngle: -0.4, bottomAngle: 0 }, roundness: 0.25, widthScale: 1.04, heightScale: 0.72, pupilScale: 0.65, glowIntensity: 1.0,  squashStretch: 0.88, pupilSlitAmount: 0.8, pupilOvalAmount: 0 },
  sad:       { left: { topLid: 0.25, bottomLid: 0, topAngle: -0.3, bottomAngle: 0 }, right: { topLid: 0.25, bottomLid: 0, topAngle: 0.3, bottomAngle: 0 }, roundness: 0.42, widthScale: 0.9,  heightScale: 0.84, pupilScale: 1.18, glowIntensity: 0.28, squashStretch: 0.95, pupilSlitAmount: 0,   pupilOvalAmount: 0 },
  surprised: { left: { topLid: 0, bottomLid: 0, topAngle: 0, bottomAngle: 0 }, right: { topLid: 0, bottomLid: 0, topAngle: 0, bottomAngle: 0 }, roundness: 0.58, widthScale: 1.2,  heightScale: 1.3,  pupilScale: 1.4,  glowIntensity: 0.92, squashStretch: 1.12, pupilSlitAmount: 0,   pupilOvalAmount: 0.4 },
  sleepy:    { left: { topLid: 0.74, bottomLid: 0.1, topAngle: 0, bottomAngle: 0 }, right: { topLid: 0.74, bottomLid: 0.1, topAngle: 0, bottomAngle: 0 }, roundness: 0.35, widthScale: 0.93, heightScale: 0.45, pupilScale: 0.7,  glowIntensity: 0.15, squashStretch: 0.85, pupilSlitAmount: 0.5, pupilOvalAmount: 0 },
  love:      { left: { topLid: 0, bottomLid: 0.1, topAngle: 0, bottomAngle: 0.08 }, right: { topLid: 0, bottomLid: 0.1, topAngle: 0, bottomAngle: -0.08 }, roundness: 0.5, widthScale: 1.14, heightScale: 1.1, pupilScale: 1.45, glowIntensity: 0.98, squashStretch: 1.05, pupilSlitAmount: 0, pupilOvalAmount: 0.6, isHeart: true }
}

// ─── Eyebrow shapes per emotion ──────────────────────────────────────
export const EYEBROWS: Record<BrutusEmotion, EyebrowShape> = {
  neutral:   { angle: 0, height: 0.28, thickness: 1.0, curvature: 0.3, length: 0.7 },
  happy:     { angle: 0.05, height: 0.32, thickness: 0.9, curvature: 0.45, length: 0.65 },
  angry:     { angle: 0.45, height: 0.18, thickness: 1.4, curvature: 0.1, length: 0.75 },
  sad:       { angle: -0.35, height: 0.25, thickness: 1.0, curvature: 0.5, length: 0.65 },
  surprised: { angle: 0, height: 0.42, thickness: 1.1, curvature: 0.7, length: 0.6 },
  sleepy:    { angle: -0.1, height: 0.2, thickness: 0.8, curvature: 0.2, length: 0.55 },
  love:      { angle: 0.08, height: 0.35, thickness: 0.85, curvature: 0.55, length: 0.6 }
}

// ─── Lerp helpers ────────────────────────────────────────────────────
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function lerpLid(a: EyeLidShape, b: EyeLidShape, t: number): EyeLidShape {
  return {
    topLid: lerp(a.topLid, b.topLid, t),
    bottomLid: lerp(a.bottomLid, b.bottomLid, t),
    topAngle: lerp(a.topAngle, b.topAngle, t),
    bottomAngle: lerp(a.bottomAngle, b.bottomAngle, t)
  }
}

export function lerpPair(a: EyeShapePair, b: EyeShapePair, t: number): EyeShapePair {
  return {
    left: lerpLid(a.left, b.left, t),
    right: lerpLid(a.right, b.right, t),
    roundness: lerp(a.roundness, b.roundness, t),
    widthScale: lerp(a.widthScale, b.widthScale, t),
    heightScale: lerp(a.heightScale, b.heightScale, t),
    pupilScale: lerp(a.pupilScale, b.pupilScale, t),
    glowIntensity: lerp(a.glowIntensity, b.glowIntensity, t),
    isHeart: b.isHeart,
    squashStretch: lerp(a.squashStretch, b.squashStretch, t),
    pupilSlitAmount: lerp(a.pupilSlitAmount, b.pupilSlitAmount, t),
    pupilOvalAmount: lerp(a.pupilOvalAmount, b.pupilOvalAmount, t)
  }
}

export function lerpBrow(a: EyebrowShape, b: EyebrowShape, t: number): EyebrowShape {
  return {
    angle: lerp(a.angle, b.angle, t),
    height: lerp(a.height, b.height, t),
    thickness: lerp(a.thickness, b.thickness, t),
    curvature: lerp(a.curvature, b.curvature, t),
    length: lerp(a.length, b.length, t)
  }
}

export function lerpColor(a: EmotionColors, b: EmotionColors, t: number): EmotionColors {
  const li = (x: string, y: string): string => {
    if (x.startsWith('rgba') || y.startsWith('rgba')) {
      // For rgba strings, just pick target after threshold
      return t > 0.5 ? y : x
    }
    const ax = parseInt(x.slice(1), 16), bx = parseInt(y.slice(1), 16)
    const r = Math.round(lerp((ax >> 16) & 0xff, (bx >> 16) & 0xff, t))
    const g = Math.round(lerp((ax >> 8) & 0xff, (bx >> 8) & 0xff, t))
    const bl = Math.round(lerp(ax & 0xff, bx & 0xff, t))
    return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`
  }
  return {
    primary: li(a.primary, b.primary),
    dark: li(a.dark, b.dark),
    glow: li(a.glow, b.glow),
    iris: li(a.iris, b.iris),
    pupil: li(a.pupil, b.pupil),
    glowR: Math.round(lerp(a.glowR, b.glowR, t)),
    glowG: Math.round(lerp(a.glowG, b.glowG, t)),
    glowB: Math.round(lerp(a.glowB, b.glowB, t)),
    browColor: li(a.browColor, b.browColor),
    auraColor: t > 0.5 ? b.auraColor : a.auraColor
  }
}
