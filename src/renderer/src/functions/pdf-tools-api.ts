export const readPdf = async (targetPath: string) => {
  try {
    return await window.electron.ipcRenderer.invoke('read-pdf', { targetPath })
  } catch (err) {
    return `System Error: PDF engine offline. ${err}`
  }
}

export const createPdf = async (
  fileName: string,
  title: string,
  content: string,
  outputDir?: string
) => {
  try {
    return await window.electron.ipcRenderer.invoke('create-pdf', {
      fileName,
      title,
      content,
      outputDir
    })
  } catch (err) {
    return `System Error: PDF engine offline. ${err}`
  }
}
