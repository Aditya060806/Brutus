/**
 * BRUTUS — shared chat history store
 * ----------------------------------
 * Single source of truth for the on-disk conversation log
 * (`<userData>/Chat/iris_memory.json`). Extracted so BOTH the `add-message`
 * IPC handler (memory-save) and the desktop bridge can read/append the exact
 * same history without duplicating file logic or fighting over the file.
 *
 * Behaviour is intentionally identical to the original memory-save handler:
 * newest-20 window, `{ role, content, timestamp }` records.
 */
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

export interface StoredMessage {
  role: string
  content: string
  timestamp: string
}

const MAX_MESSAGES = 20

function historyDir(): string {
  return path.resolve(app.getPath('userData'), 'Chat')
}

function historyFile(): string {
  return path.join(historyDir(), 'iris_memory.json')
}

/** Read the raw stored history (never throws; returns [] on any problem). */
export function readHistory(): StoredMessage[] {
  try {
    const file = historyFile()
    if (!fs.existsSync(file)) return []
    const data = fs.readFileSync(file, 'utf-8')
    const parsed = data ? JSON.parse(data) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m: any) => m && typeof m.content === 'string')
  } catch {
    return []
  }
}

/** Append one message, keeping only the newest MAX_MESSAGES. Returns success. */
export function appendMessage(role: string, text: string): boolean {
  try {
    if (!role || typeof role !== 'string') return false
    if (!text || typeof text !== 'string') return false

    const dir = historyDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    let history = readHistory()
    history.push({ role, content: text, timestamp: new Date().toISOString() })
    if (history.length > MAX_MESSAGES) history = history.slice(-MAX_MESSAGES)

    fs.writeFileSync(historyFile(), JSON.stringify(history, null, 2))
    return true
  } catch {
    return false
  }
}

/** Wipe the history file. Returns success. */
export function clearHistory(): boolean {
  try {
    const file = historyFile()
    if (fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify([], null, 2))
    return true
  } catch {
    return false
  }
}
