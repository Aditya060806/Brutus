/**
 * BRUTUS Robot V2 — laptop-side link to the ESP32 body controller
 * ---------------------------------------------------------------
 * Direct port of the Flutter app's `robot_v2_transport.dart` (WiFi half) and
 * `robot_v2_service.dart`, so the desktop can drive the V2 robot with no phone
 * in the loop. The ESP1 body controller hosts a newline-delimited ASCII command
 * server on TCP :8082 (see arduino/brutus_v2_body/robot_movement_esp1.ino):
 *
 *   outbound  Z<0|1> N<a> D<a> M<a> L<lr>,<ud> J<l>,<r> V<-255..255> G<0-3>
 *             U<0|1> P<ms> E<n>[,i] A<n> W<n> B S<cue> INFO H
 *   inbound   #OK (heartbeat reply → latency), #T:<dist>,<mood>,<rssi>,
 *             #DIST: #MOOD: #MODE: #RSSI: #IP:
 *
 * The renderer talks to this module over four invoke channels and one push
 * event ('robot-v2-event'). Mouth/eye rate-limiting happens renderer-side
 * (mirroring the Flutter service) so this stays a dumb, low-latency pipe:
 * TCP_NODELAY on, one write per command line.
 */
import { IpcMain, BrowserWindow } from 'electron'
import net from 'net'

export const ROBOT_V2_TCP_PORT = 8082

type V2State = 'disconnected' | 'connecting' | 'connected'

interface V2Telemetry {
  distanceCm: number | null
  mood: string | null // PATROL / CURIOUS / ALERT / RELIEF
  autonomous: boolean | null // from #MODE (MODE:0 = AUTO)
  rssi: number | null
  ip: string | null
}

const emptyTelemetry = (): V2Telemetry => ({
  distanceCm: null,
  mood: null,
  autonomous: null,
  rssi: null,
  ip: null
})

interface RegisterOpts {
  ipcMain: IpcMain
  getWindow: () => BrowserWindow | null
}

export default function registerRobotV2({ ipcMain, getWindow }: RegisterOpts): void {
  let socket: net.Socket | null = null
  let state: V2State = 'disconnected'
  let host: string | null = null
  let buf = ''
  let telemetry = emptyTelemetry()
  let latencyMs = 0

  let heartbeat: NodeJS.Timeout | null = null
  let lastPingSent = 0

  // Auto-reconnect (matches the Flutter service: 10 tries, 2 s apart, only
  // after an unexpected drop — never after a user-initiated disconnect).
  let intentional = false
  let reconnectAttempts = 0
  let reconnectTimer: NodeJS.Timeout | null = null

  const log = (m: string): void => console.log(`[RobotV2] ${m}`)

  const emit = (type: string, payload: Record<string, unknown> = {}): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('robot-v2-event', { type, ...payload })
    }
  }

  const setState = (s: V2State): void => {
    if (state === s) return
    state = s
    emit('state', { state: s, host })
  }

  /** Accepts "192.168.1.50", "192.168.1.50:8082" or "http://192.168.1.50/x". */
  const hostFromInput = (input: string): string => {
    let s = String(input || '').trim()
    if (!s) return s
    s = s.replace(/^\w+:\/\//, '')
    s = s.split('/')[0]
    s = s.split(':')[0]
    return s
  }

  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  const startHeartbeat = (): void => {
    stopHeartbeat()
    heartbeat = setInterval(() => {
      if (state !== 'connected') return
      lastPingSent = Date.now()
      sendLine('H')
    }, 2000)
  }

  const sendLine = (line: string): void => {
    const s = socket
    if (!s || state !== 'connected') return
    try {
      s.write(`${line}\n`)
    } catch (err) {
      log(`write failed: ${err}`)
      onClosed()
    }
  }

  const onLine = (line: string): void => {
    emit('line', { line })
    if (!line.startsWith('#')) return
    const body = line.substring(1)

    if (body === 'OK') {
      latencyMs = Math.min(Math.max(Date.now() - lastPingSent, 0), 9999)
      emit('latency', { latencyMs })
      return
    }

    const colon = body.indexOf(':')
    if (colon < 0) return
    const key = body.substring(0, colon)
    const val = body.substring(colon + 1).trim()

    switch (key) {
      case 'T': {
        // compact telemetry: #T:<distCm>,<mood>,<rssi>
        const p = val.split(',')
        if (p.length >= 3) {
          const dist = parseInt(p[0].trim(), 10)
          const rssi = parseInt(p[2].trim(), 10)
          telemetry = {
            ...telemetry,
            distanceCm: Number.isNaN(dist) ? telemetry.distanceCm : dist,
            mood: p[1].trim() || telemetry.mood,
            rssi: Number.isNaN(rssi) ? telemetry.rssi : rssi
          }
        }
        break
      }
      case 'DIST': {
        const dist = parseInt(val, 10)
        if (!Number.isNaN(dist)) telemetry = { ...telemetry, distanceCm: dist }
        break
      }
      case 'MOOD':
        telemetry = { ...telemetry, mood: val }
        break
      case 'MODE':
        // MODE:0 = AUTO (matches the Flutter service's reading)
        telemetry = { ...telemetry, autonomous: val === '0' }
        break
      case 'RSSI': {
        const rssi = parseInt(val, 10)
        if (!Number.isNaN(rssi)) telemetry = { ...telemetry, rssi }
        break
      }
      case 'IP':
        telemetry = { ...telemetry, ip: val }
        break
      default:
        return
    }
    emit('telemetry', { telemetry })
  }

  const onData = (data: Buffer): void => {
    buf += data.toString('utf8')
    while (true) {
      const idx = buf.indexOf('\n')
      if (idx < 0) break
      const line = buf.substring(0, idx).trim()
      buf = buf.substring(idx + 1)
      if (line) onLine(line)
    }
    // Guard against an unbounded buffer if the peer never sends newlines.
    if (buf.length > 4096) buf = ''
  }

  const maybeReconnect = (): void => {
    if (intentional || !host) return
    if (reconnectAttempts >= 10) {
      log('gave up WiFi auto-reconnect')
      return
    }
    reconnectAttempts++
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      if (intentional || state === 'connected' || !host) return
      log(`auto-reconnecting to ${host} (attempt ${reconnectAttempts})`)
      void connect(host)
    }, 2000)
  }

  const onClosed = (): void => {
    if (socket) {
      socket.removeAllListeners()
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
      socket = null
    }
    stopHeartbeat()
    const wasConnected = state !== 'disconnected'
    setState('disconnected')
    if (wasConnected) maybeReconnect()
  }

  const teardown = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    stopHeartbeat()
    if (socket) {
      socket.removeAllListeners()
      try {
        socket.end()
        socket.destroy()
      } catch {
        /* already gone */
      }
      socket = null
    }
    setState('disconnected')
  }

  const connect = (h: string): Promise<boolean> => {
    teardown()
    setState('connecting')
    buf = ''
    return new Promise((resolve) => {
      const sock = new net.Socket()
      let settled = false
      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        resolve(ok)
      }

      const connectTimeout = setTimeout(() => {
        log(`connect to ${h} timed out`)
        sock.destroy()
      }, 6000)

      sock.once('connect', () => {
        clearTimeout(connectTimeout)
        sock.setNoDelay(true) // no Nagle → low latency, same as the phone
        socket = sock
        reconnectAttempts = 0
        telemetry = emptyTelemetry()
        latencyMs = 0
        setState('connected')
        log(`connected to ${h}:${ROBOT_V2_TCP_PORT}`)
        startHeartbeat()
        sendLine('INFO')
        settle(true)
      })
      sock.on('data', onData)
      sock.on('error', (err) => {
        clearTimeout(connectTimeout)
        log(`socket error: ${err.message}`)
        onClosed()
        settle(false)
      })
      sock.on('close', () => {
        clearTimeout(connectTimeout)
        onClosed()
        settle(false)
      })

      sock.connect(ROBOT_V2_TCP_PORT, h)
    })
  }

  // ── IPC surface ───────────────────────────────────────────────────────────

  ipcMain.handle('robot-v2-connect', async (_e, opts: { host?: string }) => {
    const h = hostFromInput(opts?.host || '')
    if (!h) return { ok: false, error: 'No IP address given.' }
    host = h
    intentional = false
    reconnectAttempts = 0
    const ok = await connect(h)
    return ok
      ? { ok: true, host: h }
      : { ok: false, error: `Could not reach the robot at ${h}:${ROBOT_V2_TCP_PORT}.` }
  })

  ipcMain.handle('robot-v2-disconnect', async () => {
    intentional = true
    host = null
    teardown()
    return { ok: true }
  })

  ipcMain.handle('robot-v2-send', async (_e, opts: { line?: string }) => {
    const raw = String(opts?.line ?? '')
    // One short ASCII command per call — strip anything that could smuggle in
    // extra protocol lines and cap the length (WIFI:<ssid>|<pass> is the
    // longest legitimate command).
    const line = raw.replace(/[\r\n]/g, '').slice(0, 96)
    if (!line) return { ok: false, error: 'Empty command.' }
    if (state !== 'connected') return { ok: false, error: 'Robot not connected.' }
    sendLine(line)
    return { ok: true }
  })

  ipcMain.handle('robot-v2-status', async () => ({
    state,
    host,
    telemetry,
    latencyMs
  }))
}
