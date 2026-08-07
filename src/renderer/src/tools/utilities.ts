// ─── Calculator (safe shunting-yard evaluator — no eval) ──────────────
const FUNCTIONS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  ln: Math.log,
  log: Math.log10,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  exp: Math.exp
}
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

type Token = { type: 'num' | 'op' | 'lparen' | 'rparen' | 'func'; value: string }

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const s = expr.replace(/\s+/g, '')
  while (i < s.length) {
    const c = s[i]
    if (/[0-9.]/.test(c)) {
      let num = ''
      while (i < s.length && /[0-9.]/.test(s[i])) num += s[i++]
      tokens.push({ type: 'num', value: num })
      continue
    }
    if (/[a-zA-Z]/.test(c)) {
      let name = ''
      while (i < s.length && /[a-zA-Z]/.test(s[i])) name += s[i++]
      const lower = name.toLowerCase()
      if (CONSTANTS[lower] !== undefined) tokens.push({ type: 'num', value: String(CONSTANTS[lower]) })
      else if (FUNCTIONS[lower]) tokens.push({ type: 'func', value: lower })
      else throw new Error(`Unknown name: ${name}`)
      continue
    }
    if ('+-*/%^'.includes(c)) {
      // unary minus → 0 - x
      if (c === '-' && (tokens.length === 0 || tokens[tokens.length - 1].type === 'op' || tokens[tokens.length - 1].type === 'lparen')) {
        tokens.push({ type: 'num', value: '0' })
      }
      tokens.push({ type: 'op', value: c })
      i++
      continue
    }
    if (c === '(') { tokens.push({ type: 'lparen', value: c }); i++; continue }
    if (c === ')') { tokens.push({ type: 'rparen', value: c }); i++; continue }
    throw new Error(`Unexpected character: ${c}`)
  }
  return tokens
}

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 }
const RIGHT_ASSOC = new Set(['^'])

function evaluate(expr: string): number {
  const tokens = tokenize(expr)
  const output: Token[] = []
  const stack: Token[] = []
  for (const t of tokens) {
    if (t.type === 'num') output.push(t)
    else if (t.type === 'func') stack.push(t)
    else if (t.type === 'op') {
      while (
        stack.length &&
        (stack[stack.length - 1].type === 'func' ||
          (stack[stack.length - 1].type === 'op' &&
            (PREC[stack[stack.length - 1].value] > PREC[t.value] ||
              (PREC[stack[stack.length - 1].value] === PREC[t.value] && !RIGHT_ASSOC.has(t.value)))))
      ) {
        output.push(stack.pop()!)
      }
      stack.push(t)
    } else if (t.type === 'lparen') stack.push(t)
    else if (t.type === 'rparen') {
      while (stack.length && stack[stack.length - 1].type !== 'lparen') output.push(stack.pop()!)
      if (!stack.length) throw new Error('Mismatched parentheses')
      stack.pop()
      if (stack.length && stack[stack.length - 1].type === 'func') output.push(stack.pop()!)
    }
  }
  while (stack.length) {
    const t = stack.pop()!
    if (t.type === 'lparen') throw new Error('Mismatched parentheses')
    output.push(t)
  }

  const evalStack: number[] = []
  for (const t of output) {
    if (t.type === 'num') evalStack.push(parseFloat(t.value))
    else if (t.type === 'func') {
      const a = evalStack.pop()
      if (a === undefined) throw new Error('Invalid expression')
      evalStack.push(FUNCTIONS[t.value](a))
    } else if (t.type === 'op') {
      const b = evalStack.pop()
      const a = evalStack.pop()
      if (a === undefined || b === undefined) throw new Error('Invalid expression')
      switch (t.value) {
        case '+': evalStack.push(a + b); break
        case '-': evalStack.push(a - b); break
        case '*': evalStack.push(a * b); break
        case '/': evalStack.push(a / b); break
        case '%': evalStack.push(a % b); break
        case '^': evalStack.push(Math.pow(a, b)); break
      }
    }
  }
  if (evalStack.length !== 1) throw new Error('Invalid expression')
  return evalStack[0]
}

export const calculate = (expression: string): string => {
  try {
    const result = evaluate(String(expression))
    if (!isFinite(result)) return `❌ The expression "${expression}" is undefined or infinite.`
    const rounded = Math.round(result * 1e10) / 1e10
    return `${expression} = ${rounded}`
  } catch (e: any) {
    return `❌ Could not evaluate "${expression}": ${e.message}`
  }
}

// ─── Unit conversion ──────────────────────────────────────────────────
// Each category maps a unit → factor relative to a base unit.
const UNITS: Record<string, Record<string, number>> = {
  length: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 },
  mass: { mg: 0.001, g: 1, kg: 1000, t: 1e6, oz: 28.349523125, lb: 453.59237 },
  volume: { ml: 0.001, l: 1, m3: 1000, tsp: 0.00492892, tbsp: 0.0147868, cup: 0.24, pt: 0.473176, qt: 0.946353, gal: 3.785411784 },
  data: { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 },
  speed: { mps: 1, kmph: 0.277778, mph: 0.44704, knot: 0.514444 },
  time: { ms: 0.001, s: 1, min: 60, hr: 3600, day: 86400, week: 604800 }
}
const UNIT_ALIASES: Record<string, string> = {
  meter: 'm', meters: 'm', metre: 'm', kilometer: 'km', kilometers: 'km', kilometre: 'km',
  centimeter: 'cm', centimeters: 'cm', millimeter: 'mm', millimeters: 'mm',
  inch: 'in', inches: 'in', foot: 'ft', feet: 'ft', yard: 'yd', yards: 'yd', mile: 'mi', miles: 'mi',
  gram: 'g', grams: 'g', kilogram: 'kg', kilograms: 'kg', milligram: 'mg', tonne: 't', ton: 't',
  ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb',
  liter: 'l', liters: 'l', litre: 'l', milliliter: 'ml', gallon: 'gal', gallons: 'gal',
  byte: 'b', bytes: 'b', kilobyte: 'kb', megabyte: 'mb', gigabyte: 'gb', terabyte: 'tb',
  second: 's', seconds: 's', sec: 's', minute: 'min', minutes: 'min', hour: 'hr', hours: 'hr',
  days: 'day', weeks: 'week', celsius: 'c', fahrenheit: 'f', kelvin: 'k',
  kph: 'kmph', 'km/h': 'kmph', 'm/s': 'mps'
}

const normUnit = (u: string) => {
  const k = u.toLowerCase().trim()
  return UNIT_ALIASES[k] || k
}

function convertTemp(value: number, from: string, to: string): number | null {
  const f = from.toLowerCase()
  const t = to.toLowerCase()
  const temps = ['c', 'f', 'k', 'celsius', 'fahrenheit', 'kelvin']
  if (!temps.includes(f) || !temps.includes(t)) return null
  // to Celsius
  let c: number
  if (f.startsWith('c')) c = value
  else if (f.startsWith('f')) c = ((value - 32) * 5) / 9
  else c = value - 273.15
  if (t.startsWith('c')) return c
  if (t.startsWith('f')) return (c * 9) / 5 + 32
  return c + 273.15
}

export const convertUnits = (value: number, from: string, to: string): string => {
  const v = Number(value)
  if (isNaN(v)) return `❌ "${value}" is not a number.`

  const temp = convertTemp(v, from, to)
  if (temp !== null) {
    return `${v}°${from.toUpperCase()[0]} = ${Math.round(temp * 100) / 100}°${to.toUpperCase()[0]}`
  }

  const f = normUnit(from)
  const t = normUnit(to)
  for (const cat of Object.keys(UNITS)) {
    if (UNITS[cat][f] !== undefined && UNITS[cat][t] !== undefined) {
      const base = v * UNITS[cat][f]
      const result = base / UNITS[cat][t]
      const rounded = Math.round(result * 1e6) / 1e6
      return `${v} ${from} = ${rounded} ${to}`
    }
  }
  return `❌ I can't convert from "${from}" to "${to}" (unknown or incompatible units).`
}

// ─── Password generator (cryptographically secure) ────────────────────
export const generatePassword = (
  length = 16,
  opts: { symbols?: boolean; numbers?: boolean; uppercase?: boolean } = {}
): string => {
  const len = Math.max(4, Math.min(Number(length) || 16, 128))
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const nums = '0123456789'
  const syms = '!@#$%^&*()-_=+[]{};:,.<>?'

  let pool = lower
  if (opts.uppercase !== false) pool += upper
  if (opts.numbers !== false) pool += nums
  if (opts.symbols !== false) pool += syms

  const arr = new Uint32Array(len)
  crypto.getRandomValues(arr)
  let out = ''
  for (let i = 0; i < len; i++) out += pool[arr[i] % pool.length]
  return `🔐 Generated password (${len} chars): ${out}`
}
