import { IpcMain } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'

/**
 * BRUTUS Focus Mode.
 * ------------------
 * Blocks distracting APPS (periodically force-closes the named processes) and
 * WEBSITES (a reversible, clearly-marked block in the Windows hosts file). The
 * hosts edit needs admin rights; if denied, app-blocking still works and the
 * result reports that websites couldn't be blocked. stop_focus fully restores.
 */

const HOSTS = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
const MARK_START = '# === BRUTUS FOCUS START ==='
const MARK_END = '# === BRUTUS FOCUS END ==='

const PROTECTED = new Set([
  'explorer.exe',
  'dwm.exe',
  'svchost.exe',
  'lsass.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'system'
])

let focusInterval: NodeJS.Timeout | null = null
let autoStop: NodeJS.Timeout | null = null
let blockedApps: string[] = []
let blockedSites: string[] = []
let active = false

function stripBlock(content: string): string {
  const s = content.indexOf(MARK_START)
  const e = content.indexOf(MARK_END)
  if (s !== -1 && e !== -1 && e > s) {
    const before = content.slice(0, s).replace(/\s+$/, '')
    const after = content.slice(e + MARK_END.length).replace(/^\r?\n/, '')
    return (before + (after ? '\r\n' + after : '\r\n')).replace(/\s+$/, '') + '\r\n'
  }
  return content
}

function applyHostsBlock(domains: string[]): { ok: boolean; error?: string } {
  try {
    let content = fs.existsSync(HOSTS) ? fs.readFileSync(HOSTS, 'utf-8') : ''
    content = stripBlock(content)
    if (domains.length) {
      const lines = [MARK_START]
      for (const raw of domains) {
        const d = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim().toLowerCase()
        if (!d) continue
        lines.push(`127.0.0.1 ${d}`)
        if (!d.startsWith('www.')) lines.push(`127.0.0.1 www.${d}`)
      }
      lines.push(MARK_END)
      content = content.replace(/\s+$/, '') + '\r\n' + lines.join('\r\n') + '\r\n'
    }
    fs.writeFileSync(HOSTS, content, 'utf-8')
    execFile('ipconfig', ['/flushdns'], () => {})
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.code === 'EPERM' || e?.code === 'EACCES' ? 'admin rights required' : String(e?.message || e) }
  }
}

function killBlockedApps() {
  for (const name of blockedApps) {
    if (PROTECTED.has(name.toLowerCase())) continue
    execFile('taskkill', ['/IM', name, '/F', '/T'], () => {})
  }
}

export default function registerFocusMode(ipcMain: IpcMain) {
  const stop = () => {
    if (focusInterval) clearInterval(focusInterval)
    if (autoStop) clearTimeout(autoStop)
    focusInterval = null
    autoStop = null
    const hosts = applyHostsBlock([]) // remove our block
    active = false
    blockedApps = []
    blockedSites = []
    return hosts
  }

  ipcMain.removeHandler('start-focus')
  ipcMain.handle('start-focus', async (_e, { apps, websites, durationMinutes }) => {
    blockedApps = (Array.isArray(apps) ? apps : [])
      .map((a) => String(a).trim())
      .filter(Boolean)
      .map((a) => (a.toLowerCase().endsWith('.exe') ? a : `${a}.exe`))
    blockedSites = (Array.isArray(websites) ? websites : []).map((w) => String(w).trim()).filter(Boolean)

    const hosts = blockedSites.length ? applyHostsBlock(blockedSites) : { ok: true }

    if (focusInterval) clearInterval(focusInterval)
    if (blockedApps.length) {
      killBlockedApps()
      focusInterval = setInterval(killBlockedApps, 3000)
    }

    if (autoStop) clearTimeout(autoStop)
    if (durationMinutes && Number(durationMinutes) > 0) {
      autoStop = setTimeout(() => stop(), Number(durationMinutes) * 60000)
    }

    active = true
    return {
      success: true,
      apps: blockedApps,
      sites: blockedSites,
      websitesBlocked: hosts.ok,
      hostsError: hosts.ok ? undefined : hosts.error,
      durationMinutes: durationMinutes || null
    }
  })

  ipcMain.removeHandler('stop-focus')
  ipcMain.handle('stop-focus', async () => {
    const wasActive = active
    const hosts = stop()
    return { success: true, wasActive, websitesRestored: hosts.ok }
  })

  ipcMain.removeHandler('focus-status')
  ipcMain.handle('focus-status', async () => ({
    active,
    apps: blockedApps,
    sites: blockedSites
  }))
}
