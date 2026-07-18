import { IpcMain, shell } from 'electron'
import { execFile } from 'child_process'

/**
 * BRUTUS Media Controls
 * ---------------------
 * - media-transport   : OS-global media keys (play/pause, next, prev, stop,
 *                        mute, vol±) — work without focusing any app.
 * - media-now-playing : current track/title via Windows SMTC (WinRT).
 * - youtube-control   : focus a YouTube browser tab, send YouTube hotkeys
 *                        (seek, fullscreen, captions, next/prev video).
 * - spotify-control   : transport via global keys + Spotify-specific
 *                        shuffle / repeat / like via focus + app shortcuts.
 * - open-streaming    : open & search Netflix / Prime Video / YouTube / Spotify.
 *
 * Native modules are loaded defensively so a missing dependency disables
 * the feature instead of crashing the main process.
 */

let nutjs: any = null
try {
  nutjs = require('@nut-tree-fork/nut-js')
  nutjs.keyboard.config.autoDelayMs = 20
} catch (e) {
  console.warn('⚠️ nut-js unavailable — media key control disabled.', e)
}

let windowManager: any = null
try {
  windowManager = require('node-window-manager').windowManager
} catch (e) {
  console.warn('⚠️ node-window-manager unavailable — app focusing disabled.', e)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── Global media keys ────────────────────────────────────────────────
const MEDIA_KEY_MAP: Record<string, string> = {
  play_pause: 'AudioPlay',
  play: 'AudioPlay',
  pause: 'AudioPause',
  stop: 'AudioStop',
  next: 'AudioNext',
  previous: 'AudioPrev',
  prev: 'AudioPrev',
  mute: 'AudioMute',
  volume_up: 'AudioVolUp',
  volume_down: 'AudioVolDown'
}

async function pressGlobalMediaKey(action: string): Promise<boolean> {
  if (!nutjs) return false
  const { keyboard, Key } = nutjs
  const keyName = MEDIA_KEY_MAP[action]
  if (!keyName || Key[keyName] === undefined) return false
  await keyboard.pressKey(Key[keyName])
  await keyboard.releaseKey(Key[keyName])
  return true
}

// ─── Window focusing ──────────────────────────────────────────────────
function focusWindowByKeywords(keywords: string[]): boolean {
  if (!windowManager) return false
  try {
    if (typeof windowManager.requestAccessibility === 'function') {
      windowManager.requestAccessibility()
    }
    const wins = windowManager.getWindows()
    const target = wins.find((w: any) => {
      try {
        if (!w.isWindow() || !w.isVisible()) return false
        const title = (w.getTitle() || '').toLowerCase()
        const p = (w.path || '').toLowerCase()
        return keywords.some((k) => title.includes(k) || p.includes(k))
      } catch {
        return false
      }
    })
    if (target) {
      if (typeof target.restore === 'function') target.restore()
      target.bringToTop()
      return true
    }
  } catch {
    // fall through
  }
  return false
}

// Press a key, optionally with modifier keys, on the currently focused window.
async function pressCombo(keyName: string, modifiers: string[] = []): Promise<void> {
  if (!nutjs) return
  const { keyboard, Key } = nutjs
  const mods = modifiers.map((m) => Key[m]).filter((m) => m !== undefined)
  const main = Key[keyName]
  if (main === undefined) return
  for (const mod of mods) await keyboard.pressKey(mod)
  await keyboard.pressKey(main)
  await keyboard.releaseKey(main)
  for (const mod of [...mods].reverse()) await keyboard.releaseKey(mod)
}

// ─── Now-playing (Windows SMTC via WinRT) ─────────────────────────────
const NOW_PLAYING_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(5000) | Out-Null
    $netTask.Result
  }
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $session = $mgr.GetCurrentSession()
  if ($null -eq $session) { Write-Output 'NO_SESSION'; return }
  $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $playback = $session.GetPlaybackInfo()
  $status = $playback.PlaybackStatus.ToString()
  Write-Output ("TITLE=" + $props.Title)
  Write-Output ("ARTIST=" + $props.Artist)
  Write-Output ("STATUS=" + $status)
} catch {
  Write-Output 'ERROR'
}
`

const runEncodedPowerShell = (script: string): Promise<string> =>
  new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { maxBuffer: 1024 * 1024 * 5 },
      (error, stdout) => {
        if (error) resolve('')
        else resolve((stdout || '').trim())
      }
    )
  })

export default function registerMediaControls(ipcMain: IpcMain) {
  // ─── GLOBAL TRANSPORT ─────────────────────────────────────────────
  ipcMain.removeHandler('media-transport')
  ipcMain.handle('media-transport', async (_event, { action }) => {
    if (!nutjs) return '❌ Media control disabled: nut-js native module missing.'
    const ok = await pressGlobalMediaKey(String(action || '').toLowerCase())
    if (!ok) return `❌ Unknown media action: "${action}".`
    return `✅ Media: ${action}.`
  })

  // ─── NOW PLAYING ──────────────────────────────────────────────────
  ipcMain.removeHandler('media-now-playing')
  ipcMain.handle('media-now-playing', async () => {
    const out = await runEncodedPowerShell(NOW_PLAYING_SCRIPT)
    if (!out || out.includes('NO_SESSION')) {
      return 'Nothing is currently playing (no active media session).'
    }
    if (out.includes('ERROR')) {
      return 'I could not read the media session on this system.'
    }
    const title = /TITLE=(.*)/.exec(out)?.[1]?.trim() || ''
    const artist = /ARTIST=(.*)/.exec(out)?.[1]?.trim() || ''
    const status = /STATUS=(.*)/.exec(out)?.[1]?.trim() || ''
    if (!title) return 'A media session is active but no track title is available.'
    const by = artist ? ` by ${artist}` : ''
    const state = status && status.toLowerCase() !== 'playing' ? ` (${status})` : ''
    return `Now playing: "${title}"${by}${state}.`
  })

  // ─── YOUTUBE ──────────────────────────────────────────────────────
  ipcMain.removeHandler('youtube-control')
  ipcMain.handle('youtube-control', async (_event, { action }) => {
    if (!nutjs) return '❌ YouTube control disabled: nut-js native module missing.'

    const focused = focusWindowByKeywords(['youtube'])
    if (!focused) {
      // Graceful fallback for transport-style actions using global keys
      const a = String(action || '').toLowerCase()
      if (['play_pause', 'next', 'previous', 'mute'].includes(a)) {
        const mapped = a === 'play_pause' ? 'play_pause' : a
        const ok = await pressGlobalMediaKey(mapped)
        if (ok)
          return `⚠️ No focused YouTube tab found — used the global media key for "${action}" instead.`
      }
      return '❌ I could not find an open YouTube browser tab to control. Open a YouTube video first.'
    }

    await sleep(350)

    switch (String(action || '').toLowerCase()) {
      case 'play_pause':
        await pressCombo('K')
        return '✅ YouTube: toggled play/pause.'
      case 'next':
        await pressCombo('N', ['LeftShift'])
        return '✅ YouTube: next video.'
      case 'previous':
        await pressCombo('P', ['LeftShift'])
        return '✅ YouTube: previous video.'
      case 'forward':
        await pressCombo('L')
        return '✅ YouTube: skipped forward 10s.'
      case 'rewind':
        await pressCombo('J')
        return '✅ YouTube: skipped back 10s.'
      case 'fullscreen':
        await pressCombo('F')
        return '✅ YouTube: toggled fullscreen.'
      case 'mute':
        await pressCombo('M')
        return '✅ YouTube: toggled mute.'
      case 'captions':
        await pressCombo('C')
        return '✅ YouTube: toggled captions.'
      default:
        return `❌ Unknown YouTube action: "${action}".`
    }
  })

  // ─── SPOTIFY ──────────────────────────────────────────────────────
  ipcMain.removeHandler('spotify-control')
  ipcMain.handle('spotify-control', async (_event, { action }) => {
    if (!nutjs) return '❌ Spotify control disabled: nut-js native module missing.'
    const a = String(action || '').toLowerCase()

    // Transport works globally without focusing Spotify
    if (['play_pause', 'pause', 'next', 'previous', 'stop'].includes(a)) {
      const ok = await pressGlobalMediaKey(a)
      return ok ? `✅ Spotify: ${a.replace('_', ' ')}.` : `❌ Unknown action "${action}".`
    }

    // Shuffle / repeat / like need the Spotify app focused (app shortcuts)
    const focused = focusWindowByKeywords(['spotify'])
    if (!focused) {
      return '❌ I could not find the Spotify desktop app. Open Spotify first for shuffle/repeat/like.'
    }
    await sleep(350)

    switch (a) {
      case 'shuffle':
        await pressCombo('S', ['LeftControl'])
        return '✅ Spotify: toggled shuffle.'
      case 'repeat':
        await pressCombo('R', ['LeftControl'])
        return '✅ Spotify: toggled repeat.'
      case 'like':
      case 'save':
      case 'save_liked':
        // Spotify "Save to Liked Songs" shortcut (Alt+Shift+B on supported versions)
        await pressCombo('B', ['LeftAlt', 'LeftShift'])
        return '✅ Spotify: sent "Save to Liked Songs" shortcut (works on supported Spotify versions).'
      default:
        return `❌ Unknown Spotify action: "${action}".`
    }
  })

  // ─── STREAMING OPEN / SEARCH ──────────────────────────────────────
  ipcMain.removeHandler('open-streaming')
  ipcMain.handle('open-streaming', async (_event, { platform, query }) => {
    const p = String(platform || '').toLowerCase()
    const q = query ? encodeURIComponent(String(query)) : ''
    let url = ''
    let label = ''

    if (p.includes('netflix')) {
      label = 'Netflix'
      url = q ? `https://www.netflix.com/search?q=${q}` : 'https://www.netflix.com'
    } else if (p.includes('prime') || p.includes('amazon')) {
      label = 'Prime Video'
      url = q ? `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${q}` : 'https://www.primevideo.com'
    } else if (p.includes('youtube')) {
      label = 'YouTube'
      url = q ? `https://www.youtube.com/results?search_query=${q}` : 'https://www.youtube.com'
    } else if (p.includes('spotify')) {
      label = 'Spotify'
      url = q ? `https://open.spotify.com/search/${q}` : 'https://open.spotify.com'
    } else {
      return `❌ Unsupported streaming platform: "${platform}". Try Netflix, Prime Video, YouTube, or Spotify.`
    }

    try {
      await shell.openExternal(url)
      return query
        ? `✅ Opening ${label} and searching for "${query}".`
        : `✅ Opening ${label}.`
    } catch (err) {
      return `❌ Failed to open ${label}: ${String(err)}`
    }
  })
}
