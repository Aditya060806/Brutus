import { IpcMain } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import crypto from 'crypto'

/**
 * BRUTUS Folder Analysis tools
 * ----------------------------
 * - analyze-folder       : total size, file/dir counts, breakdown by type, biggest files
 * - find-empty-folders   : list (and optionally delete) empty directories
 * - find-duplicate-files : group byte-identical files (size pre-filter + md5)
 * - find-large-files     : largest files above a size threshold
 *
 * All walkers skip well-known heavy/system folders and cap traversal so a
 * voice command never freezes the main process indefinitely.
 */

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'appdata',
  'dist',
  'build',
  'out'
])

const MAX_ENTRIES = 200000 // hard cap on files visited per scan

const humanSize = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 2 : 1)} ${units[i]}`
}

interface FileInfo {
  path: string
  size: number
  ext: string
}

async function walkFiles(
  root: string,
  onFile: (info: FileInfo) => void,
  onDir?: (dirPath: string) => void
): Promise<number> {
  let count = 0
  const queue: string[] = [root]

  while (queue.length > 0) {
    if (count >= MAX_ENTRIES) break
    const dir = queue.shift()!
    if (onDir) onDir(dir)

    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const lower = entry.name.toLowerCase()

      if (entry.isDirectory()) {
        if (lower.startsWith('$') || IGNORE_DIRS.has(lower)) continue
        queue.push(full)
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full)
          onFile({ path: full, size: stat.size, ext: path.extname(entry.name).toLowerCase() || '(none)' })
          count++
          if (count >= MAX_ENTRIES) break
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  return count
}

const hashFile = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const stream = fsSync.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })

async function resolveDir(directory: string): Promise<{ ok: true; dir: string } | { ok: false; msg: string }> {
  const dir = path.resolve(directory)
  try {
    const stat = await fs.stat(dir)
    if (!stat.isDirectory()) return { ok: false, msg: `❌ Error: '${dir}' is not a directory.` }
    return { ok: true, dir }
  } catch {
    return { ok: false, msg: `❌ Error: Directory not found at '${dir}'.` }
  }
}

export default function registerFolderAnalyzer(ipcMain: IpcMain) {
  // ─── ANALYZE FOLDER ─────────────────────────────────────────────────
  ipcMain.removeHandler('analyze-folder')
  ipcMain.handle('analyze-folder', async (_event, { directory }) => {
    const r = await resolveDir(directory)
    if (!r.ok) return r.msg

    let totalSize = 0
    let fileCount = 0
    let dirCount = 0
    const byExt: Record<string, { count: number; size: number }> = {}
    const biggest: FileInfo[] = []

    await walkFiles(
      r.dir,
      (info) => {
        totalSize += info.size
        fileCount++
        const e = byExt[info.ext] || { count: 0, size: 0 }
        e.count++
        e.size += info.size
        byExt[info.ext] = e
        biggest.push(info)
        if (biggest.length > 2000) {
          biggest.sort((a, b) => b.size - a.size)
          biggest.length = 50
        }
      },
      () => {
        dirCount++
      }
    )

    biggest.sort((a, b) => b.size - a.size)
    const topExts = Object.entries(byExt)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 6)
      .map(([ext, v]) => `${ext}: ${v.count} files, ${humanSize(v.size)}`)

    const topFiles = biggest
      .slice(0, 5)
      .map((f) => `${path.basename(f.path)} (${humanSize(f.size)})`)

    return [
      `📊 Folder analysis for ${r.dir}`,
      `• Total size: ${humanSize(totalSize)}`,
      `• Files: ${fileCount.toLocaleString()} | Subfolders: ${Math.max(dirCount - 1, 0).toLocaleString()}`,
      `• By type: ${topExts.join(' | ') || 'n/a'}`,
      `• Largest: ${topFiles.join(', ') || 'n/a'}`
    ].join('\n')
  })

  // ─── FIND / DELETE EMPTY FOLDERS ────────────────────────────────────
  ipcMain.removeHandler('find-empty-folders')
  ipcMain.handle('find-empty-folders', async (_event, { directory, deleteEmpty }) => {
    const r = await resolveDir(directory)
    if (!r.ok) return r.msg

    const empties: string[] = []

    // depth-first so we can detect folders that become empty after children
    const isEmptyRecursive = async (dir: string): Promise<boolean> => {
      let entries: fsSync.Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return false
      }

      let hasContent = false
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        const lower = entry.name.toLowerCase()
        if (entry.isDirectory()) {
          if (lower.startsWith('$') || IGNORE_DIRS.has(lower)) {
            hasContent = true
            continue
          }
          const childEmpty = await isEmptyRecursive(full)
          if (!childEmpty) hasContent = true
        } else {
          hasContent = true
        }
      }

      if (!hasContent && dir !== r.dir) empties.push(dir)
      return !hasContent
    }

    await isEmptyRecursive(r.dir)

    if (empties.length === 0) return '✅ No empty folders found.'

    if (deleteEmpty) {
      let deleted = 0
      // delete deepest first
      empties.sort((a, b) => b.length - a.length)
      for (const e of empties) {
        try {
          await fs.rmdir(e)
          deleted++
        } catch {
          // may have become non-empty / locked — skip
        }
      }
      return `🗑️ Deleted ${deleted} empty folder(s) under ${r.dir}.`
    }

    return [
      `📂 Found ${empties.length} empty folder(s) under ${r.dir} (preview — nothing deleted):`,
      ...empties.slice(0, 25)
    ].join('\n')
  })

  // ─── FIND DUPLICATE FILES ───────────────────────────────────────────
  ipcMain.removeHandler('find-duplicate-files')
  ipcMain.handle('find-duplicate-files', async (_event, { directory }) => {
    const r = await resolveDir(directory)
    if (!r.ok) return r.msg

    const bySize = new Map<number, string[]>()
    await walkFiles(r.dir, (info) => {
      if (info.size === 0) return // ignore empty files
      const arr = bySize.get(info.size) || []
      arr.push(info.path)
      bySize.set(info.size, arr)
    })

    const duplicateGroups: { hash: string; size: number; files: string[] }[] = []
    let wastedBytes = 0

    for (const [size, files] of bySize) {
      if (files.length < 2) continue // unique size => unique content
      const byHash = new Map<string, string[]>()
      for (const f of files) {
        try {
          const h = await hashFile(f)
          const arr = byHash.get(h) || []
          arr.push(f)
          byHash.set(h, arr)
        } catch {
          // unreadable — skip
        }
      }
      for (const [hash, group] of byHash) {
        if (group.length > 1) {
          duplicateGroups.push({ hash, size, files: group })
          wastedBytes += size * (group.length - 1)
        }
      }
    }

    if (duplicateGroups.length === 0) return '✅ No duplicate files found.'

    duplicateGroups.sort((a, b) => b.size * b.files.length - a.size * a.files.length)
    const preview = duplicateGroups
      .slice(0, 10)
      .map(
        (g, i) =>
          `${i + 1}. ${g.files.length}× ${humanSize(g.size)} each:\n   ${g.files
            .slice(0, 4)
            .join('\n   ')}`
      )

    return [
      `🔁 Found ${duplicateGroups.length} duplicate group(s) under ${r.dir}.`,
      `💾 Reclaimable space: ${humanSize(wastedBytes)} (keeping one copy of each).`,
      ...preview
    ].join('\n')
  })

  // ─── FIND LARGE FILES ───────────────────────────────────────────────
  ipcMain.removeHandler('find-large-files')
  ipcMain.handle('find-large-files', async (_event, { directory, minMB, limit }) => {
    const r = await resolveDir(directory)
    if (!r.ok) return r.msg

    const threshold = (minMB ?? 100) * 1024 * 1024
    const cap = limit ?? 15
    const matches: FileInfo[] = []

    await walkFiles(r.dir, (info) => {
      if (info.size >= threshold) matches.push(info)
    })

    if (matches.length === 0) {
      return `✅ No files larger than ${humanSize(threshold)} found under ${r.dir}.`
    }

    matches.sort((a, b) => b.size - a.size)
    const list = matches
      .slice(0, cap)
      .map((f, i) => `${i + 1}. ${humanSize(f.size)} — ${f.path}`)

    return [
      `📦 ${matches.length} file(s) over ${humanSize(threshold)} under ${r.dir}. Top ${Math.min(
        cap,
        matches.length
      )}:`,
      ...list
    ].join('\n')
  })
}
