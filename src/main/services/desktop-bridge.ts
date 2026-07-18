/**
 * BRUTUS Desktop Bridge — LAN sync host
 * -------------------------------------
 * Turns the Command PC into the hub of a "single Brutus" that spans the desktop
 * and the phone. It:
 *
 *   1. Advertises itself over UDP so the phone auto-discovers it (no typed IPs).
 *   2. Hosts a WebSocket server the phone connects to, gated by a 6-digit
 *      pairing code.
 *   3. Mirrors chat both ways — anything said/typed on the desktop appears on
 *      the phone and vice-versa — and keeps a shared live "state" (listening /
 *      thinking / speaking + emotion) in sync so both faces react together.
 *   4. Optionally *orchestrates*: a message that arrives from the phone can be
 *      answered by the desktop brain (Brain Node → Gemini via `runChat`) and the
 *      reply fanned out to every device.
 *
 * The chat pipeline stays decoupled via `bridge-bus`: desktop-originated
 * messages arrive as OUTBOUND_MESSAGE events; messages we need to persist
 * without echoing go out as PERSIST_MESSAGE. See bridge-bus.ts.
 */
import { IpcMain, BrowserWindow } from 'electron'
import dgram from 'dgram'
import os from 'os'
import crypto from 'crypto'
import Store from 'electron-store'
import { WebSocketServer, WebSocket } from 'ws'

import {
  DISCOVERY_PORT,
  DEFAULT_WS_PORT,
  DISCOVERY_REQUEST,
  DISCOVERY_MAGIC,
  BRIDGE_PROTOCOL_VERSION,
  MSG,
  makeEnvelope,
  parseEnvelope,
  type Envelope,
  type BridgeDevice,
  type ChatData,
  type StateData,
  type HelloData,
  type BridgeRole
} from './bridge-protocol'
import { bridgeBus, BRIDGE_EVENTS, type BusMessage } from './bridge-bus'
import { readHistory } from './chat-history'
import { runChat, type ChatMessage } from './llm-provider'

// ─── Config ─────────────────────────────────────────────────────────────────
interface BridgeConfig {
  enabled: boolean
  wsPort: number
  requirePairing: boolean
  orchestrate: boolean
  serverName: string
  serverId: string
  pairingCode: string
}

const CONFIG_KEY = 'brutus_bridge_config'

let _store: any = null
function getStore(): any {
  if (!_store) {
    const StoreClass: any = (Store as any).default || Store
    _store = new StoreClass()
  }
  return _store
}

function sixDigitCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

function loadConfig(): BridgeConfig {
  let saved: Partial<BridgeConfig> = {}
  try {
    saved = (getStore().get(CONFIG_KEY) as Partial<BridgeConfig>) || {}
  } catch {
    saved = {}
  }
  const config: BridgeConfig = {
    enabled: saved.enabled !== undefined ? !!saved.enabled : true,
    wsPort: typeof saved.wsPort === 'number' && saved.wsPort > 0 ? saved.wsPort : DEFAULT_WS_PORT,
    requirePairing: saved.requirePairing !== undefined ? !!saved.requirePairing : true,
    // Default OFF: the phone has its own brain, so the bridge is a clean mirror
    // (no double answers). Turn ON only to use the phone as a "dumb remote" whose
    // messages the desktop brain should answer.
    orchestrate: saved.orchestrate !== undefined ? !!saved.orchestrate : false,
    serverName: (saved.serverName || os.hostname() || 'Brutus PC').toString(),
    serverId: (saved.serverId || crypto.randomUUID()).toString(),
    pairingCode: (saved.pairingCode || sixDigitCode()).toString()
  }
  // Persist any freshly-generated identity/code so it is stable across restarts.
  saveConfig(config)
  return config
}

function saveConfig(config: BridgeConfig): void {
  try {
    getStore().set(CONFIG_KEY, config)
  } catch {
    /* non-fatal — in-memory config still applies */
  }
}

// ─── Runtime state ────────────────────────────────────────────────────────────
interface ClientInfo {
  id: string
  name: string
  platform: string
  role: 'host' | 'mobile'
  paired: boolean
  isAlive: boolean
  connectedAt: number
}

let config: BridgeConfig = {
  enabled: true,
  wsPort: DEFAULT_WS_PORT,
  requirePairing: true,
  orchestrate: true,
  serverName: 'Brutus PC',
  serverId: '',
  pairingCode: '000000'
}

let wss: WebSocketServer | null = null
let discoverySocket: dgram.Socket | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let busWired = false
let running = false
let lastError: string | null = null

const clients = new Map<WebSocket, ClientInfo>()
let lastState: StateData = { status: 'idle', emotion: null, engine: null }

let getWindowRef: () => BrowserWindow | null = () => null

// ─── Helpers ───────────────────────────────────────────────────────────────
/** Best LAN IPv4 for display / manual entry (prefers private ranges). */
function getLanIp(): string {
  const ifaces = os.networkInterfaces()
  const candidates: string[] = []
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push(net.address)
    }
  }
  const preferred = candidates.find(
    (ip) => ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')
  )
  return preferred || candidates[0] || '127.0.0.1'
}

function safeSend(ws: WebSocket, env: Envelope): void {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env))
  } catch {
    /* client went away mid-send */
  }
}

/** Broadcast an envelope to every paired client, optionally skipping one. */
function broadcast(env: Envelope, except?: WebSocket): void {
  for (const [ws, info] of clients) {
    if (!info.paired || ws === except) continue
    safeSend(ws, env)
  }
}

function pushToRenderer(type: string, payload: unknown): void {
  const win = getWindowRef()
  if (win && !win.isDestroyed()) {
    win.webContents.send('bridge-event', { type, payload })
  }
}

function deviceList(): BridgeDevice[] {
  const devices: BridgeDevice[] = [
    {
      id: config.serverId,
      name: config.serverName,
      platform: process.platform,
      role: 'host',
      online: true
    }
  ]
  for (const info of clients.values()) {
    if (!info.paired) continue
    devices.push({
      id: info.id,
      name: info.name,
      platform: info.platform,
      role: info.role,
      online: true
    })
  }
  return devices
}

function announcePresence(): void {
  const devices = deviceList()
  broadcast(makeEnvelope(MSG.PRESENCE, config.serverId, { devices }))
  pushToRenderer('devices', { devices })
}

/** Normalise a stored/desktop role ('model') to the wire role ('assistant'). */
function toWireRole(role: string): BridgeRole {
  if (role === 'model' || role === 'brutus' || role === 'assistant') return 'assistant'
  if (role === 'tool') return 'tool'
  return 'user'
}

/** Normalise a wire role to the desktop history convention ('model'). */
function toDesktopRole(role: BridgeRole): string {
  if (role === 'assistant') return 'model'
  if (role === 'tool') return 'tool'
  return 'user'
}

// ─── Incoming message handling ───────────────────────────────────────────────
function handleHello(ws: WebSocket, env: Envelope<HelloData>): void {
  const info = clients.get(ws)
  if (!info) return
  const data = env.data || ({} as HelloData)

  if (config.requirePairing) {
    if (!data.token || data.token !== config.pairingCode) {
      safeSend(
        ws,
        makeEnvelope(MSG.UNAUTHORIZED, config.serverId, {
          reason: 'Invalid or missing pairing code.'
        })
      )
      setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }, 250)
      return
    }
  }

  info.paired = true
  info.id = data.device?.id || info.id
  info.name = data.device?.name || 'Brutus Phone'
  info.platform = data.device?.platform || 'android'
  info.role = data.device?.role === 'host' ? 'host' : 'mobile'

  // Welcome: hand over identity, current state, and a recent history snapshot
  // so the phone opens already in sync with the desktop.
  const history = readHistory()
    .slice(-30)
    .map((m) => ({
      messageId: `${m.timestamp}`,
      role: toWireRole(m.role),
      text: m.content,
      origin: 'host' as const
    }))

  safeSend(
    ws,
    makeEnvelope(MSG.WELCOME, config.serverId, {
      server: {
        id: config.serverId,
        name: config.serverName,
        platform: process.platform
      },
      protocol: BRIDGE_PROTOCOL_VERSION,
      state: lastState,
      history
    })
  )

  announcePresence()
}

function handleIncomingChat(ws: WebSocket, env: Envelope<ChatData>): void {
  const info = clients.get(ws)
  if (!info || !info.paired) return
  const data = env.data
  if (!data || typeof data.text !== 'string' || !data.text.trim()) return

  const text = data.text.trim()
  const role: BridgeRole = data.role || 'user'

  // 1) Persist into desktop history WITHOUT re-broadcasting (loop-safe).
  bridgeBus.emit(BRIDGE_EVENTS.PERSIST_MESSAGE, {
    role: toDesktopRole(role),
    text
  } as BusMessage)

  // 2) Show it on the desktop.
  pushToRenderer('chat', {
    role,
    text,
    emotion: data.emotion ?? null,
    origin: 'mobile',
    deviceName: info.name
  })

  // 3) Fan out to any OTHER connected phones (multi-device rooms).
  broadcast(
    makeEnvelope(MSG.CHAT, config.serverId, {
      messageId: data.messageId || env.id,
      role,
      text,
      emotion: data.emotion ?? null,
      origin: 'mobile'
    } as ChatData),
    ws
  )

  // 4) If orchestration is on and this is a user turn, let the desktop brain
  //    answer and fan the reply out to everyone (including the sender).
  if (config.orchestrate && role === 'user') {
    void orchestrateReply(text)
  }
}

async function orchestrateReply(userText: string): Promise<void> {
  try {
    const history = readHistory()
    const messages: ChatMessage[] = history.map((m) => ({
      role: m.role === 'model' || m.role === 'brutus' ? 'assistant' : 'user',
      content: m.content
    }))
    // Ensure the just-received turn is the last user message.
    if (!messages.length || messages[messages.length - 1].content !== userText) {
      messages.push({ role: 'user', content: userText })
    }

    const result = await runChat({ messages })
    const reply = (result.text || '').trim()
    if (!reply) return

    // Persist + show on desktop + fan out to phones.
    bridgeBus.emit(BRIDGE_EVENTS.PERSIST_MESSAGE, { role: 'model', text: reply } as BusMessage)
    pushToRenderer('chat', {
      role: 'assistant',
      text: reply,
      emotion: result.emotion ?? null,
      origin: 'host',
      backend: result.backend
    })
    broadcast(
      makeEnvelope(MSG.CHAT, config.serverId, {
        messageId: `ai-${Date.now()}`,
        role: 'assistant',
        text: reply,
        emotion: result.emotion ?? null,
        origin: 'host'
      } as ChatData)
    )
    if (result.emotion) {
      lastState = { ...lastState, emotion: result.emotion }
    }
  } catch (err) {
    console.error('[Bridge] orchestrateReply failed:', err)
  }
}

function handleIncomingState(ws: WebSocket, env: Envelope<StateData>): void {
  const info = clients.get(ws)
  if (!info || !info.paired) return
  const data = env.data
  if (!data || typeof data.status !== 'string') return
  // Relay the phone's live state to the desktop UI + any other devices.
  pushToRenderer('state', { ...data, deviceName: info.name })
  broadcast(makeEnvelope(MSG.STATE, config.serverId, data), ws)
}

function handleMessage(ws: WebSocket, raw: string): void {
  const env = parseEnvelope(raw)
  if (!env) return
  const info = clients.get(ws)
  if (!info) return

  switch (env.t) {
    case MSG.HELLO:
      handleHello(ws, env as Envelope<HelloData>)
      break
    case MSG.PING:
      info.isAlive = true
      safeSend(ws, makeEnvelope(MSG.PONG, config.serverId, { t0: (env.data as any)?.t0 ?? null }))
      break
    case MSG.PONG:
      info.isAlive = true
      break
    case MSG.CHAT:
      handleIncomingChat(ws, env as Envelope<ChatData>)
      break
    case MSG.STATE:
      handleIncomingState(ws, env as Envelope<StateData>)
      break
    case MSG.ROBOT:
    case MSG.COMMAND:
      // Relay robot events / generic commands to the desktop + other devices.
      pushToRenderer(env.t, { ...(env.data || {}), deviceName: info.name })
      broadcast(makeEnvelope(env.t, config.serverId, env.data), ws)
      break
    default:
      break
  }
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────
function wireBus(): void {
  if (busWired) return
  busWired = true

  // Desktop produced a message → send it to every phone.
  bridgeBus.on(BRIDGE_EVENTS.OUTBOUND_MESSAGE, (msg: BusMessage) => {
    if (!running || !msg || !msg.text) return
    broadcast(
      makeEnvelope(MSG.CHAT, config.serverId, {
        messageId: `pc-${Date.now()}`,
        role: toWireRole(msg.role),
        text: msg.text,
        origin: 'host'
      } as ChatData)
    )
  })
}

function startDiscovery(): void {
  try {
    discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    discoverySocket.on('message', (buf, rinfo) => {
      if (buf.toString('utf-8').trim() !== DISCOVERY_REQUEST) return
      const reply = Buffer.from(
        JSON.stringify({
          magic: DISCOVERY_MAGIC,
          v: BRIDGE_PROTOCOL_VERSION,
          id: config.serverId,
          name: config.serverName,
          platform: process.platform,
          ws: config.wsPort,
          requiresPairing: config.requirePairing
        })
      )
      try {
        discoverySocket?.send(reply, rinfo.port, rinfo.address)
      } catch {
        /* client vanished */
      }
    })

    discoverySocket.on('error', (err) => {
      console.error('[Bridge] discovery socket error:', err.message)
    })

    discoverySocket.bind(DISCOVERY_PORT, () => {
      try {
        discoverySocket?.setBroadcast(true)
      } catch {
        /* not fatal */
      }
    })
  } catch (err) {
    console.error('[Bridge] failed to start discovery:', err)
  }
}

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    for (const [ws, info] of clients) {
      if (!info.isAlive) {
        try {
          ws.terminate()
        } catch {
          /* ignore */
        }
        continue
      }
      info.isAlive = false
      try {
        ws.ping()
      } catch {
        /* ignore */
      }
      safeSend(ws, makeEnvelope(MSG.PING, config.serverId, { t0: Date.now() }))
    }
  }, 15000)
}

export function startBridge(): { ok: boolean; error?: string } {
  if (running) return { ok: true }
  lastError = null
  try {
    wireBus()

    wss = new WebSocketServer({ host: '0.0.0.0', port: config.wsPort })

    wss.on('connection', (ws: WebSocket) => {
      clients.set(ws, {
        id: `pending-${Date.now()}`,
        name: 'Pairing…',
        platform: 'unknown',
        role: 'mobile',
        paired: false,
        isAlive: true,
        connectedAt: Date.now()
      })

      ws.on('message', (raw) => handleMessage(ws, raw.toString()))
      ws.on('pong', () => {
        const info = clients.get(ws)
        if (info) info.isAlive = true
      })
      ws.on('close', () => {
        clients.delete(ws)
        announcePresence()
      })
      ws.on('error', () => {
        clients.delete(ws)
      })
    })

    wss.on('error', (err: Error) => {
      lastError = err.message
      console.error('[Bridge] WebSocket server error:', err.message)
      pushToRenderer('error', { message: err.message })
    })

    startDiscovery()
    startHeartbeat()
    running = true
    console.log(
      `[Bridge] host up: ws://${getLanIp()}:${config.wsPort} (pairing ${config.pairingCode})`
    )
    pushToRenderer('status', getStatus())
    return { ok: true }
  } catch (err: any) {
    lastError = err?.message || String(err)
    stopBridge()
    return { ok: false, error: lastError ?? undefined }
  }
}

export function stopBridge(): void {
  running = false
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  for (const ws of clients.keys()) {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }
  clients.clear()
  try {
    wss?.close()
  } catch {
    /* ignore */
  }
  wss = null
  try {
    discoverySocket?.close()
  } catch {
    /* ignore */
  }
  discoverySocket = null
  pushToRenderer('status', getStatus())
}

export function getStatus(): Record<string, unknown> {
  return {
    enabled: config.enabled,
    running,
    wsPort: config.wsPort,
    lanIp: getLanIp(),
    wsUrl: `ws://${getLanIp()}:${config.wsPort}`,
    pairingCode: config.pairingCode,
    requirePairing: config.requirePairing,
    orchestrate: config.orchestrate,
    serverName: config.serverName,
    serverId: config.serverId,
    error: lastError,
    devices: deviceList()
  }
}

/** Broadcast the desktop's live voice/AI state to every phone. */
export function publishState(state: StateData): void {
  lastState = {
    status: state.status,
    emotion: state.emotion ?? lastState.emotion ?? null,
    engine: state.engine ?? lastState.engine ?? null
  }
  if (running) broadcast(makeEnvelope(MSG.STATE, config.serverId, lastState))
}

// ─── IPC registration ─────────────────────────────────────────────────────────
export default function registerDesktopBridge({
  ipcMain,
  getWindow
}: {
  ipcMain: IpcMain
  getWindow: () => BrowserWindow | null
}): void {
  getWindowRef = getWindow
  config = loadConfig()

  ipcMain.handle('bridge-status', () => getStatus())

  ipcMain.handle('bridge-start', () => {
    config.enabled = true
    saveConfig(config)
    const res = startBridge()
    return { ...res, status: getStatus() }
  })

  ipcMain.handle('bridge-stop', () => {
    config.enabled = false
    saveConfig(config)
    stopBridge()
    return { ok: true, status: getStatus() }
  })

  ipcMain.handle('bridge-set-config', (_e, patch: Partial<BridgeConfig>) => {
    const wasRunning = running
    const portChanged =
      typeof patch?.wsPort === 'number' && patch.wsPort > 0 && patch.wsPort !== config.wsPort

    config = {
      ...config,
      ...(typeof patch?.wsPort === 'number' && patch.wsPort > 0 ? { wsPort: patch.wsPort } : {}),
      ...(patch?.requirePairing !== undefined ? { requirePairing: !!patch.requirePairing } : {}),
      ...(patch?.orchestrate !== undefined ? { orchestrate: !!patch.orchestrate } : {}),
      ...(patch?.serverName ? { serverName: String(patch.serverName) } : {})
    }
    saveConfig(config)

    // A port change needs a socket restart to take effect.
    if (portChanged && wasRunning) {
      stopBridge()
      startBridge()
    } else {
      pushToRenderer('status', getStatus())
    }
    return getStatus()
  })

  ipcMain.handle('bridge-regenerate-code', () => {
    config.pairingCode = sixDigitCode()
    saveConfig(config)
    // Drop already-paired clients so they must re-pair with the new code.
    for (const [ws, info] of clients) {
      if (info.paired) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }
    }
    pushToRenderer('status', getStatus())
    return getStatus()
  })

  ipcMain.handle('bridge-publish-state', (_e, state: StateData) => {
    if (state && typeof state.status === 'string') publishState(state)
    return { ok: true }
  })

  // Auto-start on boot unless the user disabled it.
  if (config.enabled) {
    setTimeout(() => startBridge(), 1200)
  }
}
