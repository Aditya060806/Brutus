import { useEffect, useState } from 'react'
import type { Rect } from './types'

/**
 * Find and follow the element a step points at.
 *
 * ── WHY THIS IS NOT JUST `getBoundingClientRect()` ─────────────────────────
 * Three things move under a tour, and all of them look like a broken step:
 *
 *   The element is not there yet. Panels mount on a transition, the mission
 *   board appears after a model call. A step that measured once, at the moment
 *   it became current, would point at nothing — so it retries.
 *
 *   The element is off-screen. Scrolled out of a panel, or below the fold. The
 *   spotlight would land on empty space, so it is scrolled into view first and
 *   then re-measured.
 *
 *   The layout moves. The window resizes, a list grows, an animation settles.
 *   The highlight has to follow rather than sit where the element used to be.
 */

/** How long to keep looking for an anchor that has not mounted. */
const WAIT_MS = 4000
/** How often to re-look while waiting. */
const POLL_MS = 120
/** How often to re-measure once found, so the highlight tracks layout. */
const TRACK_MS = 250

export interface AnchorState {
  rect: Rect | null
  /** Looked for it and it never appeared. The step renders centred instead. */
  missing: boolean
}

const NOTHING: AnchorState = { rect: null, missing: false }

const measure = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

export function useAnchor(anchor: string | undefined, waitForAnchor = false): AnchorState {
  const [found, setFound] = useState<AnchorState>(NOTHING)

  /**
   * Clear the previous step's rect as the anchor changes, during render.
   *
   * React's documented pattern for resetting state when a prop changes, and the
   * reason it matters here rather than being style: doing it in the effect would
   * paint one frame with the OLD step's spotlight under the NEW step's card —
   * a visible flash of the highlight in the wrong place on every single step.
   */
  const [prevAnchor, setPrevAnchor] = useState(anchor)
  if (anchor !== prevAnchor) {
    setPrevAnchor(anchor)
    setFound(NOTHING)
  }

  useEffect(() => {
    // Unanchored step. Nothing to look for; the reset above is the whole answer.
    if (!anchor) return

    let cancelled = false
    let tracker: ReturnType<typeof setInterval> | null = null
    let poller: ReturnType<typeof setInterval> | null = null
    let waited = 0

    const selector = `[data-tour="${CSS.escape(anchor)}"]`

    const track = (el: Element): void => {
      // Bring it into view before the first measurement, or the spotlight lands
      // on wherever the element would have been.
      try {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
      } catch {
        /* not scrollable, or no layout engine */
      }

      const sync = (): void => {
        if (cancelled) return
        const live = document.querySelector(selector)
        // It vanished — a panel closed under us. Fall back to a centred card
        // rather than spotlighting a hole.
        setFound(live ? { rect: measure(live), missing: false } : { rect: null, missing: true })
      }

      sync()
      tracker = setInterval(sync, TRACK_MS)
    }

    const already = document.querySelector(selector)
    if (already) {
      track(already)
    } else if (waitForAnchor) {
      poller = setInterval(() => {
        if (cancelled) return
        waited += POLL_MS
        const el = document.querySelector(selector)
        if (el) {
          if (poller) clearInterval(poller)
          poller = null
          track(el)
        } else if (waited >= WAIT_MS) {
          if (poller) clearInterval(poller)
          poller = null
          setFound({ rect: null, missing: true })
        }
      }, POLL_MS)
    } else {
      // Not there and not worth waiting for. Reported on the next tick rather
      // than synchronously, so this is a subscription result and not a cascading
      // render during the effect itself.
      const timer = setTimeout(() => {
        if (!cancelled) setFound({ rect: null, missing: true })
      }, 0)
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    }

    const onResize = (): void => {
      const el = document.querySelector(selector)
      if (el) setFound({ rect: measure(el), missing: false })
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelled = true
      if (tracker) clearInterval(tracker)
      if (poller) clearInterval(poller)
      window.removeEventListener('resize', onResize)
    }
  }, [anchor, waitForAnchor])

  return anchor ? found : NOTHING
}
