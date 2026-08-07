/**
 * BRUTUS Desktop Bridge — shared wire protocol
 * --------------------------------------------
 * A tiny, versioned JSON protocol spoken over a LAN WebSocket between the
 * Command PC (this Electron app, the "host") and the Brutus mobile app (the
 * "client"). The exact same shape is mirrored in the Flutter client at
 * `lib/data/services/bridge_protocol.dart`. Keep the two in lockstep.
 *
 * Transport:
 *   • Discovery  — UDP request/reply on DISCOVERY_PORT so the phone can find the
 *                  PC without anyone typing an IP.
 *   • Sync       — a persistent WebSocket on the advertised wsPort.
 *
 * Every WebSocket frame is a single JSON `Envelope`.
 */

export const BRIDGE_PROTOCOL_VERSION = 1

/** UDP port the host listens on for discovery requests. */
export const DISCOVERY_PORT = 48752
/** Default TCP port for the WebSocket sync server (configurable). */
export const DEFAULT_WS_PORT = 48753

/** Magic payload a client broadcasts to find hosts on the LAN. */
export const DISCOVERY_REQUEST = 'BRUTUS_BRIDGE_DISCOVER_V1'
/** Marker the host puts in its discovery reply so clients can sanity-check it. */
export const DISCOVERY_MAGIC = 'brutus-bridge'

/** Message types carried in `Envelope.t`. */
export const MSG = {
  /** client → host: authenticate + announce device. */
  HELLO: 'hello',
  /** host → client: accepted; carries a state + history snapshot. */
  WELCOME: 'welcome',
  /** host → client: rejected (bad/absent pairing token). */
  UNAUTHORIZED: 'unauthorized',
  /** either way: app-level keepalive. */
  PING: 'ping',
  PONG: 'pong',
  /** host → all: the current roster of connected devices. */
  PRESENCE: 'presence',
  /** either way: a chat message (user / assistant / tool). */
  CHAT: 'chat',
  /** either way: live AI/voice state (idle/listening/thinking/speaking + emotion). */
  STATE: 'state',
  /** either way: robot expression/animation events (relayed, extensible). */
  ROBOT: 'robot',
  /** either way: a generic cross-device command (relayed, extensible). */
  COMMAND: 'command',
  /** host → client: non-fatal error notice. */
  ERROR: 'error'
} as const

export type BridgeMsgType = (typeof MSG)[keyof typeof MSG]

/** Roles are normalised across desktop ('model') and mobile ('assistant'). */
export type BridgeRole = 'user' | 'assistant' | 'tool'

/** AI/voice status, shared vocabulary on both platforms. */
export type BridgeVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'

export type DeviceRole = 'host' | 'mobile'

export interface BridgeDevice {
  id: string
  name: string
  platform: string
  role: DeviceRole
  online: boolean
}

export interface Envelope<T = any> {
  /** protocol version */
  v: number
  /** message type (see MSG) */
  t: BridgeMsgType
  /** unique message id */
  id: string
  /** epoch millis */
  ts: number
  /** sender device id */
  src: string
  /** type-specific payload */
  data: T
}

export interface HelloData {
  token: string
  protocol: number
  device: { id: string; name: string; platform: string; role: DeviceRole }
}

export interface ChatData {
  messageId: string
  role: BridgeRole
  text: string
  emotion?: string | null
  /** which side produced it, for UI attribution + loop-avoidance */
  origin: DeviceRole
  toolName?: string | null
}

export interface StateData {
  status: BridgeVoiceStatus
  emotion?: string | null
  engine?: string | null
}

let _counter = 0

/** Build a well-formed envelope. `id` is unique per process without extra deps. */
export function makeEnvelope<T>(t: BridgeMsgType, src: string, data: T): Envelope<T> {
  _counter = (_counter + 1) % 1_000_000
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    t,
    id: `${Date.now().toString(36)}-${_counter.toString(36)}`,
    ts: Date.now(),
    src,
    data
  }
}

/** Parse + shallow-validate an incoming frame. Returns null on anything bogus. */
export function parseEnvelope(raw: string): Envelope | null {
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    if (typeof obj.t !== 'string' || typeof obj.v !== 'number') return null
    if (obj.data === undefined) obj.data = {}
    return obj as Envelope
  } catch {
    return null
  }
}
