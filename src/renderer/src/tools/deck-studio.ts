const getGeminiKey = async (): Promise<string> => {
  try {
    const keys = await window.electron.ipcRenderer.invoke('secure-get-keys')
    return (keys?.geminiKey || localStorage.getItem('brutus_custom_api_key') || '').trim()
  } catch {
    return (localStorage.getItem('brutus_custom_api_key') || '').trim()
  }
}

export const createDeck = async (
  instructions: string,
  content?: string,
  slideCount?: number,
  fileName?: string
) => {
  try {
    const geminiKey = await getGeminiKey()
    if (!geminiKey) {
      return '⚠️ Missing Gemini API Key. Add it in the Command Center Vault to use Deck Studio.'
    }

    window.dispatchEvent(new CustomEvent('deck-start', { detail: { instructions } }))
    const forward = window.electron.ipcRenderer.on('deck-progress', (_e: any, p: any) =>
      window.dispatchEvent(new CustomEvent('deck-progress', { detail: p }))
    )

    const tavilyKey = localStorage.getItem('brutus_tailvy_api_key') || ''
    const needsResearch = !content || content.trim().length < 800

    const r = await window.electron.ipcRenderer.invoke('deck-generate', {
      instructions,
      content,
      geminiKey,
      tavilyKey,
      research: needsResearch,
      qaLoop: true,
      quality: 'max',
      slideCount,
      fileName,
      fetchImages: true,
      renderPdf: true
    })

    if (typeof forward === 'function') forward()
    window.dispatchEvent(new CustomEvent('deck-done', { detail: r }))

    if (r.success) {
      // open the finished deck for the user
      window.electron.ipcRenderer.invoke('file:open', r.path).catch(() => {})
      const qa =
        r.qaSlidesFlagged > 0
          ? `\n🔎 QA flagged ${r.qaSlidesFlagged} slide(s) for a final manual glance.`
          : '\n🔎 Visual QA passed clean.'
      return `✅ Deck Studio created "${r.title}" — ${r.slideCount} slides. Saved to: ${r.path}${
        r.pdfPath ? `\nPDF preview: ${r.pdfPath}` : ''
      }${qa}`
    }
    return `❌ Deck generation failed: ${r.error}`
  } catch (err) {
    return `❌ System error in Deck Studio: ${String(err)}`
  }
}
