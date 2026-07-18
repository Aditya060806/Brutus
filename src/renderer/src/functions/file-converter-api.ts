export const convertFile = async (
  sourcePath: string,
  targetFormat: string,
  outputDir?: string
) => {
  try {
    return await window.electron.ipcRenderer.invoke('convert-file', {
      sourcePath,
      targetFormat,
      outputDir
    })
  } catch (err) {
    return `System Error: Conversion engine offline. ${err}`
  }
}
