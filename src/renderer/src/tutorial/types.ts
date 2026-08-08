/**
 * BRUTUS tutorial — shapes and placement maths.
 *
 * Deliberately free of React, electron and the DOM so the part that decides
 * *where a card goes* can be tested exhaustively. Placement is the whole
 * difficulty of a guided tour: a card that covers the thing it is describing, or
 * that hangs off the edge of the window, is worse than no tour at all.
 *
 * ── WHY STEPS TARGET `data-tour` AND NOT CSS SELECTORS ─────────────────────
 * A tour written against `.studio-glass > button:nth-child(3)` breaks the first
 * time someone restyles a bar, and breaks *silently* — the step simply points at
 * nothing. `data-tour="studio.dashboard"` is a contract: it is greppable, it
 * survives restyling, and a test can assert that every step's anchor exists in
 * the source.
 */

export type Lang = 'en' | 'hi'

/** A string in both languages. Hindi is required — a half-translated tour is worse than none. */
export interface Phrase {
  en: string
  hi: string
}

/** Where a card sits relative to its target. `auto` lets the maths decide. */
export type Placement = 'auto' | 'top' | 'bottom' | 'left' | 'right' | 'center'

export interface TourStep {
  /** Stable id, used for progress and as a React key. */
  id: string
  /**
   * `data-tour` value of the element to point at.
   *
   * Absent means an unanchored step — rendered centred, for an opening or
   * closing card that is about the feature rather than a control.
   */
  anchor?: string
  title: Phrase
  body: Phrase
  placement?: Placement
  /**
   * Wait for the anchor to appear rather than skipping the step.
   *
   * For a control that only exists after something opens — the mission board,
   * a panel — where arriving a moment early is normal, not a broken step.
   */
  waitForAnchor?: boolean
}

export interface Tour {
  id: string
  /**
   * Where this tour applies.
   *
   * A nav tab id (`STUDIO`), optionally with a sub-scope (`STUDIO/canvas`).
   * The sub-scope is what lets one feature have more than one tour: Studio's
   * launcher and its canvas are different screens with different controls, and a
   * single tour covering both would spend half its steps pointing at things that
   * are not on the screen yet.
   */
  scope: string
  /**
   * The tour that carries on from this one, if any.
   *
   * Purely explanatory — it is what lets the last step say "open a workspace and
   * I will show you inside" truthfully. The continuation itself needs no
   * mechanism: entering the deeper scope starts its own unseen tour.
   */
  continuesTo?: string
  title: Phrase
  /** One line under the title on the opening card. */
  blurb: Phrase
  steps: TourStep[]
}

// ─── Placement ──────────────────────────────────────────────────────────────

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

/** Breathing room between the highlight and the card. */
export const GAP = 14
/** Keep the card this far from the window edge. */
export const MARGIN = 16
/** How much the spotlight cut-out grows beyond the element. */
export const SPOTLIGHT_PAD = 6

/**
 * Decide which side of the target a card should sit on.
 *
 * Tries the requested side first and falls back through the others by how much
 * room each has, rather than to a fixed order — on a control pinned to the
 * bottom of the window, "below" is always wrong and "above" is always right, and
 * the tour should work that out rather than make every step declare it.
 */
export function chooseSide(
  target: Rect,
  card: { width: number; height: number },
  view: Viewport,
  preferred: Placement = 'auto'
): Exclude<Placement, 'auto'> {
  if (preferred === 'center') return 'center'

  const room = {
    bottom: view.height - (target.y + target.height) - GAP - MARGIN,
    top: target.y - GAP - MARGIN,
    right: view.width - (target.x + target.width) - GAP - MARGIN,
    left: target.x - GAP - MARGIN
  }

  const needed = { bottom: card.height, top: card.height, right: card.width, left: card.width }

  if (preferred !== 'auto' && room[preferred] >= needed[preferred]) return preferred

  // Most room first, so the card lands where it is least likely to be clamped.
  const order = (['bottom', 'top', 'right', 'left'] as const)
    .filter((side) => room[side] >= needed[side])
    .sort((a, b) => room[b] - room[a])

  // Nothing fits: centre it. Better a card over the target than one off-screen.
  return order[0] ?? 'center'
}

/**
 * Final card position, clamped inside the window.
 *
 * Returns viewport coordinates. The clamp is what stops a card anchored to
 * something near an edge — the first nav tab, the last button in a rail — from
 * rendering half outside the window, which is the single most common way a
 * guided tour looks broken.
 */
export function placeCard(
  target: Rect,
  card: { width: number; height: number },
  view: Viewport,
  preferred: Placement = 'auto'
): { x: number; y: number; side: Exclude<Placement, 'auto'> } {
  const side = chooseSide(target, card, view, preferred)

  if (side === 'center') {
    return {
      x: Math.round((view.width - card.width) / 2),
      y: Math.round((view.height - card.height) / 2),
      side
    }
  }

  let x: number
  let y: number

  if (side === 'bottom' || side === 'top') {
    // Centred on the target horizontally, then clamped.
    x = target.x + target.width / 2 - card.width / 2
    y = side === 'bottom' ? target.y + target.height + GAP : target.y - card.height - GAP
  } else {
    x = side === 'right' ? target.x + target.width + GAP : target.x - card.width - GAP
    y = target.y + target.height / 2 - card.height / 2
  }

  return {
    x: Math.round(clamp(x, MARGIN, Math.max(MARGIN, view.width - card.width - MARGIN))),
    y: Math.round(clamp(y, MARGIN, Math.max(MARGIN, view.height - card.height - MARGIN))),
    side
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** The spotlight cut-out for a target, padded and kept inside the window. */
export function spotlightRect(target: Rect, view: Viewport): Rect {
  const x = Math.max(0, target.x - SPOTLIGHT_PAD)
  const y = Math.max(0, target.y - SPOTLIGHT_PAD)
  return {
    x,
    y,
    width: Math.min(view.width - x, target.width + SPOTLIGHT_PAD * 2),
    height: Math.min(view.height - y, target.height + SPOTLIGHT_PAD * 2)
  }
}

/**
 * Is the target usefully on screen?
 *
 * A step whose anchor is scrolled out of view would spotlight empty space, so
 * the caller scrolls it into view first and re-measures.
 */
export function isOnScreen(target: Rect, view: Viewport): boolean {
  return (
    target.width > 0 &&
    target.height > 0 &&
    target.y + target.height > 0 &&
    target.y < view.height &&
    target.x + target.width > 0 &&
    target.x < view.width
  )
}

/** Pick a language's string, falling back to English if a translation is missing. */
export function say(phrase: Phrase, lang: Lang): string {
  const value = phrase?.[lang]
  return value && value.trim() ? value : (phrase?.en ?? '')
}
