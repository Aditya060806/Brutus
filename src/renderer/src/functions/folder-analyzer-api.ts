export const analyzeFolder = async (directory: string) => {
  try {
    return await window.electron.ipcRenderer.invoke('analyze-folder', { directory })
  } catch (err) {
    return `System Error: Analyzer offline. ${err}`
  }
}

export const findEmptyFolders = async (directory: string, deleteEmpty = false) => {
  try {
    return await window.electron.ipcRenderer.invoke('find-empty-folders', { directory, deleteEmpty })
  } catch (err) {
    return `System Error: Analyzer offline. ${err}`
  }
}

export const findDuplicateFiles = async (directory: string) => {
  try {
    return await window.electron.ipcRenderer.invoke('find-duplicate-files', { directory })
  } catch (err) {
    return `System Error: Analyzer offline. ${err}`
  }
}

export const findLargeFiles = async (directory: string, minMB?: number, limit?: number) => {
  try {
    return await window.electron.ipcRenderer.invoke('find-large-files', { directory, minMB, limit })
  } catch (err) {
    return `System Error: Analyzer offline. ${err}`
  }
}
