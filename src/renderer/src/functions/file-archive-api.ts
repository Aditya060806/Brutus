export const zipItems = async (paths: string[], outputZipPath?: string) => {
  try {
    return await window.electron.ipcRenderer.invoke('zip-items', { paths, outputZipPath })
  } catch (err) {
    return `System Error: Archive engine offline. ${err}`
  }
}

export const unzipArchive = async (zipPath: string, destDir?: string) => {
  try {
    return await window.electron.ipcRenderer.invoke('unzip-archive', { zipPath, destDir })
  } catch (err) {
    return `System Error: Archive engine offline. ${err}`
  }
}

export const setFileHidden = async (targetPath: string, hidden: boolean) => {
  try {
    return await window.electron.ipcRenderer.invoke('set-file-hidden', { targetPath, hidden })
  } catch (err) {
    return `System Error: Attribute engine offline. ${err}`
  }
}

export const bulkRename = async (options: {
  directory: string
  find?: string
  replace?: string
  prefix?: string
  suffix?: string
  sequentialBase?: string
  extensionFilter?: string
}) => {
  try {
    return await window.electron.ipcRenderer.invoke('bulk-rename', options)
  } catch (err) {
    return `System Error: Rename engine offline. ${err}`
  }
}
