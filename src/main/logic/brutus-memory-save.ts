import fs from 'fs'
import path from 'path'
import { IpcMain, App } from 'electron'

export default function registerIpcHandlers({ ipcMain, app }: { ipcMain: IpcMain; app: App }) {
  const CHAT_DIR = path.resolve(app.getPath('userData'), 'Chat')
  const FILE_PATH = path.join(CHAT_DIR, 'iris_memory.json')

  ipcMain.removeHandler('add-message')
  ipcMain.removeHandler('get-history')
  ipcMain.removeHandler('clear-history')

  ipcMain.handle('clear-history', async () => {
    try {
      if (fs.existsSync(FILE_PATH)) {
        fs.writeFileSync(FILE_PATH, JSON.stringify([], null, 2))
      }
      return true
    } catch (err) {
      return false
    }
  })

  ipcMain.handle('add-message', async (_event, msg) => {
    try {
      // Validate the incoming message shape before touching disk.
      if (!msg || typeof msg.role !== 'string' || !msg.role) return false
      const text =
        Array.isArray(msg.parts) && msg.parts[0] && typeof msg.parts[0].text === 'string'
          ? msg.parts[0].text
          : ''
      if (!text) return false

      if (!fs.existsSync(CHAT_DIR)) fs.mkdirSync(CHAT_DIR, { recursive: true })

      let history: { role: string; content: string; timestamp: string }[] = []
      if (fs.existsSync(FILE_PATH)) {
        try {
          const data = fs.readFileSync(FILE_PATH, 'utf-8')
          const parsed = data ? JSON.parse(data) : []
          history = Array.isArray(parsed) ? parsed : []
        } catch {
          // Corrupt history file — start fresh instead of losing all future writes.
          history = []
        }
      }

      history.push({
        role: msg.role,
        content: text,
        timestamp: new Date().toISOString()
      })

      if (history.length > 20) history = history.slice(-20)

      fs.writeFileSync(FILE_PATH, JSON.stringify(history, null, 2))
      return true
    } catch (err) {
      return false
    }
  })

  ipcMain.handle('get-history', async () => {
    try {
      if (fs.existsSync(FILE_PATH)) {
        const data = fs.readFileSync(FILE_PATH, 'utf-8')
        const raw = data ? JSON.parse(data) : []
        if (!Array.isArray(raw)) return []
        return raw
          .filter((m: any) => m && typeof m.content === 'string')
          .map((m: any) => ({
            role: m.role === 'brutus' ? 'model' : m.role,
            parts: [{ text: m.content }]
          }))
      }
    } catch (err) {}
    return []
  })
}
