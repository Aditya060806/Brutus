export const vscodeOp = async (params: Record<string, any>) => {
  try {
    return await window.electron.ipcRenderer.invoke('vscode-op', params)
  } catch (err) {
    return `System Error: VS Code engine offline. ${err}`
  }
}
