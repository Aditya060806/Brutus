import { execFile } from 'child_process'
import { app } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import os from 'os'

/**
 * Optional LibreOffice backend.
 * -----------------------------
 * If LibreOffice (`soffice`) is available, it converts office documents with
 * true pixel-perfect fidelity. Detection order:
 *   1. A user-configured path (persisted in settings, set via set-libreoffice-path)
 *   2. The BRUTUS_SOFFICE_PATH environment variable
 *   3. Standard install locations
 *   4. PATH lookup (`where` / `which`)
 *
 * On Windows we prefer `soffice.com` over `soffice.exe` because `.com` blocks
 * until the conversion finishes (`.exe` can return immediately), making
 * scripted conversion reliable.
 */

// undefined = not yet probed, null = probed & not found, string = resolved binary
let cachedPath: string | null | undefined = undefined
let customSofficePath: string | null = null

const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.com',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
]
const NIX_CANDIDATES = [
  '/usr/bin/soffice',
  '/usr/local/bin/soffice',
  '/opt/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice'
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Stable, persistent LibreOffice profile so first-run init happens only once
// ever (across reboots). Falls back to a temp dir if userData isn't available.
function getProfileDir(): string {
  try {
    return path.join(app.getPath('userData'), 'lo_profile')
  } catch {
    return path.join(os.tmpdir(), 'brutus_lo_profile')
  }
}

let warmedUp = false
/**
 * Initialize the LibreOffice profile in the background WITHOUT converting
 * (no PDF export = no printer involvement). This moves the slow one-time
 * first-run init off the user's first real conversion. Safe to call repeatedly.
 */
export async function warmUpLibreOffice(soffice: string): Promise<void> {
  if (warmedUp) return
  warmedUp = true
  try {
    const profileDir = getProfileDir()
    await fs.mkdir(profileDir, { recursive: true })
    const userInstall = 'file:///' + profileDir.replace(/\\/g, '/')
    await new Promise<void>((resolve) => {
      const child = execFile(
        soffice,
        [
          '--headless',
          '--norestore',
          '--nologo',
          '--nofirststartwizard',
          '--nolockcheck',
          '--terminate_after_init',
          `-env:UserInstallation=${userInstall}`
        ],
        { timeout: 120000, windowsHide: true },
        () => resolve()
      )
      try {
        child.stdin?.end()
      } catch {
        // ignore
      }
    })
  } catch {
    // best effort — conversion will still work (and self-initialize) without this
  }
}

/**
 * Last-resort shallow scan of every drive's top-level folders for a
 * LibreOffice install (catches portable / non-standard extractions like
 * "D:\New Folder\program\soffice.com"). Bounded and only run once.
 */
async function autoScanDrives(): Promise<string | null> {
  if (process.platform !== 'win32') return null

  const SKIP = new Set(['windows', 'node_modules', '$recycle.bin', 'system volume information'])
  for (let i = 67; i <= 90; i++) {
    // C: .. Z:
    const root = `${String.fromCharCode(i)}:\\`
    if (!fsSync.existsSync(root)) continue

    // Well-known portable layouts first
    const known = [
      path.join(root, 'LibreOffice', 'program', 'soffice.com'),
      path.join(root, 'LibreOfficePortable', 'App', 'libreoffice', 'program', 'soffice.com')
    ]
    const knownHit = known.find((k) => fsSync.existsSync(k))
    if (knownHit) return knownHit

    // Shallow scan of top-level directories (bounded)
    let dirs: string[] = []
    try {
      dirs = fsSync
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .slice(0, 400)
    } catch {
      continue
    }
    for (const name of dirs) {
      const lower = name.toLowerCase()
      if (lower.startsWith('$') || SKIP.has(lower)) continue
      const com = path.join(root, name, 'program', 'soffice.com')
      if (fsSync.existsSync(com)) return com
      const exe = path.join(root, name, 'program', 'soffice.exe')
      if (fsSync.existsSync(exe)) return resolveSofficeBinary(exe)
    }
  }
  return null
}

/**
 * Resolve an arbitrary user input (a file OR a folder OR an install root) to a
 * usable soffice binary, preferring soffice.com on Windows. Returns null if no
 * binary can be found.
 */
export function resolveSofficeBinary(input: string | null | undefined): string | null {
  if (!input) return null
  let p = input.trim().replace(/^"|"$/g, '')

  // If a directory / install root was given, descend to the binary.
  try {
    const stat = fsSync.statSync(p)
    if (stat.isDirectory()) {
      const descend = [
        path.join(p, 'soffice.com'),
        path.join(p, 'soffice.exe'),
        path.join(p, 'program', 'soffice.com'),
        path.join(p, 'program', 'soffice.exe'),
        path.join(p, 'Contents', 'MacOS', 'soffice'),
        path.join(p, 'MacOS', 'soffice'),
        path.join(p, 'soffice')
      ]
      const hit = descend.find((c) => fsSync.existsSync(c))
      if (!hit) return null
      p = hit
    }
  } catch {
    // not an existing path string — fall through to existence check
  }

  if (!fsSync.existsSync(p)) return null

  // Prefer the blocking .com front-end on Windows.
  if (process.platform === 'win32' && p.toLowerCase().endsWith('soffice.exe')) {
    const com = p.slice(0, -4) + '.com'
    if (fsSync.existsSync(com)) return com
  }
  return p
}

/**
 * Set (or clear) the user-configured LibreOffice path. Returns the resolved
 * binary path, or null if nothing usable was found there.
 */
export function setCustomSofficePath(input: string | null): string | null {
  customSofficePath = input || null
  cachedPath = undefined // force re-probe
  return resolveSofficeBinary(input)
}

/** Locate a usable soffice binary (cached). Returns null if not installed. */
export async function findSoffice(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath

  const ordered = [
    customSofficePath,
    process.env.BRUTUS_SOFFICE_PATH || null,
    ...(process.platform === 'win32' ? WINDOWS_CANDIDATES : NIX_CANDIDATES)
  ]

  for (const candidate of ordered) {
    const resolved = resolveSofficeBinary(candidate)
    if (resolved) {
      cachedPath = resolved
      return resolved
    }
  }

  // PATH lookup
  const fromPath = await new Promise<string | null>((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    execFile(cmd, ['soffice'], (err, stdout) => {
      if (err) return resolve(null)
      const first = (stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0]
      resolve(resolveSofficeBinary(first) || null)
    })
  })

  if (fromPath) {
    cachedPath = fromPath
    return fromPath
  }

  // Last resort: shallow scan of drive roots for a portable install.
  const scanned = await autoScanDrives()
  cachedPath = scanned
  return scanned
}

/**
 * Convert a document to `targetFormat` via LibreOffice, then move the result to
 * `finalTargetPath`. Returns true on success, false if nothing was produced
 * (caller should then fall back to the built-in engine).
 */
export async function convertWithLibreOffice(
  soffice: string,
  sourcePath: string,
  targetFormat: string,
  finalTargetPath: string
): Promise<boolean> {
  const outDir = path.join(
    os.tmpdir(),
    `brutus_lo_out_${Date.now()}_${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(outDir, { recursive: true })

  // Persistent profile (reused across conversions and reboots). A fresh profile
  // each run forces LibreOffice first-run init, which is slow and can trigger
  // printer-enumeration dialogs on Windows. Reusing one avoids that.
  const profileDir = getProfileDir()
  await fs.mkdir(profileDir, { recursive: true })
  const userInstall = 'file:///' + profileDir.replace(/\\/g, '/')

  const args = [
    '--headless',
    '--norestore',
    '--nologo',
    '--nofirststartwizard',
    '--nolockcheck',
    '--convert-to',
    targetFormat,
    '--outdir',
    outDir,
    `-env:UserInstallation=${userInstall}`,
    sourcePath
  ]

  await new Promise<void>((resolve) => {
    const child = execFile(soffice, args, { timeout: 120000, windowsHide: true }, () => resolve())
    try {
      child.stdin?.end()
    } catch {
      // ignore
    }
  })

  try {
    const base = path.basename(sourcePath, path.extname(sourcePath))
    const produced = path.join(outDir, `${base}.${targetFormat}`)

    // soffice.exe can return before the file is flushed — poll up to ~25s.
    for (let i = 0; i < 50; i++) {
      if (fsSync.existsSync(produced)) break
      await sleep(500)
    }

    if (fsSync.existsSync(produced)) {
      await fs.mkdir(path.dirname(finalTargetPath), { recursive: true })
      await fs.copyFile(produced, finalTargetPath)
      return true
    }
    return false
  } finally {
    fs.rm(outDir, { recursive: true, force: true }).catch(() => {})
  }
}
