import { app, dialog, shell, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { logsDirectory, write } from './logger'

/**
 * BRUTUS — crash handling and session recovery.
 *
 * Two jobs:
 *
 *  1. **Never show a user a stack trace.** An unhandled error in the main
 *     process currently ends the app with Electron's default dialog, which is a
 *     wall of JavaScript. A person reading that learns nothing they can act on
 *     and concludes the software is broken. They get a plain sentence, the
 *     choice to keep going or restart, and a button to the log file instead.
 *
 *  2. **Know whether the last exit was clean.** A marker file is written at
 *     startup and removed on a graceful quit. If it is still there next launch,
 *     the previous run died — so the renderer can offer to restore rather than
 *     pretending nothing happened.
 *
 * ── WHY MOST ERRORS DO NOT CLOSE THE APP ───────────────────────────────────
 * Brutus is a shell around a lot of independent subsystems. A failure in one
 * tool handler is almost never a reason to kill a session that may have running
 * agents and unsaved notes. So an unhandled rejection is logged and swallowed,
 * and even an uncaught exception offers "keep working" first. Only the user
 * decides to quit.
 */

/** Present while a session is live. Its survival means the last run crashed. */
const MARKER = 'session-active.json'

export interface LastSession {
  /** Did the previous run exit without going through `will-quit`? */
  crashed: boolean
  /** When the crashed session started, if there was one. */
  startedAt?: number
  /** Last error recorded before it went down, if any. */
  reason?: string
}

let markerPath = ''
let lastSession: LastSession = { crashed: false }
/** Errors already shown, so one repeating fault cannot stack dialogs forever. */
const shown = new Set<string>()
let dialogOpen = false

function readMarker(): LastSession {
  try {
    if (!fs.existsSync(markerPath)) return { crashed: false }
    const raw = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
      startedAt?: number
      reason?: string
    }
    return { crashed: true, startedAt: raw.startedAt, reason: raw.reason }
  } catch {
    // A marker we cannot parse still proves the process did not clean up.
    return { crashed: true }
  }
}

function writeMarker(reason?: string): void {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ startedAt: Date.now(), version: app.getVersion(), reason: reason ?? '' })
    )
  } catch {
    /* Recovery is a courtesy; failing to arm it must not block startup. */
  }
}

/** What the renderer asks for on boot to decide whether to offer a restore. */
export function previousSession(): LastSession {
  return lastSession
}

/**
 * Turn an internal error into something worth reading.
 *
 * The mapping is deliberately small. A guessed explanation that is wrong is
 * worse than an honest generic one, so anything unrecognised keeps its own
 * message and simply loses the stack.
 */
export function humanise(err: unknown): { title: string; detail: string } {
  const raw = String((err as { message?: string })?.message ?? err)
  const lower = raw.toLowerCase()

  if (lower.includes('eaddrinuse')) {
    return {
      title: 'A port Brutus needs is already in use.',
      detail:
        'Another program — possibly a second copy of Brutus — is holding it. Closing that program and restarting should clear it.'
    }
  }
  if (lower.includes('eacces') || lower.includes('eperm')) {
    return {
      title: 'Windows refused permission for that action.',
      detail:
        'The file or folder may be read-only, in use, or outside the area Brutus is allowed to touch.'
    }
  }
  if (lower.includes('enospc')) {
    return {
      title: 'The disk is full.',
      detail: 'Brutus could not finish writing. Free some space and try again.'
    }
  }
  if (lower.includes('enoent')) {
    return {
      title: 'Something Brutus expected to find is missing.',
      detail: 'A file or folder it needed was not there. Reinstalling restores the bundled files.'
    }
  }
  if (
    lower.includes('dlopen') ||
    lower.includes('was compiled against a different node') ||
    lower.includes('.node')
  ) {
    return {
      title: 'A native component failed to load.',
      detail:
        'This usually means the install is incomplete. Reinstalling Brutus replaces the affected files.'
    }
  }
  if (lower.includes('enotfound') || lower.includes('eai_again')) {
    return {
      title: 'Brutus cannot reach the network.',
      detail:
        'Everything on-device still works. Cloud providers will be unavailable until it is back.'
    }
  }
  return {
    title: 'Brutus hit an unexpected problem.',
    detail: raw.slice(0, 400)
  }
}

/**
 * Install the handlers.
 *
 * Call once, as early as possible — an error thrown before this runs still gets
 * Electron's default dialog.
 */
export function installCrashGuard(): LastSession {
  markerPath = path.join(app.getPath('userData'), MARKER)
  lastSession = readMarker()
  if (lastSession.crashed) {
    write(
      'warn',
      `Previous session did not exit cleanly${lastSession.reason ? `: ${lastSession.reason}` : ''}`
    )
  }
  writeMarker()

  /**
   * A rejected promise is logged and otherwise ignored.
   *
   * These come overwhelmingly from optional integrations — a provider timing
   * out, a device that is not plugged in — and none of them is a reason to take
   * down a window that may be running agents.
   */
  process.on('unhandledRejection', (reason) => {
    write(
      'error',
      `Unhandled rejection: ${String((reason as { stack?: string })?.stack ?? reason)}`
    )
  })

  process.on('uncaughtException', (err) => {
    write('error', `Uncaught exception: ${err.stack ?? err.message}`)

    // One dialog at a time, and one per distinct fault. A failing timer can
    // raise the same error every second, and a queue of identical dialogs is
    // indistinguishable from a hang.
    const fingerprint = `${err.name}:${err.message}`.slice(0, 200)
    if (dialogOpen || shown.has(fingerprint)) return
    shown.add(fingerprint)
    dialogOpen = true

    const { title, detail } = humanise(err)
    const win = BrowserWindow.getAllWindows()[0]

    const options = {
      type: 'error' as const,
      title: 'Brutus',
      message: title,
      detail: `${detail}\n\nThe details have been written to the log file.`,
      buttons: ['Keep working', 'Open log folder', 'Restart Brutus'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }

    // Synchronous on purpose: the process is in an unknown state and an async
    // dialog can be cut short by whatever happens next.
    const choice = win
      ? dialog.showMessageBoxSync(win, options)
      : dialog.showMessageBoxSync(options)

    dialogOpen = false

    if (choice === 1) {
      void shell.openPath(logsDirectory())
    } else if (choice === 2) {
      clearMarker()
      app.relaunch()
      app.exit(0)
    }
    // Choice 0 deliberately does nothing. The user keeps their session.
  })

  // Renderer death is separate: the window is gone, so there is nothing to
  // "keep working" in.
  app.on('render-process-gone', (_e, _wc, details) => {
    write('error', `Renderer gone: ${details.reason} (exitCode ${details.exitCode})`)
    if (details.reason === 'clean-exit') return
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Brutus',
      message: 'The Brutus window closed unexpectedly.',
      detail: 'Restarting usually fixes this. Your saved work is on disk and will be restored.',
      buttons: ['Restart Brutus', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    clearMarker()
    if (choice === 0) app.relaunch()
    app.exit(0)
  })

  return lastSession
}

/** Called from `will-quit`. Its absence next launch is what flags a crash. */
export function clearMarker(): void {
  try {
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath)
  } catch {
    /* Nothing useful to do if this fails. */
  }
}
