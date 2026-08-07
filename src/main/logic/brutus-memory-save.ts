import { IpcMain, App } from 'electron'
import { appendMessage, readHistory, clearHistory } from '../services/chat-history'
import { bridgeBus, BRIDGE_EVENTS } from '../services/bridge-bus'

/**
 * Chat history IPC. Backed by the shared `chat-history` store so the desktop
 * bridge reads/writes the exact same conversation log.
 *
 * The `add-message` handler additionally emits OUTBOUND_MESSAGE, which is how a
 * message produced on the desktop reaches every paired phone. The bridge, in
 * turn, uses PERSIST_MESSAGE to write phone/AI messages back here WITHOUT
 * re-broadcasting (loop-safe) — handled below.
 */
export default function registerIpcHandlers({ ipcMain }: { ipcMain: IpcMain; app: App }) {
  ipcMain.removeHandler('add-message')
  ipcMain.removeHandler('get-history')
  ipcMain.removeHandler('clear-history')

  ipcMain.handle('clear-history', async () => {
    return clearHistory()
  })

  ipcMain.handle('add-message', async (_event, msg) => {
    // Validate the incoming message shape before touching disk.
    if (!msg || typeof msg.role !== 'string' || !msg.role) return false
    const text =
      Array.isArray(msg.parts) && msg.parts[0] && typeof msg.parts[0].text === 'string'
        ? msg.parts[0].text
        : ''
    if (!text) return false

    const ok = appendMessage(msg.role, text)
    // A desktop-originated turn — let the bridge fan it out to phones.
    if (ok) bridgeBus.emit(BRIDGE_EVENTS.OUTBOUND_MESSAGE, { role: msg.role, text })
    return ok
  })

  ipcMain.handle('get-history', async () => {
    return readHistory()
      .filter((m) => typeof m.content === 'string')
      .map((m) => ({
        role: m.role === 'brutus' ? 'model' : m.role,
        parts: [{ text: m.content }]
      }))
  })

  // Bridge → history: persist a phone/AI message without emitting OUTBOUND
  // (prevents an echo loop back to the device that sent it).
  bridgeBus.on(BRIDGE_EVENTS.PERSIST_MESSAGE, ({ role, text }: { role: string; text: string }) => {
    appendMessage(role, text)
  })
}
