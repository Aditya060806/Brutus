/**
 * BRUTUS Robot Controller — one facade for every robot the laptop can drive
 * -------------------------------------------------------------------------
 * Sits between the UI / voice tools and the two physical links:
 *
 *   • v1 face robot  → robotFaceBle (Web Bluetooth, this renderer)
 *   • v2 body robot  → robot-v2 main service over IPC (TCP :8082)
 *
 * Also runs the desktop's auto-drive: the same "robot follows the
 * conversation" behavior the phone has (voice status → expression/LED,
 * [EMOTION:x] tags → face, TTS amplitude → lip-sync), fed by the desktop's own
 * voice AI instead of the phone's. Mappings are copied 1:1 from the Flutter
 * app's `robot_provider.dart` so both ends of the ecosystem feel identical.
 *
 * Mouth semantics differ per robot and are normalized here:
 *   face neutral/closed = M90 (jaw servo centered), v2 closed = M0.
 */
import { robotFaceBle, type FaceBleState } from './robot-face-ble'

// ─── Protocol vocabulary (mirrors Arduino firmware + Flutter constants) ──────

export const RobotExpression = {
  happy: 0,
  angry: 1,
  sad: 2,
  thinking: 3,
  sleepy: 4,
  surprised: 5,
  love: 6,
  excited: 7,
  confused: 8,
  scared: 9
} as const

export const EXPRESSION_LABELS = [
  'Happy',
  'Angry',
  'Sad',
  'Thinking',
  'Sleepy',
  'Surprised',
  'Love',
  'Excited',
  'Confused',
  'Scared'
]

export const ANIMATION_LABELS = [
  'Nod',
  'Shake',
  'Look Around',
  'Wink',
  'Yawn',
  'Laugh',
  'Eye Roll',
  'Mouth Cycle',
  'Eye Cycle',
  'Wiggle'
]

export const TRICK_LABELS = [
  'Crazy Eyes',
  'Chatter',
  'Slow Scan',
  'Peek-a-boo',
  'Double Blink',
  'Jaw Drop',
  'Drowsy',
  'Side Eye',
  'Happy Bounce',
  'Confused'
]

export const LED_PATTERN_LABELS = ['Off', 'Solid', 'Pulse', 'Fast']

export const RobotLedPattern = { off: 0, solid: 1, pulse: 2, fastBlink: 3 } as const

/**
 * Physical servo limits burned into the V2 body firmware
 * (arduino/brutus_v2_body/robot_movement_esp1.ino §2 TUNING). The firmware
 * `constrain()`s to these, so sending a raw 0-180 would silently pin the servo
 * at an end stop — most visibly on the jaw, where MOUTH_MAX is only 70: an
 * unmapped lip-sync level saturates the mouth wide open and stops looking like
 * speech. Everything below maps a caller's 0-180 "servo space" into the range
 * the robot can actually reach, keeping 90 = centre.
 */
export const V2_LIMITS = {
  mouthMin: 0,
  mouthMax: 70, // MOUTH_MAX — jaw wide open
  neckMin: 58,
  neckMax: 122, // NECK_MIN/MAX — widest head turn
  eyeLrMin: 55,
  eyeLrMax: 125,
  eyeUdMin: 70,
  eyeUdMax: 110,
  lidClosed: 10,
  lidOpen: 90,
  lidWide: 128
} as const

/** Map a 0-180 servo-space angle into [min,max], preserving 90 as the centre. */
function mapToRange(angle: number, min: number, max: number): number {
  const a = Math.min(180, Math.max(0, angle))
  return Math.round(min + (a / 180) * (max - min))
}

/** ESP2 voice-box sound cues, relayed through ESP1's `S<cue>` command. */
export const SOUND_CUES: Record<string, string> = {
  boot: 'B',
  patrol: 'P',
  curious: 'C',
  alarm: 'A',
  relief: 'R',
  happy: 'H',
  mumble: 'M',
  silence: 'S',
  thinking: 'T',
  listening: 'L',
  error: 'E',
  success: 'K',
  notify: 'N',
  shutdown: 'D'
}

/** Map an emotion string (from the [EMOTION:xxx] tag) to an expression index. */
export function fromEmotionTag(tag: string | null | undefined): number | null {
  if (!tag) return null
  switch (tag.toLowerCase()) {
    case 'happy':
      return RobotExpression.happy
    case 'angry':
      return RobotExpression.angry
    case 'sad':
      return RobotExpression.sad
    case 'thinking':
      return RobotExpression.thinking
    case 'sleepy':
      return RobotExpression.sleepy
    case 'surprised':
      return RobotExpression.surprised
    case 'love':
    case 'loving':
      return RobotExpression.love
    case 'excited':
      return RobotExpression.excited
    case 'confused':
    case 'curious':
      return RobotExpression.confused
    case 'scared':
    case 'afraid':
    case 'fear':
      return RobotExpression.scared
    default:
      return null
  }
}

/** Expression → LED pattern (same table as the phone). */
export function toLedPattern(expr: number): number {
  switch (expr) {
    case RobotExpression.happy:
      return RobotLedPattern.solid
    case RobotExpression.angry:
    case RobotExpression.surprised:
    case RobotExpression.excited:
    case RobotExpression.scared:
      return RobotLedPattern.fastBlink
    case RobotExpression.sleepy:
      return RobotLedPattern.off
    default:
      return RobotLedPattern.pulse
  }
}

/** Find an animation/trick index from a spoken name ("nod", "crazy eyes"…). */
function indexByName(labels: string[], name: string): number | null {
  const n = name.trim().toLowerCase().replace(/[-_]/g, ' ')
  const i = labels.findIndex((l) => {
    const label = l.toLowerCase().replace(/[-_]/g, ' ')
    return label === n || label.includes(n) || n.includes(label)
  })
  return i >= 0 ? i : null
}

// ─── V2 state mirrored from the main-process service ─────────────────────────

export type V2State = 'disconnected' | 'connecting' | 'connected'

export interface V2Telemetry {
  distanceCm: number | null
  mood: string | null
  autonomous: boolean | null
  rssi: number | null
  ip: string | null
}

export interface RobotSnapshot {
  faceState: FaceBleState
  faceName: string | null
  v2State: V2State
  v2Host: string | null
  v2Telemetry: V2Telemetry
  v2LatencyMs: number
  autoDrive: boolean
  currentExpression: number
  robotVoice: boolean
  volume: number
}

type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'

/** Push payloads from the main-process robot-v2 service. */
interface V2Event {
  type?: 'state' | 'telemetry' | 'latency' | 'line'
  state?: V2State
  host?: string | null
  telemetry?: V2Telemetry
  latencyMs?: number
  line?: string
}

export interface V2ConnectResult {
  ok: boolean
  host?: string
  error?: string
}

const AUTODRIVE_KEY = 'brutus_robot_autodrive'
const ROBOT_VOICE_KEY = 'brutus_robot_voice'

class RobotController {
  private v2State: V2State = 'disconnected'
  private v2Host: string | null = null
  private v2Telemetry: V2Telemetry = {
    distanceCm: null,
    mood: null,
    autonomous: null,
    rssi: null,
    ip: null
  }
  private v2LatencyMs = 0
  private currentExpression: number = RobotExpression.thinking
  private autoDrive = localStorage.getItem(AUTODRIVE_KEY) !== 'false' // default on
  private robotVoice = localStorage.getItem(ROBOT_VOICE_KEY) === 'true' // default off
  private robotVolume = 7

  private listeners = new Set<() => void>()
  private snapshot: RobotSnapshot = this.buildSnapshot()

  // v2 mouth/eye throttles live renderer-side (mirrors the phone service) so
  // the IPC hop and TCP link never get flooded by lip-sync or a drag-pad.
  private v2LastMouth = -1
  private v2LastMouthAt = 0
  private v2LastLr = -1
  private v2LastUd = -1
  private v2LastLookAt = 0

  // Auto-drive internals
  private lastVoiceStatus: VoiceStatus | null = null
  private lastSeenEmotion: string | null = null
  private lipSyncTimer: ReturnType<typeof setInterval> | null = null
  private lipSyncData: Uint8Array<ArrayBuffer> | null = null
  private voiceSvc: { analyser: AnalyserNode | null } | null = null

  constructor() {
    window.electron?.ipcRenderer?.on('robot-v2-event', (_e: unknown, ev: V2Event) => {
      switch (ev?.type) {
        case 'state': {
          const was = this.v2State
          this.v2State = ev.state ?? this.v2State
          this.v2Host = ev.host ?? this.v2Host
          // Follow the body link: bring the speaker stream up with the robot
          // (and tear it down with it) so the user never has to re-arm it.
          if (this.robotVoice && was !== 'connected' && this.v2State === 'connected') {
            void window.electron.ipcRenderer.invoke('robot-audio-start', { host: this.v2Host })
          } else if (was === 'connected' && this.v2State !== 'connected') {
            void window.electron.ipcRenderer.invoke('robot-audio-stop')
          }
          break
        }
        case 'telemetry':
          if (ev.telemetry) this.v2Telemetry = ev.telemetry
          break
        case 'latency':
          this.v2LatencyMs = ev.latencyMs ?? this.v2LatencyMs
          break
        default:
          return
      }
      this.notify()
    })

    robotFaceBle.onState(() => {
      this.notify()
      // A robot that just connected should immediately reflect the current
      // conversation state instead of sitting frozen.
      if (robotFaceBle.isConnected && this.lastVoiceStatus) {
        this.applyVoiceStatus(this.lastVoiceStatus, true)
      }
    })

    // Fired by Brutus-voice-ai.publishBridgeState() on every state/emotion
    // change (cloud and edge engines both go through it).
    window.addEventListener('brutus-voice-state', ((e: CustomEvent) => {
      const { status, emotion } = e.detail || {}
      this.onVoiceState(status as VoiceStatus, emotion as string)
    }) as EventListener)

    // Lazy handle to the voice service for the lip-sync analyser. Dynamic
    // import avoids a static cycle (Brutus-voice-ai imports this module for
    // the control_robot tool).
    void import('./Brutus-voice-ai')
      .then((m: { brutusService?: { analyser: AnalyserNode | null } }) => {
        this.voiceSvc = m.brutusService ?? null
      })
      .catch(() => {
        this.voiceSvc = null
      })
  }

  // ── Snapshot / subscription (useSyncExternalStore-friendly) ──

  private buildSnapshot(): RobotSnapshot {
    return {
      faceState: robotFaceBle.state,
      faceName: robotFaceBle.deviceName,
      v2State: this.v2State,
      v2Host: this.v2Host,
      v2Telemetry: this.v2Telemetry,
      v2LatencyMs: this.v2LatencyMs,
      autoDrive: this.autoDrive,
      currentExpression: this.currentExpression,
      robotVoice: this.robotVoice,
      volume: this.robotVolume
    }
  }

  private notify(): void {
    this.snapshot = this.buildSnapshot()
    this.listeners.forEach((l) => l())
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  getSnapshot = (): RobotSnapshot => this.snapshot

  get faceConnected(): boolean {
    return robotFaceBle.isConnected
  }

  get v2Connected(): boolean {
    return this.v2State === 'connected'
  }

  get anyConnected(): boolean {
    return this.faceConnected || this.v2Connected
  }

  // ── Connections ──

  async connectV2(host: string): Promise<V2ConnectResult> {
    return (await window.electron.ipcRenderer.invoke('robot-v2-connect', {
      host
    })) as V2ConnectResult
  }

  async disconnectV2(): Promise<void> {
    await window.electron.ipcRenderer.invoke('robot-v2-disconnect')
  }

  private v2Send(line: string): void {
    if (!this.v2Connected) return
    void window.electron.ipcRenderer.invoke('robot-v2-send', { line })
  }

  // ── Unified commands (fan out to every connected robot) ──

  setExpression(mode: number, intensity?: number): void {
    this.currentExpression = mode
    if (this.faceConnected) {
      if (intensity !== undefined) void robotFaceBle.setExpressionWithIntensity(mode, intensity)
      else void robotFaceBle.setExpression(mode)
    }
    if (this.v2Connected) {
      this.v2Send(intensity !== undefined ? `E${mode},${Math.round(intensity)}` : `E${mode}`)
    }
    this.notify()
  }

  playAnimation(index: number): void {
    if (this.faceConnected) void robotFaceBle.playAnimation(index)
    if (this.v2Connected) this.v2Send(`A${index}`)
  }

  playTrick(index: number): void {
    if (this.faceConnected) void robotFaceBle.playMovementTrick(index)
    if (this.v2Connected) this.v2Send(`W${index}`)
  }

  playAnimationByName(name: string): boolean {
    const a = indexByName(ANIMATION_LABELS, name)
    if (a !== null) {
      this.playAnimation(a)
      return true
    }
    const t = indexByName(TRICK_LABELS, name)
    if (t !== null) {
      this.playTrick(t)
      return true
    }
    return false
  }

  blink(): void {
    if (this.faceConnected) void robotFaceBle.blink()
    if (this.v2Connected) this.v2Send('B')
  }

  /**
   * level 0..1 → per-robot mouth angle. The two robots have different jaw
   * geometry: the v1 face servo rests at 90 and opens toward 180, while the v2
   * jaw rests at 0 and only opens to MOUTH_MAX (70).
   */
  setMouthLevel(level: number): void {
    const l = Math.min(1, Math.max(0, level))
    if (this.faceConnected) {
      const angle = l < 0.05 ? 90 : Math.round(90 + l * 90)
      void robotFaceBle.setMouth(angle)
    }
    if (this.v2Connected) {
      this.v2SetMouth(
        Math.round(V2_LIMITS.mouthMin + l * (V2_LIMITS.mouthMax - V2_LIMITS.mouthMin))
      )
    }
  }

  closeMouth(): void {
    if (this.faceConnected) void robotFaceBle.closeMouth()
    if (this.v2Connected) {
      this.v2LastMouth = 0
      this.v2Send('M0')
    }
  }

  lookAt(lr: number, ud: number, force = false): void {
    if (this.faceConnected) void robotFaceBle.lookAt(lr, ud, force)
    if (this.v2Connected) this.v2LookAt(lr, ud, force)
  }

  setLedPattern(pattern: number): void {
    if (this.faceConnected) void robotFaceBle.setLedPattern(pattern)
  }

  /**
   * Idle fidgeting. Face robot only — the V2 body firmware has no `I` opcode
   * (its idle behaviour is the AUTO/Observer engine, toggled via setAutonomous).
   */
  setIdleFallback(on: boolean): void {
    if (this.faceConnected) void robotFaceBle.setIdleFallback(on)
  }

  /**
   * Hold still — stop all autonomous motion.
   *
   * The two robots spell this very differently. On the v1 face `S<0|1>` IS the
   * freeze opcode. On the V2 body `S` means "relay a sound cue to the ESP2
   * voice box", and ESP2 reads a digit cue as a VOLUME level — so sending
   * `S1` there does not freeze anything, it drops the robot's speaker to 1/9
   * and makes Brutus sound broken. The V2 equivalent is leaving the Observer
   * engine (Z0 = manual) and stopping the drive motor.
   */
  setFreezeMode(on: boolean): void {
    if (this.faceConnected) void robotFaceBle.setFreezeMode(on)
    if (this.v2Connected && on) {
      this.v2Send('Z0') // manual mode — stops the autonomous roaming engine
      this.v2Send('V0') // and stop the wheels
    }
  }

  // ── V2-only commands ──

  private v2SetMouth(angle: number, force = false): void {
    const a = Math.min(V2_LIMITS.mouthMax, Math.max(V2_LIMITS.mouthMin, Math.round(angle)))
    if (!force) {
      if (this.v2LastMouth >= 0 && Math.abs(a - this.v2LastMouth) < 3) return
      const now = Date.now()
      if (now - this.v2LastMouthAt < 25) return
      this.v2LastMouthAt = now
    }
    this.v2LastMouth = a
    this.v2Send(`M${a}`)
  }

  private v2LookAt(lr: number, ud: number, force = false): void {
    // Callers speak 0-180 servo space; the v2 eyes physically reach far less.
    const l = mapToRange(lr, V2_LIMITS.eyeLrMin, V2_LIMITS.eyeLrMax)
    const u = mapToRange(ud, V2_LIMITS.eyeUdMin, V2_LIMITS.eyeUdMax)
    if (!force) {
      if (
        this.v2LastLr >= 0 &&
        Math.abs(l - this.v2LastLr) < 4 &&
        Math.abs(u - this.v2LastUd) < 4
      ) {
        return
      }
      const now = Date.now()
      if (now - this.v2LastLookAt < 33) return
      this.v2LastLookAt = now
    }
    this.v2LastLr = l
    this.v2LastUd = u
    this.v2Send(`L${l},${u}`)
  }

  /** Z1 = autonomous Observer roaming, Z0 = app-driven. */
  setAutonomous(on: boolean): void {
    this.v2Send(`Z${on ? 1 : 0}`)
  }

  /** Neck angle in 0-180 servo space, mapped into the firmware's 58-122 sweep. */
  setNeck(angle: number): void {
    this.v2Send(`N${mapToRange(angle, V2_LIMITS.neckMin, V2_LIMITS.neckMax)}`)
  }

  /** Eyelid takes a raw firmware value (10 closed · 90 open · 128 wide). */
  setEyelid(angle: number): void {
    const a = Math.min(V2_LIMITS.lidWide, Math.max(V2_LIMITS.lidClosed, Math.round(angle)))
    this.v2Send(`D${a}`)
  }

  setHands(left: number, right: number): void {
    const l = Math.min(180, Math.max(0, Math.round(left)))
    const r = Math.min(180, Math.max(0, Math.round(right)))
    this.v2Send(`J${l},${r}`)
  }

  /** Signed drive speed −255..255 (0 stops). */
  drive(speed: number): void {
    this.v2Send(`V${Math.min(255, Math.max(-255, Math.round(speed)))}`)
  }

  stopDrive(): void {
    this.v2Send('V0')
  }

  /** Eye-LED colour: 0 off · 1 blue · 2 green · 3 both. */
  setEyeColor(c: number): void {
    this.v2Send(`G${Math.min(3, Math.max(0, Math.round(c)))}`)
  }

  buzzer(on: boolean): void {
    this.v2Send(`U${on ? 1 : 0}`)
  }

  beep(ms: number): void {
    this.v2Send(`P${Math.min(400, Math.max(10, Math.round(ms)))}`)
  }

  /** Relay a one-letter sound cue to the ESP2 voice box. */
  sound(cue: string): void {
    if (cue) this.v2Send(`S${cue[0]}`)
  }

  /** Play a named ESP2 sound effect ("alarm", "success", "thinking", …). */
  soundByName(name: string): boolean {
    const cue =
      SOUND_CUES[
        String(name || '')
          .trim()
          .toLowerCase()
      ]
    if (!cue) return false
    this.sound(cue)
    return true
  }

  /** ESP2 master volume, 0-9 (relayed as a digit sound cue). */
  setVolume(level: number): void {
    const v = Math.min(9, Math.max(0, Math.round(level)))
    this.v2Send(`S${v}`)
    this.robotVolume = v
    this.notify()
  }

  get volume(): number {
    return this.robotVolume
  }

  // ── Robot speaker (Mode 2): Brutus's voice out of the robot ──────────────
  //
  // PCM is pushed to the main process, which paces it to real time before it
  // hits the ESP2 — see src/main/services/robot-audio.ts for why that matters.

  get robotVoiceEnabled(): boolean {
    return this.robotVoice
  }

  async setRobotVoice(on: boolean): Promise<{ ok: boolean; error?: string }> {
    this.robotVoice = on
    localStorage.setItem(ROBOT_VOICE_KEY, String(on))
    let res: { ok: boolean; error?: string } = { ok: true }
    if (on) {
      const host = this.v2Host || localStorage.getItem('brutus_robot_v2_ip') || ''
      res = (await window.electron.ipcRenderer.invoke('robot-audio-start', {
        host
      })) as { ok: boolean; error?: string }
      if (!res?.ok) {
        this.robotVoice = false
        localStorage.setItem(ROBOT_VOICE_KEY, 'false')
      }
    } else {
      await window.electron.ipcRenderer.invoke('robot-audio-stop')
    }
    this.notify()
    return res
  }

  /**
   * Feed one chunk of Brutus's TTS audio to the robot speaker.
   * [base64] must be 16-bit LE mono PCM at 24 kHz — the rate ESP2's I2S amp
   * runs at, and exactly what Gemini Live already streams.
   */
  pushVoicePcm(base64: string): void {
    if (!this.robotVoice || !base64) return
    void window.electron.ipcRenderer.invoke('robot-audio-push', { base64 })
  }

  /** Barge-in: drop buffered speech so the robot stops mid-sentence too. */
  flushVoiceAudio(): void {
    if (!this.robotVoice) return
    void window.electron.ipcRenderer.invoke('robot-audio-flush')
  }

  // ── Auto-drive: desktop conversation → robot face ──

  get autoDriveEnabled(): boolean {
    return this.autoDrive
  }

  setAutoDrive(on: boolean): void {
    this.autoDrive = on
    localStorage.setItem(AUTODRIVE_KEY, String(on))
    if (!on) {
      this.stopLipSync()
    } else if (this.lastVoiceStatus) {
      this.applyVoiceStatus(this.lastVoiceStatus, true)
    }
    this.notify()
  }

  private onVoiceState(status: VoiceStatus, emotion: string | null): void {
    if (!this.autoDrive || !this.anyConnected) {
      this.lastVoiceStatus = status ?? this.lastVoiceStatus
      return
    }

    if (status && status !== this.lastVoiceStatus) {
      this.applyVoiceStatus(status)
    }

    // Emotion beats mid-reply override the speaking default (phone parity).
    if (status === 'speaking' && emotion && emotion !== this.lastSeenEmotion) {
      this.lastSeenEmotion = emotion
      const expr = fromEmotionTag(emotion)
      if (expr !== null) {
        this.setExpression(expr)
        this.setLedPattern(toLedPattern(expr))
      }
    }
  }

  /** Same table as the phone's `_applyVoiceStatus`. */
  private applyVoiceStatus(status: VoiceStatus, force = false): void {
    if (!force && this.lastVoiceStatus === status) return
    this.lastVoiceStatus = status
    this.lastSeenEmotion = null

    switch (status) {
      case 'idle':
        this.setExpression(RobotExpression.thinking)
        this.lookAt(90, 90, true)
        this.closeMouth()
        this.setLedPattern(RobotLedPattern.pulse)
        this.stopLipSync()
        break
      case 'connecting':
        this.setExpression(RobotExpression.thinking)
        this.setLedPattern(RobotLedPattern.fastBlink)
        break
      case 'listening':
        this.setExpression(RobotExpression.happy)
        this.lookAt(90, 90, true)
        this.setLedPattern(RobotLedPattern.solid)
        this.stopLipSync()
        break
      case 'thinking':
        this.setExpression(RobotExpression.thinking)
        this.lookAt(60, 70, true)
        this.setLedPattern(RobotLedPattern.pulse)
        break
      case 'speaking':
        this.setExpression(RobotExpression.happy)
        this.setLedPattern(RobotLedPattern.solid)
        this.startLipSync()
        break
      case 'error':
        this.setExpression(RobotExpression.sad)
        this.blink()
        this.closeMouth()
        this.setLedPattern(RobotLedPattern.fastBlink)
        this.stopLipSync()
        break
    }
  }

  // TTS amplitude → mouth, sampled at the mouth's own 40 Hz budget from the
  // same AnalyserNode the on-screen eyes/orb use.
  private startLipSync(): void {
    if (this.lipSyncTimer) return
    this.lipSyncTimer = setInterval(() => {
      if (!this.autoDrive || !this.anyConnected) return
      const analyser = this.voiceSvc?.analyser
      if (!analyser) return
      if (!this.lipSyncData || this.lipSyncData.length !== analyser.frequencyBinCount) {
        this.lipSyncData = new Uint8Array(analyser.frequencyBinCount)
      }
      analyser.getByteFrequencyData(this.lipSyncData)
      let sum = 0
      for (let i = 0; i < this.lipSyncData.length; i++) sum += this.lipSyncData[i]
      const level = sum / this.lipSyncData.length / 255
      this.setMouthLevel(level)
    }, 25)
  }

  private stopLipSync(): void {
    if (this.lipSyncTimer) {
      clearInterval(this.lipSyncTimer)
      this.lipSyncTimer = null
      if (this.anyConnected) this.closeMouth()
    }
  }
}

export const robotController = new RobotController()
