import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { AnimatePresence } from 'framer-motion'
import { RiQuestionLine } from 'react-icons/ri'
import TourOverlay from './TourOverlay'
import { hasSeen, getLang } from './store'
import { tourForScope, tourById, WELCOME_TOUR } from './content'
import { TutorialContext, useTutorial, type TutorialApi } from './context'
import type { Tour } from './types'

/**
 * One tour at a time, for the whole app.
 *
 * ── WHY A PROVIDER AND NOT A COMPONENT PER VIEW ────────────────────────────
 * Two tours on screen at once is nonsense — two spotlights, two cards, both
 * claiming the keyboard. Holding the current tour in one place makes that
 * unrepresentable rather than merely unlikely, and it lets the welcome tour
 * point at the nav, which no single view owns.
 *
 * ── MINIMAL EFFORT ─────────────────────────────────────────────────────────
 * The first time a feature is opened its tour starts by itself; after that the
 * `?` button is there and nothing nags. Nobody has to go looking for help they
 * do not yet know exists.
 */

export function TutorialProvider({ children }: { children: ReactNode }): ReactElement {
  const [active, setActive] = useState<Tour | null>(null)
  const [feature, setFeature] = useState<string>('')
  const [subScope, setSubScope] = useState<string | null>(null)

  /** `STUDIO`, or `STUDIO/canvas` once a workspace is open. */
  const scope = useMemo(
    () => (feature ? (subScope ? `${feature}/${subScope}` : feature) : ''),
    [feature, subScope]
  )

  const current = useMemo(() => (scope ? tourForScope(scope) : null), [scope])

  const start = useCallback((tourId: string) => {
    const tour = tourById(tourId)
    if (tour) setActive(tour)
  }, [])

  /**
   * First launch: offer the welcome tour once.
   *
   * Delayed a beat so it opens over a painted interface rather than over the
   * app mid-mount — a spotlight on a control that has not finished animating in
   * looks like a bug.
   */
  useEffect(() => {
    if (hasSeen(WELCOME_TOUR.id)) return
    const timer = setTimeout(() => setActive((a) => a ?? WELCOME_TOUR), 900)
    return () => clearTimeout(timer)
  }, [])

  /**
   * First visit to a feature: start its tour by itself.
   *
   * Only when nothing else is running and only once ever, so switching tabs
   * during a tour cannot hijack it, and a returning user is never interrupted.
   */
  useEffect(() => {
    if (!current || active) return
    if (hasSeen(current.id)) return
    if (!hasSeen(WELCOME_TOUR.id)) return // let the welcome finish first
    const timer = setTimeout(() => setActive((a) => a ?? current), 700)
    return () => clearTimeout(timer)
  }, [current, active])

  const api = useMemo<TutorialApi>(
    () => ({ start, setFeature, setSubScope, current, running: Boolean(active) }),
    [start, current, active]
  )

  return (
    <TutorialContext.Provider value={api}>
      {children}
      <AnimatePresence>
        {active && <TourOverlay key={active.id} tour={active} onClose={() => setActive(null)} />}
      </AnimatePresence>
    </TutorialContext.Provider>
  )
}

/**
 * The `?` on a feature.
 *
 * Renders nothing when the feature has no tour, rather than a dead button that
 * teaches the user the help is unreliable.
 */
export function TutorialButton({ className = '' }: { className?: string }): ReactElement | null {
  const { current, start, running } = useTutorial()
  const lang = getLang()
  if (!current) return null

  return (
    <button
      data-tour="tutorial.button"
      onClick={() => start(current.id)}
      disabled={running}
      title={
        lang === 'hi'
          ? `${current.title.hi} — tutorial देखें`
          : `${current.title.en} — show me around`
      }
      aria-label={lang === 'hi' ? 'ट्यूटोरियल' : 'Tutorial'}
      className={`cursor-pointer rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-red-400 disabled:cursor-default disabled:opacity-40 ${className}`}
    >
      <RiQuestionLine size={14} />
    </button>
  )
}
