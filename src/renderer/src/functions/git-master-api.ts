export const gitOp = async (params: Record<string, any>) => {
  try {
    return await window.electron.ipcRenderer.invoke('git-op', params)
  } catch (err) {
    return `System Error: Git engine offline. ${err}`
  }
}
