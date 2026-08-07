/**
 * BRUTUS Studio — backdrops
 *
 * The canvas is the room the agents work in, so it should feel like a place
 * rather than a blank div. Each backdrop is built from four layers that stack
 * into something with depth:
 *
 *   base    a broad gradient establishing the mood
 *   bloom   two or three soft colour blooms that drift very slowly
 *   grid    the dot lattice, tinted to belong to the scene
 *   accent  the hue edges and glows pick up, so the whole view agrees
 *
 * Kept as data rather than scattered class names so adding one is a single
 * object, and so the picker can render swatches without hardcoding anything.
 *
 * Every layer is painted on its own compositor layer and animated with
 * transforms only — panning a canvas of live terminals is expensive enough
 * without the background repainting underneath it.
 */

export interface Backdrop {
  id: string
  label: string
  /** Full-bleed base gradient. */
  base: string
  /** Drifting colour blooms, layered over the base. */
  bloom: string
  /** Dot-grid colour. */
  grid: string
  /** Swatch colour for the picker. */
  swatch: string
}

export const BACKDROPS: Backdrop[] = [
  {
    id: 'ember',
    label: 'Ember',
    base: 'radial-gradient(ellipse 100% 70% at 50% -20%, #2a0d10 0%, #14090b 45%, #08080a 100%)',
    bloom:
      'radial-gradient(38% 45% at 18% 22%, rgba(239,68,68,0.20) 0%, transparent 70%),' +
      'radial-gradient(42% 50% at 82% 68%, rgba(249,115,22,0.13) 0%, transparent 72%),' +
      'radial-gradient(35% 40% at 55% 105%, rgba(190,24,93,0.12) 0%, transparent 70%)',
    grid: '#ffffff12',
    swatch: 'linear-gradient(135deg, #ef4444, #7f1d1d)'
  },
  {
    id: 'harbour',
    label: 'Harbour',
    base: 'radial-gradient(ellipse 100% 70% at 50% -20%, #10243c 0%, #0b1520 45%, #08080a 100%)',
    bloom:
      'radial-gradient(40% 46% at 22% 18%, rgba(56,189,248,0.18) 0%, transparent 70%),' +
      'radial-gradient(45% 52% at 80% 72%, rgba(99,102,241,0.15) 0%, transparent 72%),' +
      'radial-gradient(30% 38% at 50% 100%, rgba(20,184,166,0.10) 0%, transparent 70%)',
    grid: '#ffffff14',
    swatch: 'linear-gradient(135deg, #38bdf8, #1e3a8a)'
  },
  {
    id: 'aurora',
    label: 'Aurora',
    base: 'radial-gradient(ellipse 110% 75% at 50% -15%, #10231d 0%, #0a1413 45%, #08080a 100%)',
    bloom:
      'radial-gradient(42% 48% at 25% 25%, rgba(52,211,153,0.16) 0%, transparent 70%),' +
      'radial-gradient(40% 46% at 78% 62%, rgba(168,85,247,0.15) 0%, transparent 72%),' +
      'radial-gradient(36% 42% at 52% 102%, rgba(34,211,238,0.12) 0%, transparent 70%)',
    grid: '#ffffff12',
    swatch: 'linear-gradient(135deg, #34d399, #a855f7)'
  },
  {
    id: 'void',
    label: 'Void',
    base: 'radial-gradient(ellipse 100% 70% at 50% -10%, #141418 0%, #0d0d10 45%, #060607 100%)',
    bloom:
      'radial-gradient(45% 50% at 30% 20%, rgba(255,255,255,0.05) 0%, transparent 70%),' +
      'radial-gradient(40% 46% at 75% 75%, rgba(239,68,68,0.07) 0%, transparent 72%)',
    grid: '#ffffff0e',
    swatch: 'linear-gradient(135deg, #52525b, #18181b)'
  },
  {
    id: 'dusk',
    label: 'Dusk',
    base: 'radial-gradient(ellipse 105% 72% at 50% -18%, #241832 0%, #150e1d 45%, #08080a 100%)',
    bloom:
      'radial-gradient(40% 48% at 20% 24%, rgba(192,132,252,0.18) 0%, transparent 70%),' +
      'radial-gradient(44% 50% at 82% 66%, rgba(244,114,182,0.13) 0%, transparent 72%),' +
      'radial-gradient(32% 40% at 50% 104%, rgba(99,102,241,0.12) 0%, transparent 70%)',
    grid: '#ffffff12',
    swatch: 'linear-gradient(135deg, #c084fc, #db2777)'
  }
]

export const DEFAULT_BACKDROP = 'ember'

export function backdropById(id?: string): Backdrop {
  return BACKDROPS.find((b) => b.id === id) ?? BACKDROPS[0]
}
