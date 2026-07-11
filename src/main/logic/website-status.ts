import { IpcMain } from 'electron'

/**
 * BRUTUS Website Status Check
 * ---------------------------
 * Checks whether a website / project URL (including localhost) is online,
 * returning the HTTP status and round-trip latency. Tries a lightweight
 * HEAD request first, falling back to GET if the server rejects HEAD.
 */
export default function registerWebsiteStatus(ipcMain: IpcMain) {
  ipcMain.removeHandler('check-website-status')
  ipcMain.handle('check-website-status', async (_event, { url }) => {
    if (!url) return { success: false, error: 'No URL provided.' }

    let target = String(url).trim()
    if (!/^https?:\/\//i.test(target)) target = `http://${target}`

    const probe = async (method: 'HEAD' | 'GET') => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const start = Date.now()
      try {
        const res = await fetch(target, {
          method,
          redirect: 'follow',
          signal: controller.signal
        })
        clearTimeout(timer)
        return { ok: true, status: res.status, ms: Date.now() - start }
      } catch (e: any) {
        clearTimeout(timer)
        return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) }
      }
    }

    let result = await probe('HEAD')
    // Some servers (or 405) don't support HEAD — retry with GET
    if (!result.ok || (result.status && result.status >= 400)) {
      const getRes = await probe('GET')
      if (getRes.ok) result = getRes
    }

    if (result.ok) {
      const online = result.status! < 500
      return {
        success: true,
        online,
        status: result.status,
        latencyMs: result.ms,
        url: target
      }
    }
    return { success: true, online: false, error: result.error, url: target }
  })
}
