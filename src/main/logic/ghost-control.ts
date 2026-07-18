import { IpcMain, app, shell, clipboard, screen } from 'electron'
import path from 'path'
import { exec } from 'child_process'

// Native modules loaded defensively — app won't crash if they're missing
let nutjs: any = null
let screenshotModule: any = null
let loudnessModule: any = null

try {
  nutjs = require('@nut-tree-fork/nut-js')
  nutjs.keyboard.config.autoDelayMs = 20
} catch (e) {
  console.warn('⚠️ @nut-tree-fork/nut-js not available. Ghost keyboard/mouse features disabled.', e)
}

try {
  screenshotModule = require('screenshot-desktop')
} catch (e) {
  console.warn('⚠️ screenshot-desktop not available. Screenshot feature disabled.', e)
}

try {
  loudnessModule = require('loudness')
} catch (e) {
  console.warn('⚠️ loudness not available. Volume control disabled.', e)
}

const getKey = (name: string) => {
  if (!nutjs) return undefined
  const { Key } = nutjs
  const KEY_MAP: Record<string, any> = {
    enter: Key.Enter,
    return: Key.Enter,
    space: Key.Space,
    tab: Key.Tab,
    escape: Key.Escape,
    esc: Key.Escape,
    backspace: Key.Backspace,
    shift: Key.LeftShift,
    control: Key.LeftControl,
    ctrl: Key.LeftControl,
    alt: Key.LeftAlt,
    command: Key.LeftSuper,
    win: Key.LeftSuper,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    pageup: Key.PageUp,
    pagedown: Key.PageDown,
    a: Key.A,
    b: Key.B,
    c: Key.C,
    d: Key.D,
    e: Key.E,
    f: Key.F,
    g: Key.G,
    h: Key.H,
    i: Key.I,
    j: Key.J,
    k: Key.K,
    l: Key.L,
    m: Key.M,
    n: Key.N,
    o: Key.O,
    p: Key.P,
    q: Key.Q,
    r: Key.R,
    s: Key.S,
    t: Key.T,
    u: Key.U,
    v: Key.V,
    w: Key.W,
    x: Key.X,
    y: Key.Y,
    z: Key.Z,
    f1: Key.F1,
    f5: Key.F5,
    f11: Key.F11,
    f12: Key.F12
  }
  return KEY_MAP[name.toLowerCase()]
}

function generateHumanPath(start: any, end: any): any[] {
  if (!nutjs) return []
  const { Point } = nutjs
  const steps = 25
  const pathArray: any[] = []

  const directionX = end.x > start.x ? 1 : -1
  const directionY = end.y > start.y ? 1 : -1
  const deviation = Math.random() * 80 + 20 

  const controlPoint = new Point(
    start.x +
      (Math.abs(end.x - start.x) / 2) * directionX +
      (Math.random() < 0.5 ? -deviation : deviation),
    start.y +
      (Math.abs(end.y - start.y) / 2) * directionY +
      (Math.random() < 0.5 ? -deviation : deviation)
  )

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * controlPoint.x + t * t * end.x
    const y = (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * controlPoint.y + t * t * end.y
    pathArray.push(new Point(x, y))
  }
  return pathArray
}

export default function registerGhostControl(ipcMain: IpcMain) {
  ipcMain.handle('copy-file-to-clipboard', async (_event, filePath: string) => {
    return new Promise((resolve) => {
      const cmd = `powershell -command "Set-Clipboard -Path '${filePath}'"`
      exec(cmd, (error) => {
        if (error) {
          resolve(false)
        } else resolve(true)
      })
    })
  })

  ipcMain.handle('ghost-sequence', async (_event, actions: any[]) => {
    if (!nutjs) return 'Ghost control disabled: @nut-tree-fork/nut-js native module is missing.'
    const { keyboard, Key, mouse } = nutjs
    try {
      for (const action of actions) {
        if (action.type === 'paste') {
          clipboard.writeText(action.text)
          await new Promise((r) => setTimeout(r, 200))
          await keyboard.pressKey(Key.LeftControl, Key.V)
          await keyboard.releaseKey(Key.V, Key.LeftControl)
        } else if (action.type === 'wait') {
          await new Promise((r) => setTimeout(r, action.ms || 500))
        } else if (action.type === 'type') {
          await keyboard.type(action.text)
        } else if (action.type === 'press') {
          const k = getKey(action.key)
          if (k !== undefined) {
            if (action.modifiers) {
              const mods = action.modifiers
                .map((m: any) => getKey(m))
                .filter(Boolean)
              for (const mod of mods) await keyboard.pressKey(mod)
              await keyboard.pressKey(k)
              await keyboard.releaseKey(k)
              for (const mod of mods.reverse()) await keyboard.releaseKey(mod)
            } else {
              await keyboard.pressKey(k)
              await keyboard.releaseKey(k)
            }
          }
        } else if (action.type === 'click') {
          await mouse.leftClick()
        }
      }
      return true
    } catch (e) {
      console.error('Ghost sequence failed:', e)
      return false
    }
  })

  ipcMain.handle('ghost-click-coordinate', async (_event, { x, y, doubleClick }) => {
    if (!nutjs) return 'Ghost click disabled: @nut-tree-fork/nut-js native module is missing.'
    const { mouse, Point, Button } = nutjs
    try {
      const primaryDisplay = screen.getPrimaryDisplay()
      const scaleFactor = primaryDisplay.scaleFactor

      const logicalX = Math.round(x / scaleFactor)
      const logicalY = Math.round(y / scaleFactor)

      const startPoint = await mouse.getPosition()
      const endPoint = new Point(logicalX, logicalY)

      const pathPoints = generateHumanPath(startPoint, endPoint)
      await mouse.move(pathPoints)

      if (doubleClick) await mouse.doubleClick(Button.LEFT)
      else await mouse.leftClick()

      return true
    } catch (e) {
      return false
    }
  })

  ipcMain.handle('ghost-scroll', async (_event, { direction, amount }) => {
    if (!nutjs) return 'Ghost scroll disabled: @nut-tree-fork/nut-js native module is missing.'
    const { mouse } = nutjs
    try {
      const scrollAmount = amount || 500
      if (direction === 'up') await mouse.scrollUp(scrollAmount)
      else await mouse.scrollDown(scrollAmount)
      return true
    } catch (e) {
      return false
    }
  })

  ipcMain.handle('get-screen-size', async () => {
    const primaryDisplay = screen.getPrimaryDisplay()
    return {
      width: primaryDisplay.size.width * primaryDisplay.scaleFactor,
      height: primaryDisplay.size.height * primaryDisplay.scaleFactor
    }
  })

  ipcMain.handle('set-volume', async (_event, level: number) => {
    if (!loudnessModule) return 'Volume control disabled: loudness native module is missing.'
    try {
      await loudnessModule.setVolume(level)
      return `Volume ${level}%`
    } catch (e) {
      return 'Error'
    }
  })
  ipcMain.handle('take-screenshot', async () => {
    if (!screenshotModule) return 'Screenshot disabled: screenshot-desktop native module is missing.'
    try {
      const filename = `BRUTUS_Capture_${Date.now()}.png`
      const savePath = path.join(app.getPath('pictures'), filename)
      await screenshotModule({ filename: savePath })
      shell.showItemInFolder(savePath)
      return `Screenshot saved.`
    } catch (e) {
      return 'Error'
    }
  })
}
