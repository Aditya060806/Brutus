/**
 * The guided tutorial: placement maths, and the content contract.
 *
 * Two failures make a tour worse than none, and neither shows up in a
 * typecheck:
 *
 *   A card that renders off-screen, or on top of the control it is describing.
 *   That is pure geometry, so it is tested exhaustively here rather than
 *   discovered on a laptop with a short window.
 *
 *   A step pointing at an anchor nobody put in the markup. It fails silently —
 *   the spotlight simply lands nowhere — so every `anchor` is checked against
 *   the real source files.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', '..', 'src', 'renderer', 'src')

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const {
  GAP,
  MARGIN,
  chooseSide,
  isOnScreen,
  placeCard,
  say,
  spotlightRect
} = require('./tutorial-types.test.cjs')
const { TOURS, tourById, tourForScope } = require('./tutorial-content.test.cjs')

const VIEW = { width: 1280, height: 720 }
const CARD = { width: 340, height: 220 }

// ═══ 1. Choosing a side ═══════════════════════════════════════════════════

{
  const middle = { x: 600, y: 340, width: 80, height: 30 }
  ok(
    'a control in open space gets the preferred side',
    chooseSide(middle, CARD, VIEW, 'bottom') === 'bottom'
  )
  ok('and honours a different preference', chooseSide(middle, CARD, VIEW, 'top') === 'top')
  ok(
    'auto picks something sensible',
    ['bottom', 'top', 'right', 'left'].includes(chooseSide(middle, CARD, VIEW))
  )
}

{
  // A control pinned to the bottom of the window — Studio's command bar.
  const bottomBar = { x: 400, y: 690, width: 480, height: 44 }
  ok(
    'a bottom-pinned control never gets a card below it',
    chooseSide(bottomBar, CARD, VIEW, 'auto') !== 'bottom'
  )
  ok(
    'and an impossible preference is overridden rather than obeyed',
    chooseSide(bottomBar, CARD, VIEW, 'bottom') !== 'bottom'
  )
}

{
  // The top nav — nothing fits above it.
  const nav = { x: 500, y: 8, width: 300, height: 40 }
  ok(
    'a top-pinned control never gets a card above it',
    chooseSide(nav, CARD, VIEW, 'auto') !== 'top'
  )
}

{
  // A window too small for the card anywhere.
  const tiny = { width: 320, height: 200 }
  const anything = { x: 10, y: 10, width: 40, height: 20 }
  ok('an impossible window centres the card', chooseSide(anything, CARD, tiny) === 'center')
}

// ═══ 2. Placing the card ══════════════════════════════════════════════════

/** Every placement, everywhere, must land fully inside the window. */
{
  let offscreen = []
  for (let x = 0; x <= VIEW.width; x += 64) {
    for (let y = 0; y <= VIEW.height; y += 48) {
      for (const pref of ['auto', 'top', 'bottom', 'left', 'right']) {
        const target = { x, y, width: 90, height: 34 }
        const p = placeCard(target, CARD, VIEW, pref)
        if (
          p.x < 0 ||
          p.y < 0 ||
          p.x + CARD.width > VIEW.width ||
          p.y + CARD.height > VIEW.height
        ) {
          offscreen.push(`${pref}@${x},${y} -> ${p.x},${p.y}`)
        }
      }
    }
  }
  ok(
    'no target anywhere on screen produces an off-screen card',
    offscreen.length === 0,
    offscreen.slice(0, 3).join(' | ')
  )
}

{
  const target = { x: 600, y: 300, width: 80, height: 30 }
  const below = placeCard(target, CARD, VIEW, 'bottom')
  ok('a card below sits under the target', below.y >= target.y + target.height + GAP - 1)
  ok('and is centred on it', Math.abs(below.x + CARD.width / 2 - (target.x + target.width / 2)) < 2)

  const right = placeCard(target, CARD, VIEW, 'right')
  ok('a card to the right sits beside the target', right.x >= target.x + target.width + GAP - 1)
}

{
  // The first nav tab — hard against the left edge.
  const firstTab = { x: 4, y: 40, width: 60, height: 36 }
  const p = placeCard(firstTab, CARD, VIEW, 'bottom')
  ok('a card near the left edge is clamped, not cut off', p.x >= MARGIN - 1)
}

{
  const lastControl = { x: 1250, y: 40, width: 24, height: 24 }
  const p = placeCard(lastControl, CARD, VIEW, 'bottom')
  ok('a card near the right edge is clamped too', p.x + CARD.width <= VIEW.width - MARGIN + 1)
}

{
  const centred = placeCard({ x: 0, y: 0, width: 0, height: 0 }, CARD, VIEW, 'center')
  ok('a centred card is actually centred', centred.x === Math.round((VIEW.width - CARD.width) / 2))
  ok('vertically too', centred.y === Math.round((VIEW.height - CARD.height) / 2))
  ok('and reports its side', centred.side === 'center')
}

// ═══ 3. The spotlight ═════════════════════════════════════════════════════

{
  const target = { x: 100, y: 100, width: 80, height: 40 }
  const hole = spotlightRect(target, VIEW)
  ok('the spotlight covers the target', hole.x <= target.x && hole.y <= target.y)
  ok(
    'and extends past it on both sides',
    hole.x + hole.width >= target.x + target.width &&
      hole.y + hole.height >= target.y + target.height
  )
}

{
  // A control flush against the top-left corner must not produce a negative rect.
  const corner = spotlightRect({ x: 0, y: 0, width: 30, height: 30 }, VIEW)
  ok('the spotlight never goes negative', corner.x >= 0 && corner.y >= 0)
}

{
  const wide = spotlightRect({ x: 1200, y: 690, width: 200, height: 100 }, VIEW)
  ok(
    'and never spills past the window',
    wide.x + wide.width <= VIEW.width && wide.y + wide.height <= VIEW.height
  )
}

ok(
  'an element with no size is not on screen',
  !isOnScreen({ x: 10, y: 10, width: 0, height: 0 }, VIEW)
)
ok(
  'a scrolled-away element is not on screen',
  !isOnScreen({ x: 10, y: -200, width: 50, height: 50 }, VIEW)
)
ok('a visible element is', isOnScreen({ x: 10, y: 10, width: 50, height: 50 }, VIEW))

// ═══ 4. Language ══════════════════════════════════════════════════════════

ok('English is returned for en', say({ en: 'Hello', hi: 'नमस्ते' }, 'en') === 'Hello')
ok('Hindi is returned for hi', say({ en: 'Hello', hi: 'नमस्ते' }, 'hi') === 'नमस्ते')
ok('a missing translation falls back to English', say({ en: 'Hello', hi: '' }, 'hi') === 'Hello')
ok('a blank translation falls back too', say({ en: 'Hello', hi: '   ' }, 'hi') === 'Hello')
ok('a missing phrase does not throw', say(undefined, 'hi') === '')

// ═══ 5. The content contract ══════════════════════════════════════════════

ok('there are tours', TOURS.length > 0)

{
  const ids = TOURS.map((t) => t.id)
  ok('tour ids are unique', new Set(ids).size === ids.length)
}

for (const tour of TOURS) {
  ok(`${tour.id}: has steps`, tour.steps.length > 0)
  ok(`${tour.id}: title is in both languages`, !!tour.title.en?.trim() && !!tour.title.hi?.trim())
  ok(`${tour.id}: blurb is in both languages`, !!tour.blurb.en?.trim() && !!tour.blurb.hi?.trim())

  const stepIds = tour.steps.map((s) => s.id)
  ok(`${tour.id}: step ids are unique`, new Set(stepIds).size === stepIds.length)

  for (const step of tour.steps) {
    ok(
      `${tour.id}/${step.id}: written in both languages`,
      !!step.title.en?.trim() &&
        !!step.title.hi?.trim() &&
        !!step.body.en?.trim() &&
        !!step.body.hi?.trim()
    )
    // A Hindi string identical to the English one means it was never translated.
    ok(
      `${tour.id}/${step.id}: the Hindi is not just the English`,
      step.body.hi.trim() !== step.body.en.trim()
    )
    // Devanagari present — catches a placeholder that is merely different text.
    ok(`${tour.id}/${step.id}: the Hindi is actually Hindi`, /[\u0900-\u097F]/.test(step.body.hi))
  }
}

// ═══ 6. Every anchor exists in the real markup ════════════════════════════

/**
 * The check that stops a step silently pointing at nothing.
 *
 * Reads the renderer source rather than the DOM, because a headless test has no
 * DOM — and because the failure being guarded against is a refactor removing an
 * attribute, which is visible in the source.
 */
function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full)
  }
  return out
}

const sources = sourceFiles(SRC).map((f) => fs.readFileSync(f, 'utf8'))

/**
 * Is this anchor actually attached to something?
 *
 * Three shapes count, and all three are checked PER FILE rather than against one
 * concatenated blob — otherwise an anchor string in one file and a `data-tour`
 * in a completely unrelated one would satisfy each other, which is evidence of
 * nothing:
 *
 *   data-tour="x"             the plain attribute
 *   data-tour={`x.${id}`}     a template, as the nav uses for its tabs
 *   'x' ... data-tour={v}     the value bound from a nearby list
 *
 * What every shape has in common is that deleting the element deletes the
 * string, which is the regression being guarded against.
 */
function anchorExists(anchor) {
  const prefix = anchor.split('.')[0]
  const templated = new RegExp('data-tour=\\{`' + prefix + '\\.\\$\\{')
  const quoted = new RegExp('[\'"`]' + anchor.replace(/\./g, '\\.') + '[\'"`]')

  return sources.some((src) => {
    if (src.includes('data-tour="' + anchor + '"')) return true
    if (templated.test(src)) return true
    // Bound from a variable: the anchor must be quoted somewhere in the SAME
    // file as a `data-tour` binding.
    return quoted.test(src) && src.includes('data-tour=')
  })
}

for (const tour of TOURS) {
  for (const step of tour.steps) {
    if (!step.anchor) continue
    ok(
      `${tour.id}/${step.id}: anchor "${step.anchor}" exists in the markup`,
      anchorExists(step.anchor)
    )
  }
}

// The check must be able to fail, or it proves nothing.
ok('a made-up anchor is NOT found', !anchorExists('nope.does.not.exist'))

// ═══ 7. Lookups ═══════════════════════════════════════════════════════════

/**
 * Scopes, not bare feature names.
 *
 * A scope can be deeper than a nav tab — Studio's launcher and its canvas are
 * different screens with different controls, so they are different tours. This
 * pins that the deep scope resolves to the deep tour rather than silently
 * falling back to the shallow one.
 */
ok('a feature with a tour finds it', tourForScope('STUDIO')?.id === 'studio.launcher')
ok('a deeper scope finds its own tour', tourForScope('STUDIO/canvas')?.id === 'studio.canvas')
ok('a feature without one gets null', tourForScope('GALLERY') === null)
ok('an unknown scope gets null', tourForScope('NOPE/nope') === null)
ok('the welcome tour is not offered as a feature tour', tourForScope('DASHBOARD')?.id !== 'welcome')
ok('a tour can be fetched by id', tourById('studio.canvas')?.id === 'studio.canvas')
ok('an unknown id is null', tourById('nope') === null)

// The one the user cannot guess at, so it had better be the thorough one.
ok(
  'the Studio canvas tour covers orchestration in depth',
  tourById('studio.canvas').steps.length >= 8,
  `${tourById('studio.canvas').steps.length} steps`
)

// ═══ Report ═══════════════════════════════════════════════════════════════

for (const p of PASS) console.log(`  ✓ ${p}`)
for (const f of FAIL) console.error(`  ✗ ${f}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exit(FAIL.length ? 1 : 0)
