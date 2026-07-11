export const setLanguage = async (language: string) => {
  try {
    await window.electron.ipcRenderer.invoke('set-language', language)
    return `✅ Preferred language set to "${language}". It applies the next time you start a voice session.`
  } catch (err) {
    return `❌ Failed to set language: ${err}`
  }
}

export const getLanguage = async (): Promise<string> => {
  try {
    return (await window.electron.ipcRenderer.invoke('get-language')) || ''
  } catch {
    return ''
  }
}
