/**
 * BRUTUS — Robot voice command vocabulary
 * ----------------------------------------
 * Turns spoken English into physical robot actions, e.g.
 *
 *   "move forward with 50% speed"  → V127
 *   "turn your head to the left"   → N58
 *   "look surprised"               → E5
 *   "do the crazy eyes"            → W0
 *   "play the alarm sound"         → SA
 *   "go autonomous"                → Z1
 *
 * Used from two places:
 *
 *   1. The `control_robot` tool on the CLOUD voice engine — Gemini picks the
 *      action and passes a name, and `executeRobotAction` runs it. Name lookup
 *      is fuzzy so the model never has to match a label exactly.
 *   2. `matchRobotCommand` on the EDGE voice engine, which has no tool calling
 *      at all (it is a plain ASR → chat → TTS loop). There we pattern-match the
 *      transcript directly, so the same spoken commands work on both engines.
 *
 * Everything here is intentionally conservative: a phrase only counts as a
 * robot command when it clearly addresses the body (a movement/expression verb
 * plus a known target), so ordinary conversation is never hijacked.
 */
import {
  robotController,
  ANIMATION_LABELS,
  TRICK_LABELS,
  EXPRESSION_LABELS,
  SOUND_CUES,
  RobotExpression,
  RobotLedPattern,
  V2_LIMITS,
  fromEmotionTag,
  toLedPattern
} from './robot-controller'

export interface RobotActionResult {
  ok: boolean
  /** Short sentence for Brutus to say / report back to the model. */
  message: string
}

// ─── Fuzzy name lookup ──────────────────────────────────────────────────────

const normalize = (s: string): string =>
  String(s || '')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/[^a-z0-9 %]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Index of the label that best matches [name], or null. */
function indexByName(labels: string[], name: string): number | null {
  const n = normalize(name)
  if (!n) return null
  const norm = labels.map(normalize)
  let i = norm.indexOf(n)
  if (i >= 0) return i
  i = norm.findIndex((l) => l === n.replace(/^the /, ''))
  if (i >= 0) return i
  i = norm.findIndex((l) => l.includes(n) || n.includes(l))
  return i >= 0 ? i : null
}

/** Extra spoken aliases that don't appear verbatim in the label lists. */
const ANIMATION_ALIASES: Record<string, number> = {
  'nod your head': 0,
  yes: 0,
  'shake your head': 1,
  no: 1,
  'look around': 2,
  scan: 2,
  'wink at me': 3,
  'wink at them': 3,
  tired: 4,
  sleepy: 4,
  laughing: 5,
  'roll your eyes': 6,
  eyeroll: 6,
  'move your mouth': 7,
  talk: 7,
  dance: 9,
  shimmy: 9
}

const TRICK_ALIASES: Record<string, number> = {
  'crazy eye': 0,
  'go crazy': 0,
  chattering: 1,
  'slow look': 2,
  peekaboo: 3,
  'peek a boo': 3,
  'blink twice': 4,
  'drop your jaw': 5,
  'jaw drop': 5,
  drowsy: 6,
  'side eye': 7,
  bounce: 8,
  'act confused': 9,
  confused: 9
}

export function resolveAnimation(
  name: string
): { index: number; kind: 'animation' | 'trick' } | null {
  const n = normalize(name)
  if (!n) return null
  if (ANIMATION_ALIASES[n] !== undefined) return { index: ANIMATION_ALIASES[n], kind: 'animation' }
  if (TRICK_ALIASES[n] !== undefined) return { index: TRICK_ALIASES[n], kind: 'trick' }
  const a = indexByName(ANIMATION_LABELS, name)
  if (a !== null) return { index: a, kind: 'animation' }
  const t = indexByName(TRICK_LABELS, name)
  if (t !== null) return { index: t, kind: 'trick' }
  return null
}

// ─── Speed parsing ──────────────────────────────────────────────────────────

const SPEED_WORDS: Array<[RegExp, number]> = [
  [/\b(full|max(imum)?|top|flat out|as fast as)\b/, 100],
  [/\b(fast|quick(ly)?|speed(il)?y)\b/, 85],
  [/\b(half)\b/, 50],
  [/\b(medium|moderate|normal)\b/, 60],
  [/\b(slow(ly)?|gentl[ey]|carefully|creep)\b/, 30],
  [/\b(crawl|very slow(ly)?|barely)\b/, 20]
]

/**
 * Pull a speed percentage out of a phrase.
 * Understands "50%", "50 percent", "at 0.5", and words like "slowly"/"full speed".
 * Returns null when the phrase says nothing about speed.
 */
export function parseSpeedPercent(text: string): number | null {
  const t = normalize(text)

  const pct = t.match(/(\d{1,3})\s*(%|percent)/)
  if (pct) return Math.min(100, Math.max(0, parseInt(pct[1], 10)))

  // "at 50 speed" / "speed 50" — a bare number near the word speed.
  const nearSpeed = t.match(/speed\s*(?:of\s*)?(\d{1,3})|(\d{1,3})\s*speed/)
  if (nearSpeed) {
    const v = parseInt(nearSpeed[1] || nearSpeed[2], 10)
    if (v >= 0 && v <= 100) return v
  }

  for (const [re, v] of SPEED_WORDS) if (re.test(t)) return v
  return null
}

/** Percent (0-100) → the firmware's signed motor range (0-255). */
export function percentToMotor(percent: number): number {
  return Math.round((Math.min(100, Math.max(0, percent)) / 100) * 255)
}

// ─── Action execution ───────────────────────────────────────────────────────

export type RobotAction =
  | 'drive'
  | 'stop'
  | 'animation'
  | 'expression'
  | 'look'
  | 'head'
  | 'blink'
  | 'eyelid'
  | 'hands'
  | 'mouth'
  | 'led'
  | 'eye_color'
  | 'sound'
  | 'volume'
  | 'beep'
  | 'buzzer'
  | 'autonomous'
  | 'freeze'
  | 'idle'
  | 'reset'

export interface RobotActionArgs {
  name?: string
  percent?: number
  direction?: string
  lr?: number
  ud?: number
  angle?: number
  left?: number
  right?: number
  level?: number
  on?: boolean
  ms?: number
}

/**
 * Presets in 0-180 servo space (the controller maps these into the v2's much
 * narrower physical range). Named directions go to the extremes on purpose:
 * asked to "look left" the robot should visibly look left, not drift a few
 * degrees off centre.
 */
const DIRECTION_ANGLES: Record<string, { lr?: number; ud?: number }> = {
  left: { lr: 0 },
  right: { lr: 180 },
  up: { ud: 0 },
  down: { ud: 180 },
  center: { lr: 90, ud: 90 },
  centre: { lr: 90, ud: 90 },
  middle: { lr: 90, ud: 90 },
  forward: { lr: 90, ud: 90 },
  ahead: { lr: 90, ud: 90 },
  'upper left': { lr: 0, ud: 30 },
  'upper right': { lr: 180, ud: 30 },
  'lower left': { lr: 0, ud: 150 },
  'lower right': { lr: 180, ud: 150 }
}

/**
 * Run one robot action. This is the single execution point shared by the
 * cloud tool handler and the edge intent matcher.
 */
export function executeRobotAction(action: string, args: RobotActionArgs = {}): RobotActionResult {
  const c = robotController
  if (!c.anyConnected) {
    return {
      ok: false,
      message: 'No robot is connected. Open the ROBOT tab and connect one first.'
    }
  }

  const needsBody = (): RobotActionResult | null =>
    c.v2Connected
      ? null
      : { ok: false, message: 'That needs the V2 rover body, which is not connected.' }

  switch (action as RobotAction) {
    case 'drive': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      const percent = args.percent ?? 60
      const backward = /back|reverse|behind/.test(normalize(args.direction || ''))
      const motor = percentToMotor(percent) * (backward ? -1 : 1)
      c.drive(motor)
      return {
        ok: true,
        message: `Driving ${backward ? 'backward' : 'forward'} at ${Math.round(percent)}% speed.`
      }
    }

    case 'stop': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      c.stopDrive()
      return { ok: true, message: 'Stopped.' }
    }

    case 'animation': {
      const hit = resolveAnimation(args.name || '')
      if (!hit) return { ok: false, message: `I don't know the move "${args.name ?? ''}".` }
      if (hit.kind === 'animation') c.playAnimation(hit.index)
      else c.playTrick(hit.index)
      const label = hit.kind === 'animation' ? ANIMATION_LABELS[hit.index] : TRICK_LABELS[hit.index]
      return { ok: true, message: `Playing ${label}.` }
    }

    case 'expression': {
      const expr =
        fromEmotionTag(args.name || '') ?? indexByName(EXPRESSION_LABELS, args.name || '')
      if (expr === null) {
        return { ok: false, message: `I don't have an expression called "${args.name ?? ''}".` }
      }
      c.setExpression(expr)
      c.setLedPattern(toLedPattern(expr))
      return { ok: true, message: `Expression set to ${EXPRESSION_LABELS[expr]}.` }
    }

    case 'look': {
      const dir = normalize(args.direction || '')
      const preset = DIRECTION_ANGLES[dir]
      const lr = args.lr ?? preset?.lr ?? 90
      const ud = args.ud ?? preset?.ud ?? 90
      c.lookAt(lr, ud, true)
      return { ok: true, message: dir ? `Looking ${dir}.` : 'Eyes moved.' }
    }

    case 'head': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      const dir = normalize(args.direction || '')
      // Neck is a 0-180 servo space that the controller maps into 58-122.
      const angle = args.angle ?? (dir.includes('left') ? 0 : dir.includes('right') ? 180 : 90)
      c.setNeck(angle)
      return { ok: true, message: dir ? `Turning head ${dir}.` : 'Head moved.' }
    }

    case 'blink':
      c.blink()
      return { ok: true, message: 'Blinked.' }

    case 'eyelid': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      const n = normalize(args.name || args.direction || '')
      const angle =
        args.angle ??
        (n.includes('close') || n.includes('shut')
          ? V2_LIMITS.lidClosed
          : n.includes('wide') || n.includes('surprise')
            ? V2_LIMITS.lidWide
            : V2_LIMITS.lidOpen)
      c.setEyelid(angle)
      return { ok: true, message: 'Eyelids adjusted.' }
    }

    case 'hands': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      const n = normalize(args.name || args.direction || '')
      let left = args.left
      let right = args.right
      if (left === undefined && right === undefined) {
        const raised = n.includes('raise') || n.includes('up') || n.includes('wave')
        left = raised ? 160 : 20
        right = raised ? 160 : 20
      }
      c.setHands(left ?? 90, right ?? 90)
      return { ok: true, message: 'Hands moved.' }
    }

    case 'mouth': {
      const n = normalize(args.name || args.direction || '')
      const level = args.level ?? (n.includes('open') ? 1 : 0)
      if (level <= 0.02) c.closeMouth()
      else c.setMouthLevel(level)
      return { ok: true, message: level > 0.02 ? 'Mouth open.' : 'Mouth closed.' }
    }

    case 'led': {
      const n = normalize(args.name || '')
      const pattern =
        args.level ??
        (n.includes('off')
          ? RobotLedPattern.off
          : n.includes('pulse') || n.includes('breath')
            ? RobotLedPattern.pulse
            : n.includes('fast') || n.includes('blink') || n.includes('flash')
              ? RobotLedPattern.fastBlink
              : RobotLedPattern.solid)
      c.setLedPattern(pattern)
      return { ok: true, message: 'LED updated.' }
    }

    case 'eye_color': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      const n = normalize(args.name || '')
      const color = n.includes('off')
        ? 0
        : n.includes('blue')
          ? 1
          : n.includes('green')
            ? 2
            : n.includes('both') || n.includes('all') || n.includes('cyan')
              ? 3
              : 1
      c.setEyeColor(color)
      return { ok: true, message: 'Eye colour set.' }
    }

    case 'sound': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      const raw = normalize(args.name || '')
      // Accept the cue name, a close variant, or a bare cue letter.
      const key =
        Object.keys(SOUND_CUES).find((k) => k === raw) ||
        Object.keys(SOUND_CUES).find((k) => raw.includes(k) || k.includes(raw))
      if (!key) return { ok: false, message: `I don't have a "${args.name ?? ''}" sound.` }
      c.soundByName(key)
      return { ok: true, message: `Playing the ${key} sound.` }
    }

    case 'volume': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      // Accept 0-9 directly or a 0-100 percentage.
      const raw = args.level ?? args.percent ?? 7
      const level = raw > 9 ? Math.round((raw / 100) * 9) : Math.round(raw)
      c.setVolume(level)
      return { ok: true, message: `Robot volume set to ${Math.min(9, Math.max(0, level))} of 9.` }
    }

    case 'beep': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      c.beep(args.ms ?? 120)
      return { ok: true, message: 'Beeped.' }
    }

    case 'buzzer': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      c.buzzer(args.on !== false)
      return { ok: true, message: `Buzzer ${args.on !== false ? 'on' : 'off'}.` }
    }

    case 'autonomous': {
      const bodyErr = needsBody()
      if (bodyErr) return bodyErr
      const on = args.on !== false
      c.setAutonomous(on)
      return {
        ok: true,
        message: on
          ? 'Autonomous mode on — roaming on my own now.'
          : 'Manual mode on — you have control.'
      }
    }

    case 'freeze':
      c.setFreezeMode(args.on !== false)
      return { ok: true, message: args.on !== false ? 'Holding still.' : 'Freeze released.' }

    case 'idle':
      c.setIdleFallback(args.on !== false)
      return { ok: true, message: `Idle behaviour ${args.on !== false ? 'on' : 'off'}.` }

    case 'reset':
      c.stopDrive()
      c.lookAt(90, 90, true)
      c.closeMouth()
      c.setExpression(RobotExpression.happy)
      c.setLedPattern(RobotLedPattern.solid)
      if (c.v2Connected) {
        c.setNeck(90)
        c.setHands(90, 90)
      }
      return { ok: true, message: 'Reset to neutral.' }

    default:
      return { ok: false, message: `Unknown robot action "${action}".` }
  }
}

// ─── Spoken-phrase matching (edge engine / no tool calling) ──────────────────

/** Phrases that mean "this is addressed to the robot body". */
const ADDRESSED = /\b(robot|brutus|your (head|eyes?|mouth|hands?|jaw|face)|yourself)\b/

interface Rule {
  test: RegExp
  /** Return null to decline (lets a later rule try). */
  run: (text: string, m: RegExpMatchArray) => RobotActionResult | null
}

const RULES: Rule[] = [
  // ── Movement ──
  {
    test: /\b(stop|halt|freeze|brake|stand still|don'?t move)\b/,
    run: (t) =>
      /\bfreeze\b|\bstand still\b/.test(t)
        ? executeRobotAction('freeze', { on: true })
        : executeRobotAction('stop')
  },
  {
    test: /\b(go|move|drive|walk|run|roll|come)\b.*\b(forward|ahead|front|straight|backward|backwards|back|reverse)\b|\b(forward|backward|backwards|reverse)\b.*\b(speed|percent|%)/,
    run: (t) => {
      const backward = /\b(backward|backwards|back|reverse)\b/.test(t)
      const percent = parseSpeedPercent(t) ?? 60
      return executeRobotAction('drive', {
        percent,
        direction: backward ? 'backward' : 'forward'
      })
    }
  },
  // ── Head / neck ──
  {
    test: /\b(turn|rotate|swing|point)\b.*\bhead\b|\bhead\b.*\b(left|right|straight|center|centre|forward)\b/,
    run: (t) => {
      const dir = /\bleft\b/.test(t) ? 'left' : /\bright\b/.test(t) ? 'right' : 'center'
      return executeRobotAction('head', { direction: dir })
    }
  },
  // ── Eyes ──
  {
    test: /\blook\b.*\b(left|right|up|down|center|centre|straight|ahead|at me)\b/,
    run: (t) => {
      const dir = /\bleft\b/.test(t)
        ? 'left'
        : /\bright\b/.test(t)
          ? 'right'
          : /\bup\b/.test(t)
            ? 'up'
            : /\bdown\b/.test(t)
              ? 'down'
              : 'center'
      return executeRobotAction('look', { direction: dir })
    }
  },
  {
    test: /\b(blink|wink)\b/,
    run: (t) =>
      /\bwink\b/.test(t)
        ? executeRobotAction('animation', { name: 'wink' })
        : executeRobotAction('blink')
  },
  {
    test: /\b(open|close|shut|widen)\b.*\beyes?\b/,
    run: (t) =>
      executeRobotAction('eyelid', {
        name: /\b(close|shut)\b/.test(t) ? 'close' : /\bwiden\b/.test(t) ? 'wide' : 'open'
      })
  },
  // ── Expression ──
  {
    test: /\b(look|act|be|seem|show|make).{0,16}\b(happy|angry|mad|sad|thinking|sleepy|tired|surprised|shocked|love|excited|confused|scared|afraid)\b/,
    run: (t) => {
      const m = t.match(
        /\b(happy|angry|mad|sad|thinking|sleepy|tired|surprised|shocked|love|excited|confused|scared|afraid)\b/
      )
      if (!m) return null
      const word = m[1]
        .replace('mad', 'angry')
        .replace('tired', 'sleepy')
        .replace('shocked', 'surprised')
        .replace('afraid', 'scared')
      return executeRobotAction('expression', { name: word })
    }
  },
  // ── Named moves ──
  {
    test: /\b(nod|shake your head|look around|yawn|laugh|eye roll|roll your eyes|wiggle|dance|crazy eyes|chatter|slow scan|peek ?a ?boo|double blink|jaw drop|drowsy|side eye|happy bounce|confused)\b/,
    run: (_t, m) => executeRobotAction('animation', { name: m[0] })
  },
  // ── Sound ──
  {
    test: /\b(play|make|sound|do)\b.{0,20}\b(boot|patrol|curious|alarm|relief|happy|mumble|silence|thinking|listening|error|success|notify|shutdown)\b.{0,10}\b(sound|noise|tone|cue|chirp)?\b/,
    run: (_t, m) => executeRobotAction('sound', { name: m[2] })
  },
  {
    test: /\b(beep|honk)\b/,
    run: () => executeRobotAction('beep', {})
  },
  {
    test: /\b(volume|louder|quieter|turn it (up|down))\b/,
    run: (t) => {
      const pct = parseSpeedPercent(t)
      const num = t.match(/\bvolume\s*(?:to\s*)?(\d{1,3})\b/)
      if (num) return executeRobotAction('volume', { level: parseInt(num[1], 10) })
      if (pct !== null) return executeRobotAction('volume', { percent: pct })
      const up = /louder|turn it up/.test(t)
      return executeRobotAction('volume', {
        level: Math.min(9, Math.max(0, robotController.volume + (up ? 2 : -2)))
      })
    }
  },
  // ── Eye colour / LED ──
  {
    test: /\b(eyes?|led|lights?)\b.{0,12}\b(blue|green|off|both|red)\b|\b(blue|green)\b.{0,6}\beyes?\b/,
    run: (t) => {
      const color = /\boff\b/.test(t)
        ? 'off'
        : /\bblue\b/.test(t)
          ? 'blue'
          : /\bgreen\b/.test(t)
            ? 'green'
            : 'both'
      return executeRobotAction('eye_color', { name: color })
    }
  },
  // ── Hands ──
  {
    test: /\b(raise|lift|lower|drop|wave)\b.{0,14}\b(hands?|arms?)\b|\bwave\b/,
    run: (t) =>
      executeRobotAction('hands', {
        name: /\b(raise|lift|wave)\b/.test(t) ? 'raise' : 'lower'
      })
  },
  // ── Modes ──
  {
    test: /\b(autonomous|auto mode|roam|explore on your own|patrol mode)\b/,
    run: () => executeRobotAction('autonomous', { on: true })
  },
  {
    test: /\b(manual mode|take over|i'?ll drive|listen to me now)\b/,
    run: () => executeRobotAction('autonomous', { on: false })
  },
  {
    test: /\b(reset|neutral|stand down|as you were|relax)\b/,
    run: () => executeRobotAction('reset')
  }
]

/** "don't move forward" must not drive the rover forward. */
const NEGATED = /\b(dont|do not|never|stop trying|instead of|without|rather than|no need to)\b/

/**
 * Longest an unaddressed utterance may be and still count as a command.
 * Real commands are short imperatives ("look up", "drive forward at 50%");
 * anything rambling is conversation that merely happens to contain a verb,
 * e.g. "can you tell me about the forward pass in neural networks".
 */
const MAX_COMMAND_WORDS = 8

/**
 * Try to interpret a spoken sentence as a robot command.
 * Returns null when it isn't one, so the caller falls through to normal chat.
 *
 * Three guards keep ordinary conversation from moving the robot: the phrase
 * must match a specific body rule, must not be negated, and — unless it names
 * the robot or one of its parts — must be short enough to be an imperative.
 */
export function matchRobotCommand(text: string): RobotActionResult | null {
  const t = normalize(text)
  if (!t || !robotController.anyConnected) return null
  if (NEGATED.test(t)) return null

  const addressed = ADDRESSED.test(t)
  if (!addressed && t.split(' ').length > MAX_COMMAND_WORDS) return null

  for (const rule of RULES) {
    const m = t.match(rule.test)
    if (!m) continue
    const res = rule.run(t, m)
    if (res) return res
  }
  return null
}
