import { IpcMain, app, Notification, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'

/**
 * BRUTUS Reminders & Timers.
 * --------------------------
 * Persisted to userData/reminders.json and rescheduled on startup. When one
 * fires it shows a system Notification and emits 'reminder-fired' to the
 * renderer (so Brutus can speak it). setTimeout's ~24.8-day ceiling is handled
 * by re-chaining for long delays.
 */

const MAX_DELAY = 2147483647 // setTimeout max (~24.8 days)
const timers = new Map<string, NodeJS.Timeout>()

interface Reminder {
  id: string
  text: string
  fireAt: number // epoch ms
  type: 'reminder' | 'timer'
  createdAt: number
}

export default function registerReminders(ipcMain: IpcMain) {
  const FILE = path.join(app.getPath('userData'), 'reminders.json')

  const load = (): Reminder[] => {
    try {
      return JSON.parse(fs.readFileSync(FILE, 'utf-8'))
    } catch {
      return []
    }
  }
  const save = (list: Reminder[]) => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      fs.writeFileSync(FILE, JSON.stringify(list, null, 2))
    } catch {
      // ignore
    }
  }

  const fire = (rem: Reminder) => {
    timers.delete(rem.id)
    save(load().filter((r) => r.id !== rem.id))
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: rem.type === 'timer' ? '⏰ Timer' : '🔔 Reminder',
          body: rem.text
        }).show()
      }
    } catch {
      // ignore
    }
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('reminder-fired', { text: rem.text, type: rem.type })
    }
  }

  const schedule = (rem: Reminder) => {
    const existing = timers.get(rem.id)
    if (existing) clearTimeout(existing)
    const delay = rem.fireAt - Date.now()
    if (delay <= 0) {
      fire(rem)
      return
    }
    const ms = Math.min(delay, MAX_DELAY)
    const handle = setTimeout(() => {
      if (rem.fireAt - Date.now() > 1000) schedule(rem) // re-chain long delays
      else fire(rem)
    }, ms)
    timers.set(rem.id, handle)
  }

  // Reschedule survivors on startup (fire any already-due).
  for (const rem of load()) schedule(rem)

  const newId = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

  ipcMain.removeHandler('set-reminder')
  ipcMain.handle('set-reminder', async (_e, { text, delayMinutes, atISO }) => {
    if (!text || !String(text).trim()) return { success: false, error: 'No reminder text provided.' }
    let fireAt: number
    if (atISO) fireAt = new Date(atISO).getTime()
    else fireAt = Date.now() + (Number(delayMinutes) || 0) * 60000
    if (isNaN(fireAt) || fireAt <= Date.now()) {
      return { success: false, error: 'Please provide a valid future time or a positive delay.' }
    }
    const rem: Reminder = { id: newId('r'), text: String(text), fireAt, type: 'reminder', createdAt: Date.now() }
    const list = load()
    list.push(rem)
    save(list)
    schedule(rem)
    return { success: true, id: rem.id, fireAt: new Date(fireAt).toLocaleString() }
  })

  ipcMain.removeHandler('set-timer')
  ipcMain.handle('set-timer', async (_e, { label, seconds, minutes }) => {
    const total = (Number(minutes) || 0) * 60 + (Number(seconds) || 0)
    if (total <= 0) return { success: false, error: 'Provide a positive duration.' }
    const fireAt = Date.now() + total * 1000
    const rem: Reminder = {
      id: newId('t'),
      text: label ? String(label) : `Your ${total >= 60 ? `${Math.round(total / 60)} minute` : `${total} second`} timer is up!`,
      fireAt,
      type: 'timer',
      createdAt: Date.now()
    }
    const list = load()
    list.push(rem)
    save(list)
    schedule(rem)
    return { success: true, id: rem.id, seconds: total }
  })

  ipcMain.removeHandler('cancel-reminder')
  ipcMain.handle('cancel-reminder', async (_e, { id }) => {
    const t = timers.get(id)
    if (t) clearTimeout(t)
    timers.delete(id)
    const before = load()
    const after = before.filter((r) => r.id !== id)
    save(after)
    return { success: before.length !== after.length }
  })

  ipcMain.removeHandler('list-reminders')
  ipcMain.handle('list-reminders', async () => {
    return load()
      .sort((a, b) => a.fireAt - b.fireAt)
      .map((r) => ({
        id: r.id,
        text: r.text,
        type: r.type,
        fireAt: new Date(r.fireAt).toLocaleString(),
        remainingMs: Math.max(0, r.fireAt - Date.now())
      }))
  })

  ipcMain.removeHandler('clear-reminders')
  ipcMain.handle('clear-reminders', async () => {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    save([])
    return { success: true }
  })
}
