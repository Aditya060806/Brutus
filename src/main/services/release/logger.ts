import { app } from 'electron'
import fs from 'fs'
import path from 'path'

/**
 * BRUTUS — file logging.
 *
 * A packaged app has no console. When a user says "it did not work", the only
 * thing that can settle what happened is a file on their disk — so everything
 * that already went to `console` also lands in `userData/logs/YYYY-MM-DD.log`.
 *
 * ── WHY IT WRAPS CONSOLE RATHER THAN REPLACING IT ──────────────────────────
 * There are hundreds of existing `console.log` calls across the main process,
 * and rewriting them all to a new logger would be a large diff that adds no
 * capability. Patching console once at startup captures every one of them —
 * including calls from inside dependencies — and keeps the terminal output
 * intact during development.
 *
 * ── WHY IT IS BOUNDED ──────────────────────────────────────────────────────
 * One file per day, and old files pruned. A long-lived install must not grow a
 * log directory without limit, and a 400 MB log is one nobody can attach to a
 * bug report anyway.
 */

/** Days of history kept. Beyond this, a log is not helping anyone. */
const KEEP_DAYS = 7
/** A single day's file is capped; past this it rotates to `.1`. */
const MAX_BYTES = 5 * 1024 * 1024

let stream: fs.WriteStream | null = null
let logDir = ''
let currentDay = ''

const stamp = (d = new Date()): string =>
  [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-')

const clock = (d = new Date()): string =>
  [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0')
  ].join(':')

export function logsDirectory(): string {
  return logDir || path.join(app.getPath('userData'), 'logs')
}

/** Today's file, opened lazily and reopened when the date rolls over. */
function ensureStream(): fs.WriteStream | null {
  const day = stamp()
  if (stream && day === currentDay) return stream

  try {
    fs.mkdirSync(logDir, { recursive: true })
    if (stream) stream.end()
    currentDay = day
    const file = path.join(logDir, `${day}.log`)

    // Rotate a file that has already grown past the cap, so one very chatty
    // session cannot bury the rest of the day.
    try {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0
      if (size > MAX_BYTES) fs.renameSync(file, path.join(logDir, `${day}.1.log`))
    } catch {
      /* Rotation is a nicety; failing it must not stop logging. */
    }

    stream = fs.createWriteStream(file, { flags: 'a' })
    // A logger that can throw is worse than no logger.
    stream.on('error', () => {
      stream = null
    })
    return stream
  } catch {
    return null
  }
}

function prune(): void {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600_000
    for (const name of fs.readdirSync(logDir)) {
      if (!name.endsWith('.log')) continue
      const full = path.join(logDir, name)
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
    }
  } catch {
    /* Housekeeping only. */
  }
}

/** Flatten a console argument list into one line. */
function render(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

export type Level = 'info' | 'warn' | 'error'

export function write(level: Level, message: string): void {
  const s = ensureStream()
  if (!s) return
  try {
    s.write(`${clock()} [${level.toUpperCase()}] ${message}\n`)
  } catch {
    /* Never let logging break the thing being logged. */
  }
}

/**
 * Start capturing. Safe to call once, early in startup.
 *
 * Returns the directory so the caller can show it to the user.
 */
export function installLogger(): string {
  logDir = path.join(app.getPath('userData'), 'logs')
  ensureStream()
  prune()

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }

  const patch =
    (level: Level, native: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      native(...args)
      write(level, render(args))
    }

  console.log = patch('info', original.log)
  console.info = patch('info', original.info)
  console.warn = patch('warn', original.warn)
  console.error = patch('error', original.error)

  write('info', '─'.repeat(60))
  write('info', `Brutus ${app.getVersion()} starting on ${process.platform} ${process.arch}`)
  write('info', `Electron ${process.versions.electron} · Node ${process.versions.node}`)
  write('info', `Packaged: ${app.isPackaged}`)

  return logDir
}

/** Newest-first list of log files, for the Diagnostics panel and bug reports. */
export function listLogs(): { name: string; path: string; bytes: number; modified: number }[] {
  try {
    return fs
      .readdirSync(logDir)
      .filter((n) => n.endsWith('.log'))
      .map((name) => {
        const full = path.join(logDir, name)
        const st = fs.statSync(full)
        return { name, path: full, bytes: st.size, modified: st.mtimeMs }
      })
      .sort((a, b) => b.modified - a.modified)
  } catch {
    return []
  }
}

/** The tail of today's log, for attaching to a bug report. */
export function recentLog(maxBytes = 64 * 1024): string {
  try {
    const file = path.join(logDir, `${stamp()}.log`)
    if (!fs.existsSync(file)) return ''
    const { size } = fs.statSync(file)
    const start = Math.max(0, size - maxBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}
