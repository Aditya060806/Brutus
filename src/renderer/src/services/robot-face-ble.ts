/**
 * BRUTUS — Face Robot BLE service (laptop side)
 * ---------------------------------------------
 * Web Bluetooth port of the Flutter app's `robot_bluetooth_service.dart`, so
 * the Electron app can drive the v1 face robot (Arduino Uno + HM-10) with no
 * phone in the loop. Zero native deps — Chromium's BLE stack does the radio.
 *
 * HM-10 GATT profile:
 *   Service:        0000FFE0-0000-1000-8000-00805F9B34FB
 *   Characteristic: 0000FFE1-0000-1000-8000-00805F9B34FB (write-no-response + notify)
 *
 * Protocol (newline-terminated ASCII, ≤20-byte MTU):
 *   E<n> / E<n>,<i>  expression 0..9 (+ intensity 0..100)
 *   M<a>             mouth angle 0..180 (neutral 90)
 *   L<lr>,<ud>       eye look-at        B  blink
 *   I<0|1> idle      S<0|1> freeze      H  heartbeat → "OK\n"
 *   A<0..9> anims    W<0..9> tricks     C<0..3> LED pattern
 *
 * Scanning UX: Electron has no built-in chooser. requestDevice() makes the main
 * process stream scan results to us over the 'robot-ble-devices' IPC event
 * (see select-bluetooth-device in src/main/index.ts); the Robot view renders
 * its own picker and resolves the chooser via 'robot-ble-select'.
 */

export type FaceBleState = 'disconnected' | 'connecting' | 'connected'

export interface BleChooserDevice {
  deviceId: string
  deviceName: string
  likelyRobot: boolean
}

// Minimal Web Bluetooth surface (the project doesn't ship @types/web-bluetooth;
// only what this service touches is declared).
interface BtCharacteristic {
  writeValue: (data: BufferSource) => Promise<void>
  writeValueWithoutResponse?: (data: BufferSource) => Promise<void>
  startNotifications: () => Promise<unknown>
  addEventListener: (type: string, listener: (e: Event) => void) => void
}
interface BtService {
  getCharacteristic: (uuid: number) => Promise<BtCharacteristic>
}
interface BtGattServer {
  connected: boolean
  connect: () => Promise<BtGattServer>
  disconnect: () => void
  getPrimaryService: (uuid: number) => Promise<BtService>
}
interface BtDevice {
  name?: string
  gatt?: BtGattServer
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}
type NavigatorBluetooth = Navigator & {
  bluetooth?: {
    requestDevice: (options: {
      acceptAllDevices?: boolean
      optionalServices?: number[]
    }) => Promise<BtDevice>
  }
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err ?? 'unknown error')

const SERVICE_UUID = 0xffe0
const CHARACTERISTIC_UUID = 0xffe1

// Common HM-10 advertising names (varies by clone vendor) — used to float the
// robot above earbuds/watches in the picker. Mirrors the Flutter list.
const KNOWN_NAMES = [
  'hmsoft',
  'bt05',
  'mlt-bt05',
  'dsd tech',
  'hm-10',
  'brutus',
  'ble',
  'cc41-a',
  'jdy-08',
  'jdy-10'
]

export function isLikelyRobotName(name: string): boolean {
  const lower = (name || '').toLowerCase()
  return KNOWN_NAMES.some((n) => lower.includes(n))
}

type Listener<T> = (value: T) => void

class RobotFaceBle {
  private device: BtDevice | null = null
  private ffe1: BtCharacteristic | null = null
  private _state: FaceBleState = 'disconnected'

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lineBuffer = ''
  private onGattDisconnected = (): void => this.handleDisconnected()

  // ── Listeners ──
  private stateListeners = new Set<Listener<FaceBleState>>()
  private messageListeners = new Set<Listener<string>>()
  private chooserListeners = new Set<Listener<BleChooserDevice[]>>()
  private lastDeviceName: string | null = localStorage.getItem('brutus_robot_face_name')

  // ── Rate limiting (same numbers as the phone) ──
  private lastMouthAngle = -1
  private lastMouthAt = 0
  private static MOUTH_MIN_INTERVAL_MS = 25 // ~40 Hz
  private static MOUTH_DEAD_ZONE = 3 // degrees

  private lastLr = -1
  private lastUd = -1
  private lastLookAt = 0
  private static LOOK_MIN_INTERVAL_MS = 33 // ~30 Hz
  private static LOOK_DEAD_ZONE = 4 // degrees

  constructor() {
    // Chooser results streamed from main while requestDevice() is pending.
    window.electron?.ipcRenderer?.on(
      'robot-ble-devices',
      (_e: unknown, list: Array<{ deviceId?: string; deviceName?: string }>) => {
        const devices: BleChooserDevice[] = (Array.isArray(list) ? list : []).map((d) => ({
          deviceId: String(d.deviceId),
          deviceName: String(d.deviceName || 'Unknown'),
          likelyRobot: isLikelyRobotName(String(d.deviceName || ''))
        }))
        devices.sort((a, b) => {
          if (a.likelyRobot !== b.likelyRobot) return a.likelyRobot ? -1 : 1
          return a.deviceName.toLowerCase().localeCompare(b.deviceName.toLowerCase())
        })
        this.chooserListeners.forEach((l) => l(devices))
      }
    )
  }

  private log(msg: string): void {
    console.log(`[FaceBLE] ${msg}`)
  }

  // ── State plumbing ──

  get state(): FaceBleState {
    return this._state
  }

  get isConnected(): boolean {
    return this._state === 'connected'
  }

  get deviceName(): string | null {
    return this.lastDeviceName
  }

  private setState(s: FaceBleState): void {
    if (this._state === s) return
    this._state = s
    this.stateListeners.forEach((l) => l(s))
  }

  onState(l: Listener<FaceBleState>): () => void {
    this.stateListeners.add(l)
    return () => this.stateListeners.delete(l)
  }

  onMessage(l: Listener<string>): () => void {
    this.messageListeners.add(l)
    return () => this.messageListeners.delete(l)
  }

  /** Live scan results while a chooser is open (already sorted, robot first). */
  onChooserDevices(l: Listener<BleChooserDevice[]>): () => void {
    this.chooserListeners.add(l)
    return () => this.chooserListeners.delete(l)
  }

  isSupported(): boolean {
    return typeof (navigator as NavigatorBluetooth).bluetooth?.requestDevice === 'function'
  }

  // ── Scan + connect ──
  //
  // scanAndConnect() opens the chooser (main streams devices to
  // onChooserDevices). The UI then calls pick(deviceId) or cancelScan().

  async scanAndConnect(): Promise<boolean> {
    const bluetooth = (navigator as NavigatorBluetooth).bluetooth
    if (!bluetooth) {
      throw new Error('Web Bluetooth is not available in this build.')
    }
    if (this._state !== 'disconnected') return this.isConnected

    this.setState('connecting')
    try {
      // Unfiltered on purpose: HM-10 clones often don't advertise FFE0, so a
      // service filter can hide the robot (the phone app scans unfiltered for
      // the same reason). FFE0 still must be listed to be usable post-connect.
      const device = await bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID]
      })
      return await this.connectDevice(device)
    } catch (err) {
      // User cancelled the picker (NotFoundError) or the chooser failed.
      this.log(`requestDevice: ${errMsg(err)}`)
      this.setState('disconnected')
      return false
    }
  }

  /** Resolve the pending chooser with the picked device. */
  async pick(deviceId: string): Promise<void> {
    await window.electron.ipcRenderer.invoke('robot-ble-select', deviceId)
  }

  /** Cancel the pending chooser (requestDevice rejects → state resets). */
  async cancelScan(): Promise<void> {
    await window.electron.ipcRenderer.invoke('robot-ble-select', '')
  }

  private async connectDevice(device: BtDevice): Promise<boolean> {
    try {
      this.device = device
      device.addEventListener('gattserverdisconnected', this.onGattDisconnected)
      if (!device.gatt) throw new Error('Device has no GATT server.')

      const server = await Promise.race([
        device.gatt.connect(),
        new Promise<never>((_r, reject) =>
          setTimeout(() => reject(new Error('GATT connect timed out (10s)')), 10000)
        )
      ])

      const service = await server.getPrimaryService(SERVICE_UUID)
      const ffe1 = await service.getCharacteristic(CHARACTERISTIC_UUID)
      this.ffe1 = ffe1

      // Notifications carry heartbeat "OK\n" replies (and write echoes on some
      // clones — same caveat as the phone, we never disconnect on silence).
      ffe1.addEventListener('characteristicvaluechanged', (e: Event) => {
        const value = (e.target as unknown as { value?: DataView } | null)?.value
        if (value) this.onData(value)
      })
      try {
        await ffe1.startNotifications()
      } catch (err) {
        this.log(`startNotifications failed (continuing write-only): ${errMsg(err)}`)
      }

      this.lastDeviceName = device.name || 'Brutus Robot'
      localStorage.setItem('brutus_robot_face_name', this.lastDeviceName)

      this.setState('connected')
      this.log(`connected to ${this.lastDeviceName} — FFE1 ready`)
      this.startHeartbeat()
      return true
    } catch (err) {
      const msg = errMsg(err)
      this.log(`connect failed: ${msg}`)
      this.teardown()
      this.setState('disconnected')
      throw new Error(
        msg.includes('No Services')
          ? 'Device connected but the HM-10 serial service (FFE0) was not found.'
          : `Could not connect: ${msg}`
      )
    }
  }

  async disconnect(): Promise<void> {
    this.teardown()
    this.setState('disconnected')
  }

  private handleDisconnected(): void {
    this.log('GATT disconnected')
    this.teardown()
    this.setState('disconnected')
  }

  private teardown(): void {
    this.stopHeartbeat()
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected)
      try {
        if (this.device.gatt?.connected) this.device.gatt.disconnect()
      } catch {
        /* already gone */
      }
    }
    this.ffe1 = null
    this.device = null
    this.lineBuffer = ''
  }

  // ── Data in ──

  private onData(value: DataView): void {
    const chunk = new TextDecoder().decode(value)
    this.lineBuffer += chunk
    let idx: number
    while ((idx = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.substring(0, idx).trim()
      this.lineBuffer = this.lineBuffer.substring(idx + 1)
      if (line) this.messageListeners.forEach((l) => l(line))
    }
  }

  // ── Write ──

  private async write(command: string): Promise<void> {
    const c = this.ffe1
    if (!c) return
    try {
      const bytes = new TextEncoder().encode(command)
      // withoutResponse for speed (mouth at 40 Hz); all commands ≤ 8 bytes,
      // well under the HM-10's 20-byte MTU.
      if (typeof c.writeValueWithoutResponse === 'function') {
        await c.writeValueWithoutResponse(bytes)
      } else {
        await c.writeValue(bytes)
      }
    } catch (err) {
      this.log(`write failed: ${err}`)
    }
  }

  // ── Protocol commands (mirror the phone service exactly) ──

  async setExpression(mode: number): Promise<void> {
    if (!this.isConnected) return
    await this.write(`E${mode}\n`)
  }

  async setExpressionWithIntensity(mode: number, intensity: number): Promise<void> {
    if (!this.isConnected) return
    const clamped = Math.min(100, Math.max(0, Math.round(intensity)))
    await this.write(`E${mode},${clamped}\n`)
  }

  /** Mouth servo — ~40 Hz rate limit + 3° dead zone unless forced. */
  async setMouth(angle: number, force = false): Promise<void> {
    if (!this.isConnected) return
    const clamped = Math.min(180, Math.max(0, Math.round(angle)))
    if (!force) {
      if (
        this.lastMouthAngle >= 0 &&
        Math.abs(clamped - this.lastMouthAngle) < RobotFaceBle.MOUTH_DEAD_ZONE
      ) {
        return
      }
      const now = Date.now()
      if (now - this.lastMouthAt < RobotFaceBle.MOUTH_MIN_INTERVAL_MS) return
      this.lastMouthAt = now
    }
    this.lastMouthAngle = clamped
    await this.write(`M${clamped}\n`)
  }

  async closeMouth(): Promise<void> {
    this.lastMouthAngle = 90
    await this.write('M90\n')
  }

  /** Eye look — ~30 Hz rate limit + 4° dead zone unless forced. */
  async lookAt(lr: number, ud: number, force = false): Promise<void> {
    if (!this.isConnected) return
    const clampedLR = Math.min(180, Math.max(0, Math.round(lr)))
    const clampedUD = Math.min(180, Math.max(0, Math.round(ud)))
    if (!force) {
      if (
        this.lastLr >= 0 &&
        Math.abs(clampedLR - this.lastLr) < RobotFaceBle.LOOK_DEAD_ZONE &&
        Math.abs(clampedUD - this.lastUd) < RobotFaceBle.LOOK_DEAD_ZONE
      ) {
        return
      }
      const now = Date.now()
      if (now - this.lastLookAt < RobotFaceBle.LOOK_MIN_INTERVAL_MS) return
      this.lastLookAt = now
    }
    this.lastLr = clampedLR
    this.lastUd = clampedUD
    await this.write(`L${clampedLR},${clampedUD}\n`)
  }

  async blink(): Promise<void> {
    if (!this.isConnected) return
    await this.write('B\n')
  }

  async setIdleFallback(on: boolean): Promise<void> {
    if (!this.isConnected) return
    await this.write(`I${on ? 1 : 0}\n`)
  }

  /** Freeze mode — kills ALL autonomous Arduino motion; only commands move it. */
  async setFreezeMode(on: boolean): Promise<void> {
    if (!this.isConnected) return
    await this.write(`S${on ? 1 : 0}\n`)
  }

  /** Animation macro 0..9: nod, shake, look-around, wink, yawn, laugh, eye-roll, mouth-cycle, eye-cycle, wiggle. */
  async playAnimation(index: number): Promise<void> {
    if (!this.isConnected) return
    await this.write(`A${index}\n`)
  }

  /** Movement trick 0..9: crazy-eyes, chatter, slow-scan, peek-a-boo, double-blink, jaw-drop, drowsy, side-eye, happy-bounce, confused. */
  async playMovementTrick(index: number): Promise<void> {
    if (!this.isConnected) return
    await this.write(`W${index}\n`)
  }

  /** LED on D8: 0=off, 1=solid, 2=slow pulse, 3=fast blink. */
  async setLedPattern(pattern: number): Promise<void> {
    if (!this.isConnected) return
    const clamped = Math.min(3, Math.max(0, Math.round(pattern)))
    await this.write(`C${clamped}\n`)
  }

  // ── Heartbeat ──
  // H\n every 2 s keeps the HM-10 link alive. Like the phone, we never
  // disconnect on missing replies (clones echo writes back, so "OK" can't be
  // told apart from an echo) — real drops fire gattserverdisconnected.

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) return
      void this.write('H\n')
    }, 2000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }
}

export const robotFaceBle = new RobotFaceBle()
