import { IpcMain, app } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'

/**
 * BRUTUS Wallpaper manager — set the desktop wallpaper from a local file or a
 * URL (downloaded first), via SystemParametersInfo (SPI_SETDESKWALLPAPER).
 * The PowerShell is run through -EncodedCommand to avoid all quoting issues.
 */
export default function registerWallpaper(ipcMain: IpcMain) {
  ipcMain.removeHandler('set-wallpaper')
  ipcMain.handle('set-wallpaper', async (_e, { source }) => {
    try {
      if (!source) return { success: false, error: 'No image source provided.' }
      let imgPath = String(source)

      if (/^https?:\/\//i.test(imgPath)) {
        const res = await fetch(imgPath)
        if (!res.ok) return { success: false, error: `Download failed (HTTP ${res.status}).` }
        const buf = Buffer.from(await res.arrayBuffer())
        let ext = '.jpg'
        try {
          const e = path.extname(new URL(imgPath).pathname)
          if (e && e.length <= 5) ext = e
        } catch {
          // keep default
        }
        const dest = path.join(app.getPath('pictures'), `brutus_wallpaper_${Date.now()}${ext}`)
        await fs.writeFile(dest, buf)
        imgPath = dest
      }

      imgPath = path.resolve(imgPath)
      if (!fsSync.existsSync(imgPath)) return { success: false, error: `Image not found at ${imgPath}.` }

      const script = `
$ErrorActionPreference = 'Stop'
$code = @'
using System.Runtime.InteropServices;
public class Wallpaper {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
'@
Add-Type -TypeDefinition $code
$path = '${imgPath.replace(/'/g, "''")}'
[Wallpaper]::SystemParametersInfo(20, 0, $path, 3) | Out-Null
Write-Output 'OK'
`
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const result = await new Promise<{ ok: boolean; out: string }>((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
          { windowsHide: true, timeout: 20000 },
          (err, stdout) => resolve({ ok: !err, out: (stdout || '').trim() })
        )
      })

      if (result.ok && result.out.includes('OK')) {
        return { success: true, path: imgPath }
      }
      return { success: false, error: 'Failed to apply wallpaper.' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
