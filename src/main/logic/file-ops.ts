import { IpcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'

export default function registerFileOps(ipcMain: IpcMain) {
  // Create a folder. Relative names land on the Desktop (matches write-file behaviour).
  ipcMain.handle('create-directory', async (_event, folderPath: string) => {
    try {
      if (!folderPath || typeof folderPath !== 'string') {
        return { success: false, error: 'A folder path is required.' }
      }
      const isAbsolutePath = folderPath.includes('/') || folderPath.includes('\\')
      const targetPath = isAbsolutePath
        ? path.normalize(folderPath)
        : path.join(app.getPath('desktop'), folderPath)

      await fs.mkdir(targetPath, { recursive: true })
      return { success: true, path: targetPath }
    } catch (err) {
      return { success: false, error: `${err}` }
    }
  })

  ipcMain.handle('file-ops', async (_event, { operation, sourcePath, destPath }) => {

    try {
      switch (operation) {
        case 'copy':
          if (!destPath) return 'Error: Destination path required for copy.'
          await fs.cp(sourcePath, destPath, { recursive: true })
          return `Success: Copied to ${destPath}`

        case 'move':
          if (!destPath) return 'Error: Destination path required for move.'
          await fs.rename(sourcePath, destPath)
          return `Success: Moved to ${destPath}`

        case 'delete':
          await fs.rm(sourcePath, { recursive: true, force: true })
          return `Success: Deleted ${sourcePath}`

        default:
          return `Error: Unknown operation '${operation}'`
      }
    } catch (err) {
      return `System Error: ${err}`
    }
  })
}
