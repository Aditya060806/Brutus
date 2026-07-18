export const setLibreOfficePath = async (path: string) => {
  try {
    const r = await window.electron.ipcRenderer.invoke('set-libreoffice-path', path)
    if (r.success) {
      return `✅ LibreOffice configured at: ${r.path}. Office documents (DOCX, PPTX, etc.) will now convert with pixel-perfect fidelity.`
    }
    return `❌ ${r.error}`
  } catch (err) {
    return `System Error: ${err}`
  }
}

export const getLibreOfficeStatus = async () => {
  try {
    const r = await window.electron.ipcRenderer.invoke('get-libreoffice-status')
    if (r.available) return `✅ LibreOffice is available at: ${r.path}.`
    return '⚠️ LibreOffice is not detected. Conversions use the built-in engine. Set its path to enable pixel-perfect office conversion.'
  } catch (err) {
    return `System Error: ${err}`
  }
}
