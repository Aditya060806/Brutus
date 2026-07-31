import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {}

// ── IPC channel allowlists ────────────────────────────────────────────────
// The renderer talks to the main process only through these named channels.
// The lists below are the COMPLETE set the app actually uses (derived from every
// ipcRenderer.invoke / .send in the renderer and every ipcMain.handle / .on in
// main), so enforcing them changes no current behaviour — it just stops a
// compromised renderer from reaching arbitrary/unknown channels.
//
// ⚠️ When you add a new IPC channel, add it here too. If a call is blocked you'll
// see a clear "[preload] Blocked …" error in the devtools console naming the
// channel — add it to the matching list below.

const INVOKE_CHANNELS: ReadonlySet<string> = new Set([
  'adb-close-app',
  'adb-connect',
  'adb-disconnect',
  'adb-get-history',
  'adb-get-notifications',
  'adb-hardware-toggle',
  'adb-open-app',
  'adb-pull-file',
  'adb-push-file',
  'adb-quick-action',
  'adb-screenshot',
  'adb-swipe',
  'adb-tap',
  'adb-telemetry',
  'add-message',
  'analyze-folder',
  'append-file',
  'architect-draft',
  'architect-execute',
  'brain-asr',
  'brain-health',
  'brain-tts',
  'bridge-publish-state',
  'bridge-regenerate-code',
  'bridge-send',
  'bridge-set-config',
  'bridge-start',
  'bridge-status',
  'bridge-stop',
  'build-animated-website',
  'bulk-rename',
  'cancel-ingestion',
  'cancel-reminder',
  'check-for-updates',
  'check-keys-exist',
  'check-vault-status',
  'check-website-status',
  'clear-history',
  'clear-reminders',
  'close-app',
  'close-drop-zone-ui',
  'close-widgets',
  'close-wormhole',
  'consult-oracle',
  'convert-file',
  'convert-file-capabilities',
  'copy-file-to-clipboard',
  'create-directory',
  'create-pdf',
  'create-presentation',
  'create-widget',
  'deck-generate',
  'delete-core-memory',
  'delete-image',
  'delete-note',
  'delete-workflow',
  'download-update',
  'excel-op',
  'execute-deep-research',
  'file-ops',
  'file:open',
  'file:reveal',
  'find-duplicate-files',
  'find-empty-folders',
  'find-large-files',
  'focus-status',
  'get-app-version',
  'get-commitments',
  'get-drives',
  'get-gallery',
  'get-history',
  'get-installed-apps',
  'get-language',
  'get-libreoffice-status',
  'get-live-location',
  'get-mobile-info-ai',
  'get-notes',
  'get-personality',
  'get-running-apps',
  'get-screen-size',
  'get-screen-source',
  'get-system-stats',
  'ghost-click-coordinate',
  'ghost-drag-and-drop',
  'ghost-scroll',
  'ghost-sequence',
  'git-op',
  'git-pick-folder',
  'gmail-draft',
  'gmail-read',
  'gmail-send',
  'google-search',
  'hack-website',
  'index-folder',
  'ingest-codebase',
  'install-update',
  'kg-build',
  'kg-clear',
  'kg-connect',
  'kg-entity',
  'kg-export',
  'kg-list',
  'kg-obsidian-import',
  'kg-obsidian-vaults',
  'kg-parse-pid',
  'kg-pick-target',
  'kg-query',
  'kg-stats',
  'list-reminders',
  'llm-chat',
  'llm-config-get',
  'llm-config-set',
  'load-workflows',
  'media-now-playing',
  'media-transport',
  'move-file-to-category',
  'oauth-consume-pending-callback',
  'open-app',
  'open-image-location',
  'open-in-vscode',
  'open-streaming',
  'open-wormhole',
  'pick-libreoffice-path',
  'read-directory',
  'read-file',
  'read-notion-reports',
  'read-pdf',
  'robot-audio-flush',
  'robot-audio-push',
  'robot-audio-start',
  'robot-audio-status',
  'robot-audio-stop',
  'robot-ble-select',
  'robot-v2-connect',
  'robot-v2-disconnect',
  'robot-v2-send',
  'robot-v2-status',
  'run-shell-command',
  'save-commitment',
  'save-core-memory',
  'save-image-external',
  'save-image-to-gallery',
  'save-note',
  'save-workflow',
  'search-core-memory',
  'search-files',
  'search-images',
  'secure-get-keys',
  'secure-save-keys',
  'set-file-hidden',
  'set-language',
  'set-libreoffice-path',
  'set-libreoffice-preference',
  'set-personality',
  'set-reminder',
  'set-timer',
  'set-volume',
  'set-wallpaper',
  'setup-vault-pin',
  'spawn-drop-zone-ui',
  'spotify-control',
  'start-focus',
  'start-live-coding',
  'stop-focus',
  'take-screenshot',
  'teleport-windows',
  'text-chat',
  'unzip-archive',
  'verify-vault-pin',
  'vscode-op',
  'vscode-status',
  'write-file',
  'youtube-control',
  'zip-items'
])

const SEND_CHANNELS: ReadonlySet<string> = new Set([
  'copy-extracted-image',
  'copy-extracted-text',
  'peeler-result',
  'phantom-close',
  'phantom-execute-stream',
  'phantom-resize',
  'toggle-overlay',
  'trigger-lockdown',
  'window-close',
  'window-max',
  'window-min'
])

const safeInvoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  if (!INVOKE_CHANNELS.has(channel)) {
    console.error(`[preload] Blocked ipcRenderer.invoke on unregistered channel: "${channel}"`)
    return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
  }
  return ipcRenderer.invoke(channel, ...args)
}

const safeSend = (channel: string, ...args: unknown[]): void => {
  if (!SEND_CHANNELS.has(channel)) {
    console.error(`[preload] Blocked ipcRenderer.send on unregistered channel: "${channel}"`)
    return
  }
  ipcRenderer.send(channel, ...args)
}

const bridgedIpc = {
  ...electronAPI.ipcRenderer,
  invoke: safeInvoke,
  send: safeSend
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', {
      ...electronAPI,
      ipcRenderer: bridgedIpc
    })
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {}
} else {
  // @ts-ignore (define in dts)
  window.electron = {
    ...electronAPI,
    ipcRenderer: bridgedIpc
  }
  // @ts-ignore (define in dts)
  window.api = api
}
