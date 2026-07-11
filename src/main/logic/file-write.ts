import { IpcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'

export default function registerFileWrite(ipcMain: IpcMain) {
  ipcMain.handle('write-file', async (_event, { fileName, content }) => {
    try {
      const isAbsolutePath = fileName.includes('/') || fileName.includes('\\')

      const targetPath = isAbsolutePath ? fileName : path.join(app.getPath('desktop'), fileName)


      await fs.writeFile(targetPath, content, 'utf-8')
      return `Success. File saved to: ${targetPath}`
    } catch (err) {
      return `Error writing file: ${err}`
    }
  })

  ipcMain.handle('append-file', async (_event, { fileName, content }) => {
    try {
      const isAbsolutePath = fileName.includes('/') || fileName.includes('\\')
      const targetPath = isAbsolutePath ? fileName : path.join(app.getPath('desktop'), fileName)

      // If the file exists and doesn't end in a newline, add one so the
      // appended content starts on its own line.
      let prefix = ''
      try {
        const existing = await fs.readFile(targetPath, 'utf-8')
        if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n'
      } catch {
        // file doesn't exist yet — appendFile will create it
      }

      await fs.appendFile(targetPath, prefix + content, 'utf-8')
      return `Success. Content appended to: ${targetPath}`
    } catch (err) {
      return `Error appending to file: ${err}`
    }
  })
}
