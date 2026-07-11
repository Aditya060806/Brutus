import { IpcMain } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

/**
 * BRUTUS Archive & File-Attribute tools
 * -------------------------------------
 * - zip-items     : compress files/folders into a .zip
 * - unzip-archive : extract a .zip
 * - set-file-hidden : toggle the Windows hidden attribute
 * - bulk-rename   : find/replace, prefix/suffix, or sequential renaming
 *
 * Zip/unzip use the built-in Windows PowerShell cmdlets (Compress-Archive /
 * Expand-Archive) so no extra npm dependency is needed. All paths are
 * passed through single-quote escaping to prevent PowerShell injection.
 */

// Escape a path for safe embedding inside a PowerShell single-quoted string.
const psQuote = (p: string): string => `'${String(p).replace(/'/g, "''")}'`

const runPowerShell = (script: string): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { maxBuffer: 1024 * 1024 * 20 },
      (error, stdout, stderr) => {
        if (error) resolve({ ok: false, out: stderr || error.message })
        else resolve({ ok: true, out: (stdout || '').trim() })
      }
    )
  })

export default function registerFileArchive(ipcMain: IpcMain) {
  // ─── ZIP ────────────────────────────────────────────────────────────
  ipcMain.removeHandler('zip-items')
  ipcMain.handle('zip-items', async (_event, { paths, outputZipPath }) => {
    try {
      const items: string[] = Array.isArray(paths) ? paths : [paths]
      if (items.length === 0) return '❌ Error: No paths provided to zip.'

      for (const p of items) {
        try {
          await fs.access(path.resolve(p))
        } catch {
          return `❌ Error: Path not found: ${p}`
        }
      }

      let dest = outputZipPath
        ? path.resolve(outputZipPath)
        : path.join(path.dirname(path.resolve(items[0])), `archive_${Date.now()}.zip`)
      if (!dest.toLowerCase().endsWith('.zip')) dest += '.zip'

      await fs.mkdir(path.dirname(dest), { recursive: true })

      const pathList = items.map((p) => psQuote(path.resolve(p))).join(',')
      const script = `Compress-Archive -Path ${pathList} -DestinationPath ${psQuote(dest)} -Force`
      const res = await runPowerShell(script)

      if (!res.ok) return `❌ Zip failed: ${res.out}`
      return `✅ Zipped ${items.length} item(s) → ${dest}`
    } catch (err) {
      return `❌ Zip error: ${String(err)}`
    }
  })

  // ─── UNZIP ──────────────────────────────────────────────────────────
  ipcMain.removeHandler('unzip-archive')
  ipcMain.handle('unzip-archive', async (_event, { zipPath, destDir }) => {
    try {
      const resolvedZip = path.resolve(zipPath)
      try {
        await fs.access(resolvedZip)
      } catch {
        return `❌ Error: Archive not found at '${resolvedZip}'.`
      }

      const dest = destDir
        ? path.resolve(destDir)
        : path.join(
            path.dirname(resolvedZip),
            path.basename(resolvedZip, path.extname(resolvedZip))
          )

      await fs.mkdir(dest, { recursive: true })

      const script = `Expand-Archive -Path ${psQuote(resolvedZip)} -DestinationPath ${psQuote(
        dest
      )} -Force`
      const res = await runPowerShell(script)

      if (!res.ok) return `❌ Unzip failed: ${res.out}`
      return `✅ Extracted "${path.basename(resolvedZip)}" → ${dest}`
    } catch (err) {
      return `❌ Unzip error: ${String(err)}`
    }
  })

  // ─── HIDE / UNHIDE ──────────────────────────────────────────────────
  ipcMain.removeHandler('set-file-hidden')
  ipcMain.handle('set-file-hidden', async (_event, { targetPath, hidden }) => {
    try {
      const resolved = path.resolve(targetPath)
      try {
        await fs.access(resolved)
      } catch {
        return `❌ Error: Path not found at '${resolved}'.`
      }

      if (os.platform() !== 'win32') {
        return '❌ Hide/unhide via attribute is only supported on Windows.'
      }

      const flag = hidden ? '+h' : '-h'
      const result = await new Promise<{ ok: boolean; msg: string }>((resolve) => {
        execFile('attrib', [flag, resolved], (error, _stdout, stderr) => {
          if (error) resolve({ ok: false, msg: stderr || error.message })
          else resolve({ ok: true, msg: '' })
        })
      })

      if (!result.ok) return `❌ Failed to ${hidden ? 'hide' : 'unhide'}: ${result.msg}`
      return `✅ ${hidden ? 'Hid' : 'Unhid'} "${path.basename(resolved)}".`
    } catch (err) {
      return `❌ Attribute error: ${String(err)}`
    }
  })

  // ─── BULK RENAME ────────────────────────────────────────────────────
  ipcMain.removeHandler('bulk-rename')
  ipcMain.handle(
    'bulk-rename',
    async (_event, { directory, find, replace, prefix, suffix, sequentialBase, extensionFilter }) => {
      try {
        const dir = path.resolve(directory)
        try {
          const stat = await fs.stat(dir)
          if (!stat.isDirectory()) return `❌ Error: '${dir}' is not a directory.`
        } catch {
          return `❌ Error: Directory not found at '${dir}'.`
        }

        const dirents = await fs.readdir(dir, { withFileTypes: true })
        let files = dirents.filter((d) => d.isFile()).map((d) => d.name)

        if (extensionFilter) {
          const filt = extensionFilter.startsWith('.')
            ? extensionFilter.toLowerCase()
            : `.${extensionFilter.toLowerCase()}`
          files = files.filter((f) => path.extname(f).toLowerCase() === filt)
        }

        if (files.length === 0) return '⚠️ No matching files found to rename.'

        const renamed: string[] = []
        const skipped: string[] = []
        let seq = 1

        for (const original of files) {
          const ext = path.extname(original)
          const stem = path.basename(original, ext)

          let newStem = stem
          if (find !== undefined && find !== null && find !== '') {
            newStem = newStem.split(find).join(replace ?? '')
          }
          if (sequentialBase) {
            newStem = `${sequentialBase}_${String(seq).padStart(3, '0')}`
            seq++
          }
          if (prefix) newStem = `${prefix}${newStem}`
          if (suffix) newStem = `${newStem}${suffix}`

          const newName = `${newStem}${ext}`
          if (newName === original) {
            skipped.push(original)
            continue
          }

          const from = path.join(dir, original)
          const to = path.join(dir, newName)

          // collision guard — never overwrite an existing file
          try {
            await fs.access(to)
            skipped.push(`${original} (target "${newName}" exists)`)
            continue
          } catch {
            // target free
          }

          await fs.rename(from, to)
          renamed.push(`${original} → ${newName}`)
        }

        let msg = `✅ Renamed ${renamed.length} file(s) in ${dir}.`
        if (renamed.length) msg += `\n${renamed.slice(0, 20).join('\n')}`
        if (skipped.length) msg += `\n⚠️ Skipped ${skipped.length}: ${skipped.slice(0, 10).join('; ')}`
        return msg
      } catch (err) {
        return `❌ Bulk rename error: ${String(err)}`
      }
    }
  )
}
