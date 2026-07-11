export const excelOp = async (params: Record<string, any>) => {
  try {
    return await window.electron.ipcRenderer.invoke('excel-op', params)
  } catch (err) {
    return `System Error: Excel engine offline. ${err}`
  }
}
