import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  globalShortcut,
  screen,
  session,
  safeStorage,
  systemPreferences
} from 'electron'
import path, { join } from 'path'
import fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

import registerIpcHandlers from './logic/brutus-memory-save'
import registerSystemHandlers from './logic/get-system-info'
import registerFileSearch from './logic/file-search'
import registerFileOps from './logic/file-ops'
import registerFileWrite from './logic/file-write'
import registerFileRead from './logic/file-read'
import registerFileOpen from './logic/file-open'
import registerDirLoader from './logic/dir-load'
import registerFileScanner from './logic/file-launcher'
import registerAppLauncher from './logic/app-launcher'
import registerNotesHandlers from './logic/notes-manager'
import registerWebAgent from './logic/web-agent'
import registerGhostControl from './logic/ghost-control'
import registerterminalControl from './logic/terminal-control'
import registerGalleryHandlers from './logic/gallery-manager'
import registerGmailHandlers from './logic/gmail-manager'
import registerDesk from './services/coo'
import registerLocationHandlers from './logic/live-location'
import registerAdbHandlers from './logic/adb-manager'
import registerRealityHacker from './logic/reality-hacker'
import registerBrutusCoder from './services/brutus-coder'
import registerTelekinesis from './logic/telekinesis'
import registerPermanentMemory from './logic/permanent-memory'
import registerWormhole from './services/wormhole'
import registerOracle from './services/RAG-oracle'
import registerDeepResearch from './services/deep-research'
import registerWidgetMaker from './auto/widget-manager'
import registerWebsiteBuilder from './auto/website-builder'
import registerWorkflowManager from './workflow/workflow-manager'
import registerDropZoneControl from './handlers/SmartDropZone-Handler'
import registerScreenPeeler from './handlers/ScreenPeeler-handler'
import registerPhantomKeyboard from './handlers/PhantomControl-handler'
import registerSecurityVault from './security/Security'
import registerLockSystem from './security/lock-system'
import registerFileConverter from './logic/file-converter'
import registerFileArchive from './logic/file-archive'
import registerFolderAnalyzer from './logic/folder-analyzer'
import registerPdfTools from './logic/pdf-tools'
import registerMediaControls from './logic/media-controls'
import registerTextChat from './services/text-chat'
import registerLlmProvider from './services/llm-provider'
import registerDesktopBridge from './services/desktop-bridge'
import registerRobotV2 from './services/robot-v2'
import registerRobotAudio from './services/robot-audio'
import registerOrchestrator, { installCapabilityCapture } from './services/orchestrator'
import registerStudio from './services/studio'
import registerArchitect from './services/architect'
import registerExcelMaster from './logic/excel-master'
import registerWebsiteStatus from './logic/website-status'
import registerVscodeMaster from './logic/vscode-master'
import registerGitMaster from './logic/git-master'
import registerReminders from './logic/reminders'
import registerFocusMode from './logic/focus-mode'
import registerWallpaper from './logic/wallpaper'
import registerPresentation from './services/presentation'
import registerImageSearch from './logic/image-search'
import registerDeckStudio from './services/deck-studio'
import registerKnowledgeGraph from './services/knowledge-graph'
import { autoUpdater } from 'electron-updater'

app.commandLine.appendSwitch('use-fake-ui-for-media-stream')

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('brutus', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('brutus')
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

const OAUTH_PROTOCOL_PREFIX = 'brutus://'

let mainWindow: BrowserWindow | null = null
let isOverlayMode = false
// Pending Web Bluetooth chooser callback for the robot's HM-10 module (see the
// select-bluetooth-device hook in createWindow + the robot-ble-select handler).
let bleSelectCallback: ((deviceId: string) => void) | null = null
// Stores callback URLs that can arrive before renderer listeners are mounted.
let pendingOAuthCallbackUrl: string | null = null

const secureConfigPath = join(app.getPath('userData'), 'iris_secure_vault.json')

function bufferAndForwardOAuthCallback(url: string): void {
  if (!url.startsWith(OAUTH_PROTOCOL_PREFIX)) {
    console.warn('[OAuth] Ignoring callback URL with invalid protocol:', url)
    return
  }

  pendingOAuthCallbackUrl = url

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('oauth-callback', url)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    fullscreen: true,
    autoHideMenuBar: true,
    frame: false,
    transparent: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      webSecurity: false
    }
  })

  // Electron renders no picker for Web Bluetooth. While the Robot view has a
  // navigator.bluetooth.requestDevice() call pending, Chromium re-fires this
  // event as scan results accumulate; we stream the list to the renderer's own
  // picker UI and resolve the request via the 'robot-ble-select' IPC call
  // (deviceId to choose, '' to cancel).
  mainWindow.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault()
    bleSelectCallback = callback
    mainWindow?.webContents.send(
      'robot-ble-devices',
      deviceList.map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName || 'Unknown' }))
    )
  })

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) return

    mainWindow.show()

    // Replay startup callback if it arrived before the renderer was ready.
    if (pendingOAuthCallbackUrl) {
      mainWindow.webContents.send('oauth-callback', pendingOAuthCallbackUrl)
    }
  })

  ipcMain.on('window-min', () => mainWindow?.minimize())
  ipcMain.on('window-close', () => mainWindow?.close())
  ipcMain.on('window-max', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('second-instance', (event, commandLine) => {
  if (!event) {
  }

  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }

  const url = commandLine.find((arg) => arg.startsWith(OAUTH_PROTOCOL_PREFIX))
  if (!url) {
    console.warn('[OAuth] No callback URL found in second-instance arguments.')
    return
  }

  bufferAndForwardOAuthCallback(url)
})

function toggleOverlayMode() {
  if (!mainWindow) return

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  if (isOverlayMode) {
    mainWindow.setResizable(true)
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setBounds({ width: 950, height: 670 })
    mainWindow.center()
    mainWindow.webContents.send('overlay-mode', false)
  } else {
    const w = 320
    const h = 52
    mainWindow.setBounds({
      width: w,
      height: h,
      x: Math.floor(width / 2 - w / 2),
      y: height - h - 40
    })
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    mainWindow.setResizable(false)
    mainWindow.webContents.send('overlay-mode', true)
  }
  isOverlayMode = !isOverlayMode
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  // Auto-updater — manual check only, no popup on launch
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  const sendUpdaterEvent = (payload: object) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', payload)
    }
  }

  autoUpdater.on('checking-for-update', () => {
    sendUpdaterEvent({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    sendUpdaterEvent({ status: 'available', version: info.version, notes: info.releaseNotes || '' })
  })

  autoUpdater.on('update-not-available', () => {
    sendUpdaterEvent({ status: 'idle' })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendUpdaterEvent({ status: 'downloading', progress: Math.floor(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdaterEvent({ status: 'ready', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    // Silently report to renderer — no disruptive dialog on startup
    console.error('[AutoUpdater] Error:', err.message)
    sendUpdaterEvent({ status: 'error' })
  })

  ipcMain.handle('check-for-updates', async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      sendUpdaterEvent({ status: 'error' })
    }
  })

  ipcMain.handle('download-update', async () => {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      sendUpdaterEvent({ status: 'error' })
    }
  })

  ipcMain.handle('install-update', () => {
    setImmediate(() => {
      app.removeAllListeners('window-all-closed')
      autoUpdater.quitAndInstall(false, true)
    })
  })

  ipcMain.handle('secure-save-keys', async (_, { groqKey, geminiKey }) => {
    try {
      let groqEncrypted, geminiEncrypted

      if (safeStorage.isEncryptionAvailable()) {
        groqEncrypted = safeStorage.encryptString(groqKey).toString('base64')
        geminiEncrypted = safeStorage.encryptString(geminiKey).toString('base64')
      } else {
        groqEncrypted = Buffer.from(groqKey).toString('base64')
        geminiEncrypted = Buffer.from(geminiKey).toString('base64')
      }

      const secureData = {
        groq: groqEncrypted,
        gemini: geminiEncrypted
      }

      fs.writeFileSync(secureConfigPath, JSON.stringify(secureData))
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('get-app-version', () => {
    return app.getVersion()
  })

  ipcMain.handle('secure-get-keys', async () => {
    if (!fs.existsSync(secureConfigPath)) return null
    try {
      const data = JSON.parse(fs.readFileSync(secureConfigPath, 'utf8'))
      let groqKey, geminiKey

      if (safeStorage.isEncryptionAvailable()) {
        groqKey = safeStorage.decryptString(Buffer.from(data.groq, 'base64'))
        geminiKey = safeStorage.decryptString(Buffer.from(data.gemini, 'base64'))
      } else {
        groqKey = Buffer.from(data.groq, 'base64').toString('utf8')
        geminiKey = Buffer.from(data.gemini, 'base64').toString('utf8')
      }

      return { groqKey, geminiKey }
    } catch (err) {
      return null
    }
  })

  ipcMain.handle('check-keys-exist', () => {
    return fs.existsSync(secureConfigPath)
  })

  ipcMain.handle('oauth-consume-pending-callback', () => {
    const callbackUrl = pendingOAuthCallbackUrl
    pendingOAuthCallbackUrl = null
    return callbackUrl
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = [
      'media',
      'audioCapture',
      'videoCapture',
      'desktopVideoCapture',
      'microphone',
      'camera'
    ]
    if (allowedPermissions.includes(permission)) {
      callback(true)
    } else {
      callback(false)
    }
  })

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowedPermissions = [
      'media',
      'audioCapture',
      'videoCapture',
      'desktopVideoCapture',
      'microphone',
      'camera'
    ]
    return allowedPermissions.includes(permission)
  })

  if (process.platform === 'darwin') {
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      systemPreferences.askForMediaAccess('microphone')
    }
    if (systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
      systemPreferences.askForMediaAccess('camera')
    }
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // The renderer makes cross-origin API/data calls (weather, stock, HF, Tavily,
    // map tiles, Gemini WSS…) that need CSP/CORS relaxed. Scope that relaxation to
    // data/subresource requests only — NOT top-level or nested document loads —
    // so a page navigated in-app can't have its CSP stripped. Data fetches and the
    // WebSocket upgrade are unaffected, so no feature or voice-path behaviour changes.
    const type = details.resourceType
    const isDocument = type === 'mainFrame' || type === 'subFrame'

    if (isDocument) {
      /**
       * One exception, scoped as tightly as it can be: a LOOPBACK sub-frame.
       *
       * BRUTUS Studio shows a dev server an agent just started in a preview
       * window on the canvas, and a framework that sets `X-Frame-Options: DENY`
       * (Next.js with its defaults, anything using helmet) would render that
       * window permanently blank with no explanation.
       *
       * Narrow on purpose. It is a sub-frame, never a top-level navigation, so
       * the rule above still holds for anything the user actually browses to;
       * and it is loopback only, so the content is a server already running on
       * this machine under the user's own account. A remote page keeps every
       * header it sent, exactly as before.
       */
      const loopbackFrame =
        type === 'subFrame' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(details.url)

      if (loopbackFrame) {
        const framed = { ...details.responseHeaders }
        delete framed['x-frame-options']
        delete framed['content-security-policy']
        callback({ responseHeaders: framed, statusLine: details.statusLine })
        return
      }

      callback({ responseHeaders: details.responseHeaders, statusLine: details.statusLine })
      return
    }

    const responseHeaders = { ...details.responseHeaders }
    delete responseHeaders['content-security-policy']
    delete responseHeaders['x-content-security-policy']
    delete responseHeaders['access-control-allow-origin']

    callback({
      responseHeaders,
      statusLine: details.statusLine
    })
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    bufferAndForwardOAuthCallback(url)
  })

  // Every service below registers through `agentIpc` instead of the raw
  // `ipcMain`. It is a transparent proxy: `.handle()` still reaches Electron
  // untouched, but channels named in the orchestrator's capability manifest are
  // ALSO recorded so agents can call them. This is why no service module needed
  // editing to gain multi-agent support.
  const agentIpc = installCapabilityCapture(ipcMain)

  registerLockSystem()
  registerSecurityVault()
  registerFileConverter(agentIpc)
  registerFileArchive(agentIpc)
  registerFolderAnalyzer(agentIpc)
  registerPdfTools(agentIpc)
  registerMediaControls(agentIpc)
  registerLlmProvider({ ipcMain: agentIpc })
  registerDesktopBridge({ ipcMain: agentIpc, getWindow: () => mainWindow })
  registerRobotV2({ ipcMain: agentIpc, getWindow: () => mainWindow })
  registerRobotAudio({ ipcMain: agentIpc, getWindow: () => mainWindow })
  // Registered last so every capability above is already in the bus.
  registerOrchestrator({ ipcMain, getWindow: () => mainWindow })
  registerStudio({ ipcMain, getWindow: () => mainWindow })
  // Resolves the pending Web Bluetooth chooser started in createWindow.
  agentIpc.handle('robot-ble-select', (_e, deviceId: string) => {
    if (!bleSelectCallback) return { ok: false }
    try {
      bleSelectCallback(typeof deviceId === 'string' ? deviceId : '')
    } finally {
      bleSelectCallback = null
    }
    return { ok: true }
  })
  registerTextChat({ ipcMain: agentIpc })
  registerArchitect({ ipcMain: agentIpc })
  registerExcelMaster(agentIpc)
  registerWebsiteStatus(agentIpc)
  registerVscodeMaster(agentIpc)
  registerGitMaster(agentIpc)
  registerReminders(agentIpc)
  registerFocusMode(agentIpc)
  registerWallpaper(agentIpc)
  registerPresentation({ ipcMain: agentIpc })
  registerImageSearch(agentIpc)
  registerDeckStudio({ ipcMain: agentIpc })
  registerKnowledgeGraph({ ipcMain: agentIpc })
  registerPhantomKeyboard()
  registerScreenPeeler()
  registerDropZoneControl(agentIpc)
  registerWorkflowManager()
  registerWebsiteBuilder()
  registerWidgetMaker()
  registerDeepResearch({ ipcMain: agentIpc })
  registerOracle({ ipcMain: agentIpc })
  registerWormhole({ ipcMain: agentIpc })
  registerPermanentMemory({ ipcMain: agentIpc, app })
  registerTelekinesis({ ipcMain: agentIpc })
  registerBrutusCoder({ ipcMain: agentIpc, app })
  registerRealityHacker(agentIpc)
  registerAdbHandlers(agentIpc)
  registerLocationHandlers(agentIpc)
  registerGmailHandlers(agentIpc)
  // After Gmail: the Desk engine calls into it, and starting the loop before
  // its dependency is registered would leave the first run without a mailbox.
  //
  // Wrapped because a registrar that throws silently deletes every registrar
  // BELOW it — Gallery, Notes and the whole file toolchain would vanish with no
  // error beyond "No handler registered" in whichever view asked first. The Desk
  // is the one that touches the disk at start-up, so it is the one that can.
  try {
    registerDesk(agentIpc)
  } catch (err) {
    console.error('[main] the Desk failed to register:', err)
  }
  registerGalleryHandlers(agentIpc)
  registerterminalControl(agentIpc)
  registerGhostControl(agentIpc)
  registerWebAgent(agentIpc)
  registerNotesHandlers(agentIpc)
  registerAppLauncher(agentIpc)
  registerDirLoader(agentIpc)
  registerFileOpen(agentIpc)
  registerFileSearch(agentIpc)
  registerFileRead(agentIpc)
  registerFileWrite(agentIpc)
  registerFileOps(agentIpc)
  registerFileScanner(agentIpc)
  registerSystemHandlers(agentIpc)
  registerIpcHandlers({ ipcMain: agentIpc, app })

  ipcMain.handle('get-screen-source', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    return sources[0]?.id
  })

  createWindow()

  globalShortcut.register('CommandOrControl+Shift+I', () => toggleOverlayMode())
  ipcMain.on('toggle-overlay', () => toggleOverlayMode())

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
