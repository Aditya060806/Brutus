import { IpcMain } from 'electron'
import { runChat, type ChatMessage } from './llm-provider'

/**
 * BRUTUS Text Chat
 * ----------------
 * A non-voice conversation path (used by the ChatPanel). It routes through the
 * shared LLM provider: the Snapdragon Brain Node is primary, Gemini is the
 * fallback. The renderer contract is unchanged — it still gets { success, text }.
 */
export default function registerTextChat({ ipcMain }: { ipcMain: IpcMain }) {
  ipcMain.handle(
    'text-chat',
    async (_event, { message, history, systemInstruction, geminiKey }) => {
      try {
        if (!message || String(message).trim() === '') {
          return { success: false, error: 'Empty message.' }
        }

        // Normalize the stored history (role/parts shape) into OpenAI-style turns.
        const messages: ChatMessage[] = []
        for (const h of Array.isArray(history) ? history : []) {
          const text =
            Array.isArray(h?.parts) && h.parts.length
              ? h.parts.map((p: any) => (p && typeof p.text === 'string' ? p.text : '')).join('')
              : String(h?.content || '')
          if (!text.trim()) continue
          messages.push({
            role: h?.role === 'model' || h?.role === 'assistant' ? 'assistant' : 'user',
            content: text
          })
        }
        messages.push({ role: 'user', content: String(message) })

        const result = await runChat({ messages, systemInstruction, geminiKey })

        if (result.error) {
          return { success: false, error: result.error }
        }
        return {
          success: true,
          text: result.text,
          backend: result.backend,
          emotion: result.emotion
        }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
  )
}
