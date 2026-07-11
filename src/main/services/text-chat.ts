import { IpcMain } from 'electron'
import { GoogleGenAI } from '@google/genai'

/**
 * BRUTUS Text Chat
 * ----------------
 * A non-voice conversation path. The renderer's voice engine uses the
 * Gemini Live (audio) API; this gives a parallel TEXT-in / TEXT-out channel
 * using the standard generateContent endpoint, reusing the same personality,
 * language preference, and conversation history.
 */
export default function registerTextChat({ ipcMain }: { ipcMain: IpcMain }) {
  ipcMain.handle('text-chat', async (_event, { message, history, systemInstruction, geminiKey }) => {
    try {
      if (!geminiKey || String(geminiKey).trim() === '') {
        return { success: false, error: 'Missing Gemini API Key. Configure it in the Command Center Vault.' }
      }
      if (!message || String(message).trim() === '') {
        return { success: false, error: 'Empty message.' }
      }

      const ai = new GoogleGenAI({ apiKey: geminiKey })

      const contents = [
        ...(Array.isArray(history) ? history : []).map((h: any) => ({
          role: h.role === 'model' ? 'model' : 'user',
          parts: h.parts || [{ text: String(h.content || '') }]
        })),
        { role: 'user', parts: [{ text: String(message) }] }
      ]

      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents,
        config: systemInstruction ? { systemInstruction } : undefined
      })

      return { success: true, text: res.text || '' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
