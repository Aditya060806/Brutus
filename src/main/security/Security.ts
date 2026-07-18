import { ipcMain } from 'electron'
import Store from 'electron-store'
import bcrypt from 'bcryptjs'

const StoreClass = (Store as any).default || Store
const store = new StoreClass()

export default function registerSecurityVault() {
  ipcMain.handle('check-vault-status', () => {
    const hasPin = !!store.get('brutus_vault_hash')
    return { hasPin }
  })

  ipcMain.handle('get-personality', () => {
    return store.get('brutus_personality') as string | undefined
  })

  ipcMain.handle('set-personality', (_, text: string) => {
    store.set('brutus_personality', text)
    return true
  })

  ipcMain.handle('get-language', () => {
    return (store.get('brutus_language') as string | undefined) || ''
  })

  ipcMain.handle('set-language', (_, language: string) => {
    store.set('brutus_language', language)
    return true
  })

  ipcMain.handle('setup-vault-pin', async (_, pin: string) => {
    const salt = await bcrypt.genSalt(10)
    const hash = await bcrypt.hash(pin, salt)
    store.set('brutus_vault_hash', hash)
    return true
  })

  ipcMain.handle('verify-vault-pin', async (_, pin: string) => {
    const hash = store.get('brutus_vault_hash') as string
    if (!hash) return false
    return await bcrypt.compare(pin, hash)
  })
}
