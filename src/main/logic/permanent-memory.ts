import fs from 'fs'
import path from 'path'
import { IpcMain, App } from 'electron'

export default function registerPermanentMemory({ ipcMain, app }: { ipcMain: IpcMain; app: App }) {
  const MEMORY_DIR = path.resolve(app.getPath('userData'), 'Memory')
  const FILE_PATH = path.join(MEMORY_DIR, 'saved-user-memory.json')

  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true })

  ipcMain.handle('save-core-memory', async (_event, fact: string) => {
    try {
      let memoryBank: { fact: string; timestamp: string }[] = []

      if (fs.existsSync(FILE_PATH)) {
        const data = fs.readFileSync(FILE_PATH, 'utf-8')
        memoryBank = data ? JSON.parse(data) : []
      }

      memoryBank.push({
        fact: fact,
        timestamp: new Date().toISOString()
      })

      fs.writeFileSync(FILE_PATH, JSON.stringify(memoryBank, null, 2))
      return true
    } catch (err) {
      return false
    }
  })

  ipcMain.handle('search-core-memory', async () => {
    try {
      if (fs.existsSync(FILE_PATH)) {
        const data = fs.readFileSync(FILE_PATH, 'utf-8')
        return data ? JSON.parse(data) : []
      }
      return []
    } catch (err) {
      return []
    }
  })

  ipcMain.handle('delete-core-memory', async (_event, query: string) => {
    try {
      if (!fs.existsSync(FILE_PATH)) return { success: false, removed: 0 }
      const data = fs.readFileSync(FILE_PATH, 'utf-8')
      const bank: { fact: string; timestamp: string }[] = data ? JSON.parse(data) : []
      const needle = String(query || '').toLowerCase().trim()
      if (!needle) return { success: false, removed: 0 }
      const kept = bank.filter((m) => !m.fact.toLowerCase().includes(needle))
      const removed = bank.length - kept.length
      fs.writeFileSync(FILE_PATH, JSON.stringify(kept, null, 2))
      return { success: true, removed }
    } catch (err) {
      return { success: false, removed: 0, error: String(err) }
    }
  })

  // ─── Commitments / promises ─────────────────────────────────────────
  const COMMITMENTS_PATH = path.join(MEMORY_DIR, 'commitments.json')

  ipcMain.handle('save-commitment', async (_event, { text, due }) => {
    try {
      let list: { text: string; due: string | null; createdAt: string; done: boolean }[] = []
      if (fs.existsSync(COMMITMENTS_PATH)) {
        const data = fs.readFileSync(COMMITMENTS_PATH, 'utf-8')
        list = data ? JSON.parse(data) : []
      }
      list.push({
        text: String(text || ''),
        due: due ? String(due) : null,
        createdAt: new Date().toISOString(),
        done: false
      })
      fs.writeFileSync(COMMITMENTS_PATH, JSON.stringify(list, null, 2))
      return true
    } catch (err) {
      return false
    }
  })

  ipcMain.handle('get-commitments', async () => {
    try {
      if (fs.existsSync(COMMITMENTS_PATH)) {
        const data = fs.readFileSync(COMMITMENTS_PATH, 'utf-8')
        return data ? JSON.parse(data) : []
      }
      return []
    } catch (err) {
      return []
    }
  })
}
