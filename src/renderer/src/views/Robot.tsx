import {
  useState,
  useEffect,
  useRef,
  useSyncExternalStore,
  useCallback,
  type ReactElement
} from 'react'
import {
  RiBluetoothLine,
  RiWifiLine,
  RiCameraLine,
  RiFlashlightLine,
  RiRobot2Line,
  RiEyeLine,
  RiCloseLine,
  RiRestartLine,
  RiPulseLine,
  RiStopCircleLine,
  RiArrowUpLine,
  RiArrowDownLine,
  RiVolumeUpLine
} from 'react-icons/ri'

import {
  robotController,
  EXPRESSION_LABELS,
  ANIMATION_LABELS,
  TRICK_LABELS,
  LED_PATTERN_LABELS,
  SOUND_CUES,
  V2_LIMITS
} from '@renderer/services/robot-controller'
import { robotFaceBle, type BleChooserDevice } from '@renderer/services/robot-face-ble'

const glass = 'bg-zinc-950/40 backdrop-blur-xl border border-white/5 rounded-xl'
const chipBase =
  'cursor-pointer px-3 py-1.5 text-[10px] font-bold tracking-widest rounded-md transition-all duration-200 border'
const chipOff = `${chipBase} text-zinc-500 border-white/5 hover:text-zinc-200 hover:bg-white/5`
const chipOn = `${chipBase} bg-red-500/20 text-red-400 border-red-500/30`
const sectionTitle = 'text-[10px] font-bold tracking-[0.2em] text-zinc-500 mb-2'

const EXPRESSION_EMOJI = ['😊', '😠', '😢', '🤔', '😴', '😲', '😍', '🤩', '😕', '😨']

const StateChip = ({ state }: { state: string }): ReactElement => {
  const cfg =
    state === 'connected'
      ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
      : state === 'connecting'
        ? 'text-amber-400 border-amber-500/30 bg-amber-500/10 animate-pulse'
        : 'text-zinc-500 border-white/10 bg-white/5'
  return (
    <span className={`px-2 py-0.5 rounded text-[9px] font-bold tracking-widest border ${cfg}`}>
      {state.toUpperCase()}
    </span>
  )
}

const Slider = ({
  label,
  min,
  max,
  value,
  onChange,
  onCommit,
  disabled
}: {
  label: string
  min: number
  max: number
  value: number
  onChange: (v: number) => void
  onCommit?: (v: number) => void
  disabled?: boolean
}): ReactElement => (
  <div className={`flex items-center gap-3 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
    <span className="text-[10px] font-bold tracking-widest text-zinc-500 w-16 shrink-0">
      {label}
    </span>
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onMouseUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      onTouchEnd={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      className="flex-1 accent-red-500 h-1"
    />
    <span className="text-[10px] font-mono text-zinc-400 w-8 text-right">{value}</span>
  </div>
)

const Toggle = ({
  label,
  on,
  onChange,
  disabled
}: {
  label: string
  on: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): ReactElement => (
  <button
    onClick={() => onChange(!on)}
    disabled={disabled}
    className={`${on ? chipOn : chipOff} ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
  >
    {label} {on ? 'ON' : 'OFF'}
  </button>
)

// ── Eye pad: drag to aim the robot's eyes ───────────────────────────────────
const EyePad = ({ disabled }: { disabled: boolean }): ReactElement => {
  const padRef = useRef<HTMLDivElement>(null)
  const [dot, setDot] = useState({ x: 0.5, y: 0.5 })
  const dragging = useRef(false)

  const sendFromPointer = useCallback((clientX: number, clientY: number) => {
    const pad = padRef.current
    if (!pad) return
    const rect = pad.getBoundingClientRect()
    const nx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const ny = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
    setDot({ x: nx, y: ny })
    // Firmware: eyeLR 0=right,180=left · eyeUD 0=up,180=down.
    // Dragging toward the pad's left aims the eyes to the robot's left.
    robotController.lookAt(Math.round((1 - nx) * 180), Math.round(ny * 180))
  }, [])

  return (
    <div className={disabled ? 'opacity-40 pointer-events-none' : ''}>
      <div
        ref={padRef}
        onPointerDown={(e) => {
          dragging.current = true
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          sendFromPointer(e.clientX, e.clientY)
        }}
        onPointerMove={(e) => dragging.current && sendFromPointer(e.clientX, e.clientY)}
        onPointerUp={() => (dragging.current = false)}
        className="relative w-full h-32 rounded-lg border border-white/10 bg-black/40 cursor-crosshair touch-none"
      >
        <div className="absolute inset-0 flex items-center justify-center text-zinc-700">
          <RiEyeLine size={20} />
        </div>
        <div
          className="absolute w-3 h-3 rounded-full bg-red-500 shadow-[0_0_10px_rgba(var(--brutus-accent-c),0.8)] -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left: `${dot.x * 100}%`, top: `${dot.y * 100}%` }}
        />
      </div>
      <button
        onClick={() => {
          setDot({ x: 0.5, y: 0.5 })
          robotController.lookAt(90, 90, true)
        }}
        className={`${chipOff} mt-2 w-full text-center`}
      >
        CENTER EYES
      </button>
    </div>
  )
}

// ── BLE device picker modal ─────────────────────────────────────────────────
const BlePickerModal = ({
  devices,
  onPick,
  onCancel
}: {
  devices: BleChooserDevice[]
  onPick: (id: string) => void
  onCancel: () => void
}): ReactElement => (
  <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
    <div className={`${glass} w-[420px] max-h-[70%] flex flex-col border-red-500/30 shadow-2xl`}>
      <div className="flex items-center justify-between p-4 border-b border-white/5 bg-white/5">
        <span className="text-xs font-bold tracking-widest text-red-400 flex items-center gap-2">
          <RiBluetoothLine className="animate-pulse" /> SCANNING FOR ROBOT
        </span>
        <button onClick={onCancel} className="cursor-pointer text-zinc-500 hover:text-white">
          <RiCloseLine />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {devices.length === 0 && (
          <div className="p-6 text-center text-[11px] text-zinc-500 tracking-widest animate-pulse">
            SEARCHING… POWER ON THE ROBOT
          </div>
        )}
        {devices.map((d) => (
          <button
            key={d.deviceId}
            onClick={() => onPick(d.deviceId)}
            className={`w-full text-left px-4 py-3 rounded-lg mb-1 border transition-all cursor-pointer ${
              d.likelyRobot
                ? 'border-red-500/30 bg-red-500/10 hover:bg-red-500/20'
                : 'border-white/5 hover:bg-white/5'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-zinc-200">{d.deviceName}</span>
              {d.likelyRobot && (
                <span className="text-[9px] font-bold tracking-widest text-red-400">
                  ● LIKELY ROBOT
                </span>
              )}
            </div>
            <span className="text-[9px] font-mono text-zinc-600">{d.deviceId}</span>
          </button>
        ))}
      </div>
      <div className="p-3 border-t border-white/5 text-[9px] text-zinc-600 tracking-wider">
        HM-10 modules usually appear as HMSoft, BT05 or MLT-BT05
      </div>
    </div>
  </div>
)

// ═════════════════════════════════════════════════════════════════════════════

const RobotView = (): ReactElement => {
  const snap = useSyncExternalStore(robotController.subscribe, robotController.getSnapshot)

  // Face controls
  const [intensity, setIntensity] = useState(100)
  const [mouth, setMouth] = useState(90)
  const [ledPattern, setLedPatternUi] = useState(1)
  const [idleOn, setIdleOn] = useState(true)
  const [freezeOn, setFreezeOn] = useState(false)
  const [pickerDevices, setPickerDevices] = useState<BleChooserDevice[] | null>(null)
  const [bleError, setBleError] = useState('')

  // V2 controls
  const [v2Ip, setV2Ip] = useState(localStorage.getItem('brutus_robot_v2_ip') || '')
  const [v2Error, setV2Error] = useState('')
  const [driveSpeed, setDriveSpeed] = useState(150)
  const [neck, setNeck] = useState(90)
  const [eyelid, setEyelid] = useState<number>(V2_LIMITS.lidOpen)
  const [handL, setHandL] = useState(90)
  const [handR, setHandR] = useState(90)
  const [eyeColor, setEyeColor] = useState(0)
  const [autonomousLocal, setAutonomousLocal] = useState(false)

  // Camera
  const [camIp, setCamIp] = useState(localStorage.getItem('brutus_robot_cam_ip') || '')
  const [camOn, setCamOn] = useState(false)
  const [camNonce, setCamNonce] = useState(0)
  const [flashOn, setFlashOn] = useState(false)

  const faceConnected = snap.faceState === 'connected'
  const v2Connected = snap.v2State === 'connected'
  const anyConnected = faceConnected || v2Connected

  // Live scan results while the Web Bluetooth chooser is open, and close the
  // picker the moment the connection settles either way.
  useEffect(() => {
    const offDevices = robotFaceBle.onChooserDevices((list) => setPickerDevices(list))
    const offState = robotFaceBle.onState((s) => {
      if (s !== 'connecting') setPickerDevices(null)
    })
    return () => {
      offDevices()
      offState()
    }
  }, [])

  const startScan = async (): Promise<void> => {
    setBleError('')
    setPickerDevices([])
    try {
      await robotFaceBle.scanAndConnect()
    } catch (err) {
      setBleError(err instanceof Error ? err.message : String(err))
    }
  }

  const connectV2 = async (): Promise<void> => {
    setV2Error('')
    localStorage.setItem('brutus_robot_v2_ip', v2Ip)
    const res = await robotController.connectV2(v2Ip)
    if (!res?.ok) setV2Error(res?.error || 'Connection failed.')
  }

  const camBase = (): string => {
    let ip = camIp
      .trim()
      .replace(/^\w+:\/\//, '')
      .split('/')[0]
    if (!ip.includes(':')) ip = `${ip}:81`
    return `http://${ip}`
  }

  const toggleFlash = async (): Promise<void> => {
    const next = !flashOn
    setFlashOn(next)
    try {
      await fetch(`${camBase()}/flash?on=${next ? 1 : 0}`)
    } catch {
      /* cam offline — stream panel already shows it */
    }
  }

  const telem = snap.v2Telemetry
  // Telemetry's #MODE reply is authoritative; the local flag covers the gap
  // between tapping the toggle and the robot confirming.
  const autonomous = telem.autonomous ?? autonomousLocal

  return (
    <div className="h-full w-full overflow-y-auto p-6 relative">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <RiRobot2Line className="text-red-500 text-2xl" />
          <div className="flex flex-col leading-none">
            <span className="font-black tracking-[0.2em] text-sm text-zinc-100">ROBOT COMMAND</span>
            <span className="text-[10px] font-mono text-red-500/60 tracking-widest">
              DIRECT LINK — NO PHONE REQUIRED
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[9px] font-bold tracking-widest text-zinc-600">
            AUTO-DRIVE (VOICE → FACE)
          </span>
          <Toggle
            label="AUTO"
            on={snap.autoDrive}
            onChange={(v) => robotController.setAutoDrive(v)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        {/* ── Column 1: connections ── */}
        <div className="flex flex-col gap-4">
          {/* Face robot */}
          <div className={`${glass} p-4`}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold tracking-widest text-zinc-300 flex items-center gap-2">
                <RiBluetoothLine className="text-blue-400" /> FACE ROBOT · BLE
              </span>
              <StateChip state={snap.faceState} />
            </div>
            {faceConnected ? (
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-mono text-zinc-400">{snap.faceName}</span>
                <button onClick={() => robotFaceBle.disconnect()} className={chipOff}>
                  DISCONNECT
                </button>
              </div>
            ) : (
              <button
                onClick={startScan}
                disabled={snap.faceState === 'connecting'}
                className={`${chipOn} w-full text-center py-2 ${
                  snap.faceState === 'connecting' ? 'opacity-50 pointer-events-none' : ''
                }`}
              >
                {snap.faceState === 'connecting' ? 'CONNECTING…' : 'SCAN & CONNECT'}
              </button>
            )}
            {bleError && <div className="mt-2 text-[10px] text-amber-400">{bleError}</div>}
          </div>

          {/* V2 rover */}
          <div className={`${glass} p-4`}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold tracking-widest text-zinc-300 flex items-center gap-2">
                <RiWifiLine className="text-emerald-400" /> V2 ROVER · WIFI
              </span>
              <div className="flex items-center gap-2">
                {v2Connected && (
                  <span className="text-[9px] font-mono text-emerald-400">
                    {snap.v2LatencyMs} ms
                  </span>
                )}
                <StateChip state={snap.v2State} />
              </div>
            </div>
            <div className="flex gap-2">
              <input
                value={v2Ip}
                onChange={(e) => setV2Ip(e.target.value)}
                placeholder="ESP1 IP — e.g. 192.168.1.50"
                className="flex-1 bg-black/40 border border-white/10 rounded-md px-3 py-1.5 text-[11px] font-mono text-zinc-200 outline-none focus:border-red-500/50"
              />
              {v2Connected ? (
                <button onClick={() => robotController.disconnectV2()} className={chipOff}>
                  DROP
                </button>
              ) : (
                <button
                  onClick={connectV2}
                  disabled={snap.v2State === 'connecting' || !v2Ip.trim()}
                  className={`${chipOn} ${
                    snap.v2State === 'connecting' || !v2Ip.trim()
                      ? 'opacity-50 pointer-events-none'
                      : ''
                  }`}
                >
                  {snap.v2State === 'connecting' ? '…' : 'LINK'}
                </button>
              )}
            </div>
            {v2Error && <div className="mt-2 text-[10px] text-amber-400">{v2Error}</div>}

            {v2Connected && (
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                {[
                  {
                    label: 'DIST',
                    value: telem.distanceCm !== null ? `${telem.distanceCm}cm` : '—'
                  },
                  { label: 'MOOD', value: telem.mood || '—' },
                  { label: 'RSSI', value: telem.rssi !== null ? `${telem.rssi}` : '—' },
                  { label: 'IP', value: telem.ip || snap.v2Host || '—' }
                ].map((t) => (
                  <div
                    key={t.label}
                    className="bg-black/40 rounded-md px-1 py-1.5 border border-white/5"
                  >
                    <div className="text-[8px] font-bold tracking-widest text-zinc-600">
                      {t.label}
                    </div>
                    <div className="text-[9px] font-mono text-zinc-300 truncate">{t.value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Camera */}
          <div className={`${glass} p-4`}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold tracking-widest text-zinc-300 flex items-center gap-2">
                <RiCameraLine className="text-purple-400" /> ROBOT EYES · ESP32-CAM
              </span>
              {camOn && (
                <button onClick={toggleFlash} className={flashOn ? chipOn : chipOff}>
                  <RiFlashlightLine className="inline" /> FLASH
                </button>
              )}
            </div>
            <div className="flex gap-2 mb-3">
              <input
                value={camIp}
                onChange={(e) => setCamIp(e.target.value)}
                placeholder="CAM IP — e.g. 192.168.1.51"
                className="flex-1 bg-black/40 border border-white/10 rounded-md px-3 py-1.5 text-[11px] font-mono text-zinc-200 outline-none focus:border-red-500/50"
              />
              <button
                onClick={() => {
                  if (!camOn) localStorage.setItem('brutus_robot_cam_ip', camIp)
                  setCamOn(!camOn)
                  setCamNonce((n) => n + 1)
                }}
                disabled={!camIp.trim()}
                className={`${camOn ? chipOff : chipOn} ${!camIp.trim() ? 'opacity-50 pointer-events-none' : ''}`}
              >
                {camOn ? 'STOP' : 'STREAM'}
              </button>
            </div>
            {camOn && (
              <div className="relative rounded-lg overflow-hidden border border-white/10 bg-black aspect-video">
                <img
                  key={camNonce}
                  src={`${camBase()}/stream`}
                  alt="Robot camera stream"
                  className="w-full h-full object-contain"
                  onError={() => setCamOn(false)}
                />
                <button
                  onClick={() => setCamNonce((n) => n + 1)}
                  title="Reconnect stream"
                  className="absolute top-2 right-2 text-zinc-400 hover:text-white bg-black/60 rounded-md p-1.5 cursor-pointer"
                >
                  <RiRestartLine size={14} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Column 2: face & emotion (drives every connected robot) ── */}
        <div
          className={`${glass} p-4 flex flex-col gap-4 ${anyConnected ? '' : 'opacity-40 pointer-events-none'}`}
        >
          <div>
            <div className={sectionTitle}>EXPRESSIONS</div>
            <div className="grid grid-cols-5 gap-2">
              {EXPRESSION_LABELS.map((label, i) => (
                <button
                  key={label}
                  onClick={() => robotController.setExpression(i, intensity)}
                  className={`cursor-pointer flex flex-col items-center gap-1 py-2 rounded-lg border transition-all ${
                    snap.currentExpression === i
                      ? 'border-red-500/40 bg-red-500/15'
                      : 'border-white/5 hover:bg-white/5'
                  }`}
                >
                  <span className="text-lg leading-none">{EXPRESSION_EMOJI[i]}</span>
                  <span className="text-[8px] font-bold tracking-wider text-zinc-400">
                    {label.toUpperCase()}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-3">
              <Slider
                label="INTENSITY"
                min={0}
                max={100}
                value={intensity}
                onChange={setIntensity}
              />
            </div>
          </div>

          <div>
            <div className={sectionTitle}>ANIMATIONS</div>
            <div className="flex flex-wrap gap-1.5">
              {ANIMATION_LABELS.map((label, i) => (
                <button
                  key={label}
                  onClick={() => robotController.playAnimation(i)}
                  className={chipOff}
                >
                  {label.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className={sectionTitle}>TRICKS</div>
            <div className="flex flex-wrap gap-1.5">
              {TRICK_LABELS.map((label, i) => (
                <button
                  key={label}
                  onClick={() => robotController.playTrick(i)}
                  className={chipOff}
                >
                  {label.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className={sectionTitle}>EYES</div>
              <EyePad disabled={!anyConnected} />
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <div className={sectionTitle}>MOUTH</div>
                <Slider
                  label="ANGLE"
                  min={0}
                  max={180}
                  value={mouth}
                  onChange={(v) => {
                    setMouth(v)
                    if (faceConnected) void robotFaceBle.setMouth(v)
                  }}
                  onCommit={(v) => faceConnected && void robotFaceBle.setMouth(v, true)}
                />
                <div className="flex gap-1.5 mt-2">
                  <button onClick={() => robotController.blink()} className={chipOff}>
                    BLINK
                  </button>
                  <button
                    onClick={() => {
                      setMouth(90)
                      robotController.closeMouth()
                    }}
                    className={chipOff}
                  >
                    CLOSE MOUTH
                  </button>
                </div>
              </div>
              <div>
                <div className={sectionTitle}>FACE LED</div>
                <div className="flex flex-wrap gap-1.5">
                  {LED_PATTERN_LABELS.map((label, i) => (
                    <button
                      key={label}
                      onClick={() => {
                        setLedPatternUi(i)
                        robotController.setLedPattern(i)
                      }}
                      className={ledPattern === i ? chipOn : chipOff}
                    >
                      {label.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-1.5 items-center">
                {/* Idle fidgeting is a face-robot opcode; the rover's equivalent
                    is the AUTONOMOUS toggle in the body column. */}
                <Toggle
                  label="IDLE"
                  on={idleOn}
                  disabled={!faceConnected}
                  onChange={(v) => {
                    setIdleOn(v)
                    robotController.setIdleFallback(v)
                  }}
                />
                <Toggle
                  label="FREEZE"
                  on={freezeOn}
                  onChange={(v) => {
                    setFreezeOn(v)
                    robotController.setFreezeMode(v)
                  }}
                />
                {!faceConnected && (
                  <span className="text-[9px] text-zinc-600 tracking-wider">FACE ONLY</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Column 3: V2 rover body ── */}
        <div
          className={`${glass} p-4 flex flex-col gap-4 ${v2Connected ? '' : 'opacity-40 pointer-events-none'}`}
        >
          <div className="flex items-center justify-between">
            <div className={sectionTitle}>ROVER BODY</div>
            <Toggle
              label="AUTONOMOUS"
              on={autonomous}
              onChange={(v) => {
                setAutonomousLocal(v)
                robotController.setAutonomous(v)
              }}
            />
          </div>

          <div>
            <div className={sectionTitle}>DRIVE</div>
            <Slider label="SPEED" min={0} max={255} value={driveSpeed} onChange={setDriveSpeed} />
            <div className="grid grid-cols-3 gap-1.5 mt-2">
              <button
                onClick={() => robotController.drive(driveSpeed)}
                className={`${chipOff} text-center`}
              >
                <RiArrowUpLine className="inline" /> FWD
              </button>
              <button
                onClick={() => robotController.stopDrive()}
                className={`${chipBase} text-center bg-red-500/30 text-red-300 border-red-500/40 hover:bg-red-500/40`}
              >
                <RiStopCircleLine className="inline" /> STOP
              </button>
              <button
                onClick={() => robotController.drive(-driveSpeed)}
                className={`${chipOff} text-center`}
              >
                <RiArrowDownLine className="inline" /> REV
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className={sectionTitle}>SERVOS</div>
            <Slider
              label="NECK"
              min={0}
              max={180}
              value={neck}
              onChange={(v) => {
                setNeck(v)
                robotController.setNeck(v)
              }}
            />
            {/* Firmware range: 10 closed · 90 open · 128 wide (LID_* in ESP1). */}
            <Slider
              label="EYELID"
              min={V2_LIMITS.lidClosed}
              max={V2_LIMITS.lidWide}
              value={eyelid}
              onChange={(v) => {
                setEyelid(v)
                robotController.setEyelid(v)
              }}
            />
            <Slider
              label="HAND L"
              min={0}
              max={180}
              value={handL}
              onChange={(v) => {
                setHandL(v)
                robotController.setHands(v, handR)
              }}
            />
            <Slider
              label="HAND R"
              min={0}
              max={180}
              value={handR}
              onChange={(v) => {
                setHandR(v)
                robotController.setHands(handL, v)
              }}
            />
          </div>

          <div>
            <div className={sectionTitle}>EYE COLOR</div>
            <div className="flex gap-1.5">
              {['OFF', 'BLUE', 'GREEN', 'BOTH'].map((label, i) => (
                <button
                  key={label}
                  onClick={() => {
                    setEyeColor(i)
                    robotController.setEyeColor(i)
                  }}
                  className={eyeColor === i ? chipOn : chipOff}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className={sectionTitle}>VOICE BOX</div>

            {/* Mode 2 — Brutus's own TTS out of the robot's speaker. */}
            <div className="flex items-center justify-between gap-2 mb-2 bg-black/40 rounded-lg px-3 py-2 border border-white/5">
              <div className="min-w-0">
                <div className="text-[10px] font-bold tracking-widest text-zinc-300 flex items-center gap-1.5">
                  <RiVolumeUpLine className="text-emerald-400" /> SPEAK THROUGH ROBOT
                </div>
                <div className="text-[9px] text-zinc-600 leading-tight mt-0.5">
                  Brutus&apos;s voice plays from the robot, paced in real time
                </div>
              </div>
              <Toggle
                label="VOICE"
                on={snap.robotVoice}
                onChange={async (v) => {
                  const res = await robotController.setRobotVoice(v)
                  if (!res.ok && res.error) setV2Error(res.error)
                }}
              />
            </div>

            <Slider
              label="VOLUME"
              min={0}
              max={9}
              value={snap.volume}
              onChange={(v) => robotController.setVolume(v)}
            />

            <div className="flex flex-wrap gap-1.5 mt-2">
              <button onClick={() => robotController.beep(120)} className={chipOff}>
                <RiPulseLine className="inline" /> BEEP
              </button>
              {Object.keys(SOUND_CUES).map((cue) => (
                <button
                  key={cue}
                  onClick={() => robotController.soundByName(cue)}
                  className={chipOff}
                >
                  {cue.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {pickerDevices !== null && snap.faceState === 'connecting' && (
        <BlePickerModal
          devices={pickerDevices}
          onPick={(id) => void robotFaceBle.pick(id)}
          onCancel={() => void robotFaceBle.cancelScan()}
        />
      )}
    </div>
  )
}

export default RobotView
