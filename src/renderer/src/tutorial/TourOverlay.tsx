import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'framer-motion'
import {
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiCloseLine,
  RiGraduationCapLine
} from 'react-icons/ri'
import { useAnchor } from './useAnchor'
import { getLang, markSeen, setLang } from './store'
import { placeCard, say, spotlightRect, type Lang, type Rect, type Tour } from './types'

/**
 * The guided tour itself: a spotlight, a card, and a way through.
 *
 * ── WHY A PORTAL AND AN SVG MASK ───────────────────────────────────────────
 * The overlay must sit above every panel, modal and canvas in the app, and the
 * dimming has to have a *hole* in it rather than being a rectangle drawn near
 * the target. Four positioned divs around a gap is the usual shortcut and it
 * fails on rounded corners and on anything near an edge. One full-screen rect
 * with an SVG mask punched out of it is exact everywhere, animates as one
 * object, and costs a single element.
 *
 * ── WHY THE PAGE STAYS CLICKABLE UNDERNEATH ────────────────────────────────
 * It does not. A tour that lets you click through to a half-explained interface
 * ends with the tour pointing at a screen that has changed under it. The overlay
 * takes the clicks; the tour is short, and every step has a visible way out.
 */

const CARD = { width: 340, height: 220 }

export interface TourOverlayProps {
  tour: Tour
  onClose: () => void
}

export default function TourOverlay({ tour, onClose }: TourOverlayProps): ReactElement | null {
  const [index, setIndex] = useState(0)
  const [lang, setLangState] = useState<Lang>(() => getLang())
  const reduceMotion = useReducedMotion()

  const step = tour.steps[index]
  const { rect, missing } = useAnchor(step?.anchor, step?.waitForAnchor)

  const [view, setView] = useState(() => ({
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 720 : window.innerHeight
  }))

  useEffect(() => {
    const onResize = (): void => setView({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const finish = useCallback(() => {
    markSeen(tour.id)
    onClose()
  }, [tour.id, onClose])

  const next = useCallback(() => {
    setIndex((i) => {
      if (i + 1 >= tour.steps.length) {
        // Deferred: calling `finish` inside the updater would set state during
        // another component's render if the parent unmounts us synchronously.
        queueMicrotask(finish)
        return i
      }
      return i + 1
    })
  }, [tour.steps.length, finish])

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), [])

  // Keyboard: the whole tour is driveable without the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish()
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        back()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [next, back, finish])

  const chooseLang = useCallback((value: Lang) => {
    setLangState(value)
    setLang(value)
  }, [])

  /** Where the hole goes, and where the card goes relative to it. */
  const geometry = useMemo(() => {
    const usable = rect && !missing ? rect : null
    if (!usable || step?.placement === 'center') {
      return {
        hole: null as Rect | null,
        card: placeCard({ x: 0, y: 0, width: 0, height: 0 }, CARD, view, 'center')
      }
    }
    return {
      hole: spotlightRect(usable, view),
      card: placeCard(usable, CARD, view, step?.placement ?? 'auto')
    }
  }, [rect, missing, step?.placement, view])

  if (!step) return null

  const spring = reduceMotion
    ? { duration: 0 }
    : ({ type: 'spring', stiffness: 260, damping: 30 } as const)

  const overlay = (
    <div
      className="fixed inset-0 z-[9900]"
      role="dialog"
      aria-modal="true"
      aria-label={say(tour.title, lang)}
    >
      {/* ── The dim, with a hole punched in it ── */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <mask id="brutus-tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {geometry.hole && (
              <motion.rect
                initial={false}
                animate={{
                  x: geometry.hole.x,
                  y: geometry.hole.y,
                  width: geometry.hole.width,
                  height: geometry.hole.height
                }}
                transition={spring}
                rx={10}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(0,0,0,0.72)"
          mask="url(#brutus-tour-mask)"
        />
      </svg>

      {/* A ring around the hole, so the highlighted control reads as chosen
          rather than as a gap where the dimming failed. */}
      {geometry.hole && (
        <motion.div
          initial={false}
          animate={{
            x: geometry.hole.x,
            y: geometry.hole.y,
            width: geometry.hole.width,
            height: geometry.hole.height
          }}
          transition={spring}
          className="pointer-events-none absolute left-0 top-0 rounded-[10px] ring-2 ring-red-500/70 shadow-[0_0_0_6px_rgba(var(--brutus-accent-c),0.12)]"
        />
      )}

      {/* Clicks land here, not on the half-explained interface underneath. */}
      <div className="absolute inset-0" onClick={next} />

      {/* ── The card ── */}
      <motion.div
        initial={false}
        animate={{ x: geometry.card.x, y: geometry.card.y }}
        transition={spring}
        style={{ width: CARD.width }}
        onClick={(e) => e.stopPropagation()}
        className="studio-glass absolute left-0 top-0 flex flex-col gap-2.5 rounded-2xl p-4"
      >
        <div className="flex items-center gap-2">
          <RiGraduationCapLine size={13} className="shrink-0 text-red-400" />
          <span className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
            {say(tour.title, lang)}
          </span>

          {/* Language, always one tap away rather than buried in settings. */}
          <div className="ml-auto flex shrink-0 items-center rounded-lg bg-white/[0.06] p-0.5">
            {(['en', 'hi'] as const).map((code) => (
              <button
                key={code}
                onClick={() => chooseLang(code)}
                aria-pressed={lang === code}
                title={code === 'en' ? 'English' : 'हिन्दी'}
                className={`cursor-pointer rounded-md px-1.5 py-0.5 text-[9px] font-bold transition-colors ${
                  lang === code ? 'bg-white/15 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {code === 'en' ? 'EN' : 'हि'}
              </button>
            ))}
          </div>

          <button
            onClick={finish}
            title={lang === 'hi' ? 'बंद करें' : 'Close'}
            className="shrink-0 cursor-pointer rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            <RiCloseLine size={14} />
          </button>
        </div>

        {/* Keyed on the step so the text animates in as the spotlight travels,
            which is what makes a jump between two controls read as one motion.

            ── WHY NOT `AnimatePresence mode="wait"` ──────────────────────────
            That was the first shape and it stalled: with `initial={false}` on
            the card around it, the exiting child's exit never completed, so the
            NEW step's text never mounted. The spotlight moved, the title and the
            buttons updated, and the paragraph stayed on the previous step —
            which is worse than no animation, because the tour then describes the
            wrong control. A keyed remount cannot stall: React swaps the node and
            framer animates the new one in. The old text leaves instantly, which
            at 160ms is not a loss worth a class of bug. */}
        <motion.div
          key={`${step.id}-${lang}`}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.16 }}
          className="flex flex-col gap-1.5"
        >
          <h3 className="text-[14px] font-semibold leading-snug tracking-tight text-zinc-100">
            {say(step.title, lang)}
          </h3>
          <p className="text-[12px] leading-relaxed text-zinc-400">{say(step.body, lang)}</p>
        </motion.div>

        {missing && step.anchor && (
          <p className="text-[10px] leading-relaxed text-amber-400/80">
            {lang === 'hi'
              ? 'यह हिस्सा अभी स्क्रीन पर नहीं है — आगे बढ़ें, बाकी tour चलता रहेगा।'
              : 'That control is not on screen right now — carry on, the rest of the tour still works.'}
          </p>
        )}

        <div className="mt-1 flex items-center gap-2">
          {/* Progress as dots: at eight steps a bar says nothing, and a count
              reads as a chore. Dots show how near the end you are at a glance. */}
          <div className="flex items-center gap-1">
            {tour.steps.map((s, i) => (
              <span
                key={s.id}
                className={`h-1 rounded-full transition-all duration-300 ${
                  i === index
                    ? 'w-4 bg-red-500'
                    : i < index
                      ? 'w-1 bg-red-500/40'
                      : 'w-1 bg-white/15'
                }`}
              />
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1">
            {index > 0 && (
              <button
                onClick={back}
                className="cursor-pointer rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
                title={lang === 'hi' ? 'पीछे' : 'Back'}
              >
                <RiArrowLeftSLine size={16} />
              </button>
            )}
            <button
              onClick={next}
              className="flex cursor-pointer items-center gap-1 rounded-lg bg-red-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-red-400 transition-colors hover:bg-red-500/25"
            >
              {index + 1 >= tour.steps.length
                ? lang === 'hi'
                  ? 'हो गया'
                  : 'Done'
                : lang === 'hi'
                  ? 'आगे'
                  : 'Next'}
              {index + 1 < tour.steps.length && <RiArrowRightSLine size={14} />}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )

  // Portalled to the body so no ancestor's `overflow` or stacking context can
  // clip the overlay — a tour rendered inside a scrolling panel is invisible.
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)
}
