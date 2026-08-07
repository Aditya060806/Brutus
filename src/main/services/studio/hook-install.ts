/**
 * BRUTUS Studio — Claude Code hook installation
 * ----------------------------------------------
 * Points Claude Code's `PreToolUse` hook at Brutus's local policy server, so
 * every tool call is decided deterministically.
 *
 * This writes into the user's project folder, which deserves care:
 *
 *  • Only ever `.claude/settings.local.json` — the local, personal, normally
 *    git-ignored file. Never `settings.json`, which is shared with a team.
 *  • Deep-merged, so existing hooks and settings survive. Brutus adds one entry
 *    and tags it, rather than replacing the file.
 *  • The prior file is backed up beside it before the first write.
 *  • Fully reversible: `uninstallHook` removes only Brutus's entry and restores
 *    the backup when nothing else was added.
 *
 * The bearer token lives in this file, which is why it must be the local,
 * git-ignored one: it authorises decisions on this machine for this session.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const SETTINGS_DIR = '.claude'
const SETTINGS_FILE = 'settings.local.json'
const BACKUP_FILE = 'settings.local.json.brutus-backup'

/** Marks the entry as ours so removal never touches someone else's hook. */
const BRUTUS_MARK = '__brutus_studio'

/**
 * One hook Claude Code will run.
 *
 * An `http` hook carries a **`url`**. This said `command` at first — the key a
 * `type: "command"` hook uses — and Claude Code rejected every settings file we
 * wrote with `hooks.PreToolUse.0.hooks.0.url: Expected string, but received
 * undefined`. The two hook types do not share a field name.
 */
interface HookEntry {
  type: string
  url: string
  headers?: Record<string, string>
  timeout?: number
  [k: string]: unknown
}

interface HookMatcher {
  matcher?: string
  hooks: HookEntry[]
  [k: string]: unknown
}

interface Settings {
  hooks?: Record<string, HookMatcher[]>
  [k: string]: unknown
}

function settingsPath(cwd: string): string {
  return path.join(cwd, SETTINGS_DIR, SETTINGS_FILE)
}

/**
 * Is this folder the user's home directory?
 *
 * It matters because `~/.claude/settings.local.json` is not a project file at
 * all — it is Claude Code's **user-level** configuration, and a hook written
 * there applies to every Claude Code session on the machine, including ones
 * started in a terminal that has nothing to do with Brutus.
 *
 * That is exactly what happened: launching a Studio node with the working
 * directory left at the home folder installed a machine-wide hook pointing at a
 * policy server that only exists while Brutus is running. Refusing here keeps
 * this feature's blast radius inside a real project folder, which is the whole
 * premise of writing to `settings.local.json` in the first place.
 */
export function isHomeDirectory(cwd: string, home = os.homedir()): boolean {
  try {
    return path.resolve(cwd) === path.resolve(home)
  } catch {
    return false
  }
}

function readSettings(file: string): Settings {
  try {
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Settings
  } catch (err) {
    console.warn('[Studio] could not parse existing settings.local.json:', err)
    // A malformed file is not ours to fix; treat it as empty and back it up so
    // nothing the user wrote is lost.
    return {}
  }
}

export interface HookInstallResult {
  ok: boolean
  file?: string
  backedUp?: boolean
  error?: string
}

/**
 * Install (or refresh) the Brutus permission hook for one working folder.
 * Idempotent: re-installing replaces only the Brutus entry.
 */
export function installClaudeHook(
  cwd: string,
  endpoint: string,
  token: string,
  sessionId: string
): HookInstallResult {
  try {
    if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: 'Working folder does not exist.' }

    if (isHomeDirectory(cwd)) {
      return {
        ok: false,
        error:
          'Refusing to install the permission hook in your home folder — that file is ' +
          'Claude Code’s global configuration and the hook would apply to every session ' +
          'on this machine. Pick a project folder for this agent instead. Brutus will ' +
          'still watch this session for permission prompts.'
      }
    }

    const dir = path.join(cwd, SETTINGS_DIR)
    const file = settingsPath(cwd)
    fs.mkdirSync(dir, { recursive: true })

    // Back up once, before the first modification.
    let backedUp = false
    const backup = path.join(dir, BACKUP_FILE)
    if (fs.existsSync(file) && !fs.existsSync(backup)) {
      fs.copyFileSync(file, backup)
      backedUp = true
    }

    const settings = readSettings(file)
    settings.hooks = settings.hooks ?? {}
    const existing = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : []

    // Drop any previous Brutus entry, keep everything else untouched.
    const preserved = existing.filter(
      (m) => !m.hooks?.some((h) => (h as Record<string, unknown>)[BRUTUS_MARK] === true)
    )

    const entry: HookMatcher = {
      hooks: [
        {
          type: 'http',
          url: endpoint,
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Brutus-Session': sessionId
          },
          timeout: 30,
          [BRUTUS_MARK]: true
        }
      ]
    }

    settings.hooks.PreToolUse = [...preserved, entry]
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8')
    return { ok: true, file, backedUp }
  } catch (err) {
    return { ok: false, error: String((err as { message?: string })?.message || err) }
  }
}

/**
 * Remove the Brutus hook. Restores the backup when our entry was the only
 * thing in the file, so the folder is left exactly as it was found.
 */
export function uninstallClaudeHook(cwd: string): HookInstallResult {
  try {
    const dir = path.join(cwd, SETTINGS_DIR)
    const file = settingsPath(cwd)
    const backup = path.join(dir, BACKUP_FILE)
    if (!fs.existsSync(file)) {
      return { ok: true }
    }

    const settings = readSettings(file)
    const existing = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks!.PreToolUse : []
    const preserved = existing.filter(
      (m) => !m.hooks?.some((h) => (h as Record<string, unknown>)[BRUTUS_MARK] === true)
    )

    if (preserved.length) settings.hooks!.PreToolUse = preserved
    else if (settings.hooks) delete settings.hooks.PreToolUse

    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks

    // If the file is now empty and we have a backup, restore it verbatim.
    if (Object.keys(settings).length === 0 && fs.existsSync(backup)) {
      fs.copyFileSync(backup, file)
      fs.unlinkSync(backup)
      return { ok: true, file }
    }

    if (Object.keys(settings).length === 0) {
      // We created the file; leave nothing behind.
      fs.unlinkSync(file)
      return { ok: true }
    }

    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8')
    if (fs.existsSync(backup)) fs.unlinkSync(backup)
    return { ok: true, file }
  } catch (err) {
    return { ok: false, error: String((err as { message?: string })?.message || err) }
  }
}

/** Is a Brutus hook currently installed in this folder? */
export function hookInstalled(cwd: string): boolean {
  try {
    const settings = readSettings(settingsPath(cwd))
    const entries = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks!.PreToolUse : []
    return entries.some((m) =>
      m.hooks?.some((h) => (h as Record<string, unknown>)[BRUTUS_MARK] === true)
    )
  } catch {
    return false
  }
}
