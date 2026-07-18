/**
 * Renderer-side helpers for the Desktop Bridge (main-process host).
 *
 * Thin wrappers over the `bridge-*` IPC channels plus a subscription helper for
 * the `bridge-event` push channel (device roster, incoming phone chat, live
 * state, robot/command relays). Any view can subscribe without knowing IPC.
 */

export interface BridgeDevice {
  id: string
  name: string
  platform: string
  role: 'host' | 'mobile'
  online: boolean
}

export interface BridgeStatus {
  enabled: boolean
  running: boolean
  wsPort: number
  lanIp: string
  wsUrl: string
  pairingCode: string
  requirePairing: boolean
  orchestrate: boolean
  serverName: string
  serverId: string
  error: string | null
  devices: BridgeDevice[]
}

export interface BridgeEvent {
  type: 'status' | 'devices' | 'chat' | 'state' | 'robot' | 'command' | 'error'
  payload: any
}

const ipc = (): any => (window as any).electron?.ipcRenderer

export function getBridgeStatus(): Promise<BridgeStatus> {
  return ipc()?.invoke('bridge-status')
}

export function startBridge(): Promise<{ ok: boolean; status: BridgeStatus }> {
  return ipc()?.invoke('bridge-start')
}

export function stopBridge(): Promise<{ ok: boolean; status: BridgeStatus }> {
  return ipc()?.invoke('bridge-stop')
}

export function setBridgeConfig(patch: {
  wsPort?: number
  requirePairing?: boolean
  orchestrate?: boolean
  serverName?: string
}): Promise<BridgeStatus> {
  return ipc()?.invoke('bridge-set-config', patch)
}

export function regenerateBridgeCode(): Promise<BridgeStatus> {
  return ipc()?.invoke('bridge-regenerate-code')
}

/**
 * Build the string encoded into the pairing QR. The phone scans this to connect
 * without typing anything. Kept compact and self-describing.
 */
export function buildPairingPayload(status: BridgeStatus): string {
  return JSON.stringify({
    t: 'brutus-bridge',
    v: 1,
    host: status.lanIp,
    port: status.wsPort,
    code: status.pairingCode,
    name: status.serverName,
    id: status.serverId
  })
}

/** Subscribe to bridge push events. Returns an unsubscribe function. */
export function onBridgeEvent(handler: (e: BridgeEvent) => void): () => void {
  const channel = 'bridge-event'
  const listener = (_evt: unknown, e: BridgeEvent): void => {
    try {
      handler(e)
      // Re-dispatch as a window event so decoupled views (e.g. the eyes/avatar)
      // can react without wiring IPC themselves.
      window.dispatchEvent(new CustomEvent('brutus-bridge', { detail: e }))
    } catch {
      /* swallow handler errors */
    }
  }
  ipc()?.on?.(channel, listener)
  return () => ipc()?.removeListener?.(channel, listener)
}
