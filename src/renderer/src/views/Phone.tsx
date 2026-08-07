import { useState, useEffect, useRef } from 'react'
import {
  RiWifiLine,
  RiSmartphoneLine,
  RiSignalWifi3Line,
  RiBattery2ChargeLine,
  RiDatabase2Line,
  RiShutDownLine,
  RiCameraLensLine,
  RiLockPasswordLine,
  RiSunLine,
  RiHome5Line,
  RiAddLine,
  RiDeleteBin6Line,
  RiTerminalBoxLine
} from 'react-icons/ri'
import BridgePanel from '@renderer/components/BridgePanel'
import { Button, Input } from '@renderer/components/ui'

/** A saved device, as stored in `userData/Connected Devices/Connect-mobile.json`. */
interface AdbDevice {
  ip: string
  port: string | number
  model?: string
  lastConnected?: string
}

const PhoneView = () => {
  const [ip, setIp] = useState(() => localStorage.getItem('brutus_adb_ip') || '')
  const [port, setPort] = useState(() => localStorage.getItem('brutus_adb_port') || '5555')
  const [nickname, setNickname] = useState('')
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected'>('idle')
  const [showAdd, setShowAdd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [deviceHistory, setDeviceHistory] = useState<AdbDevice[]>([])
  const [copied, setCopied] = useState(false)

  const screenRef = useRef<HTMLImageElement>(null)
  const isStreaming = useRef(false)
  const knownNotifs = useRef<string[]>([])
  const hasAutoConnected = useRef(false)

  const [telemetry, setTelemetry] = useState({
    model: 'UNKNOWN DEVICE',
    os: 'ANDROID --',
    battery: { level: 0, isCharging: false, temp: '0.0' },
    storage: { used: '0 GB', total: '0 GB TOTAL', percent: 0 }
  })

  useEffect(() => {
    window.electron.ipcRenderer.invoke('adb-get-history').then((data) => {
      setDeviceHistory(Array.isArray(data) ? data : [])

      if (data.length > 0 && !hasAutoConnected.current) {
        hasAutoConnected.current = true

        const lastDevice = data[data.length - 1]

        if (lastDevice && lastDevice.ip) {
          setIp(lastDevice.ip)
          setPort(lastDevice.port)
          connectToDevice(lastDevice.ip, lastDevice.port)
        }
      }
    })
  }, [])

  const checkNotifications = async () => {
    try {
      const res = await window.electron.ipcRenderer.invoke('adb-get-notifications')
      if (res.success && res.data) {
        const currentNotifs: string[] = res.data

        if (knownNotifs.current.length === 0) {
          knownNotifs.current = currentNotifs
          return
        }

        const newNotifs = currentNotifs.filter((n) => !knownNotifs.current.includes(n))

        if (newNotifs.length > 0) {
          window.dispatchEvent(
            new CustomEvent('ai-force-speak', {
              detail: `System Alert: The user just received a new mobile notification. Announce it out loud briefly: "${newNotifs[0]}"`
            })
          )
          knownNotifs.current = currentNotifs
        }
      }
    } catch (e) {}
  }

  const connectToDevice = async (targetIp: string, targetPort: string) => {
    if (!targetIp || !targetPort) return setErrorMsg('IP and Port are required.')
    setStatus('connecting')
    setErrorMsg('')

    try {
      const res = await window.electron.ipcRenderer.invoke('adb-connect', {
        ip: targetIp,
        port: targetPort
      })
      if (res.success) {
        setStatus('connected')
        isStreaming.current = true
        fetchTelemetry()
        startScreenStream()
      } else {
        setStatus('idle')
        setErrorMsg('Connection refused. Ensure TCP/IP daemon is running (adb tcpip 5555).')
      }
    } catch (e) {
      setStatus('idle')
      setErrorMsg('Electron IPC Error.')
    }
  }

  const handleDisconnect = async () => {
    isStreaming.current = false
    try {
      await window.electron.ipcRenderer.invoke('adb-disconnect')
    } catch (e) {}
    setStatus('idle')
    if (screenRef.current) screenRef.current.src = ''
  }

  const executeQuickCommand = async (action: 'camera' | 'wake' | 'lock' | 'home') => {
    try {
      await window.electron.ipcRenderer.invoke('adb-quick-action', { action })
    } catch (e) {}
  }

  const fetchTelemetry = async () => {
    try {
      const res = await window.electron.ipcRenderer.invoke('adb-telemetry')
      if (res.success) setTelemetry(res.data)
    } catch (e) {}
  }

  const startScreenStream = async () => {
    if (!isStreaming.current) return
    try {
      const res = await window.electron.ipcRenderer.invoke('adb-screenshot')
      if (res.success && res.image && screenRef.current) {
        screenRef.current.src = res.image
      }
    } catch (e) {}

    if (isStreaming.current) {
      requestAnimationFrame(startScreenStream)
    }
  }

  const handleCopyCommand = () => {
    navigator.clipboard.writeText('adb tcpip 5555')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  useEffect(() => {
    let interval: any
    if (status === 'connected') {
      interval = setInterval(() => {
        fetchTelemetry()
        checkNotifications()
      }, 3000)
    }
    return () => clearInterval(interval)
  }, [status])

  // ── Device list management ───────────────────────────────────────────────

  const refreshDevices = async (): Promise<void> => {
    const data = await window.electron.ipcRenderer.invoke('adb-get-history')
    setDeviceHistory(Array.isArray(data) ? data : [])
  }

  const saveDevice = async (): Promise<void> => {
    const cleanIp = ip.trim()
    if (!cleanIp) {
      setErrorMsg('Enter the phone’s IP address.')
      return
    }
    setSaving(true)
    setErrorMsg('')
    try {
      const res = await window.electron.ipcRenderer.invoke('adb-save-device', {
        ip: cleanIp,
        port: port.trim() || '5555',
        model: nickname.trim()
      })
      if (res?.success) {
        setDeviceHistory(res.devices ?? [])
        setNickname('')
        setShowAdd(false)
      } else {
        setErrorMsg(res?.error || 'Could not save that device.')
      }
    } finally {
      setSaving(false)
    }
  }

  const forgetDevice = async (dev: AdbDevice): Promise<void> => {
    // Two-step, like every other destructive action in the app: the first
    // click arms the row, a second within four seconds commits.
    const key = `${dev.ip}:${dev.port}`
    if (armedDelete !== key) {
      setArmedDelete(key)
      setTimeout(() => setArmedDelete((cur) => (cur === key ? null : cur)), 4000)
      return
    }
    setArmedDelete(null)
    const res = await window.electron.ipcRenderer.invoke('adb-forget-device', {
      ip: dev.ip,
      port: String(dev.port)
    })
    if (res?.success) setDeviceHistory(res.devices ?? [])
    else await refreshDevices()
  }

  if (status !== 'connected') {
    return (
      <div className="scrollbar-small absolute inset-0 overflow-y-auto bg-canvas">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
          <header>
            <h1 className="text-[19px] font-semibold tracking-tight text-content">Phone</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-content-muted">
              Mirror and control an Android device over Wi-Fi, or pair the Brutus phone app so its
              assistant can talk to this one.
            </p>
          </header>

          {/* ── Screen control (ADB) ─────────────────────────────────────── */}
          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-[13px] font-medium text-content">Screen control</h2>
                <p className="mt-0.5 text-[11px] text-content-muted">
                  Wireless ADB — mirror the display and drive the device.
                </p>
              </div>
              <Button
                size="sm"
                variant={showAdd ? 'tertiary' : 'secondary'}
                onClick={() => {
                  setShowAdd((v) => !v)
                  setErrorMsg('')
                }}
                leadingIcon={showAdd ? undefined : <RiAddLine size={14} />}
              >
                {showAdd ? 'Cancel' : 'Add device'}
              </Button>
            </div>

            {showAdd && (
              <div className="flex flex-col gap-3 border-b border-line bg-surface-muted px-4 py-4">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={ip}
                    onChange={(e) => setIp(e.target.value)}
                    placeholder="192.168.1.42"
                    aria-label="Phone IP address"
                    spellCheck={false}
                    className="font-mono text-xs"
                    leadingIcon={<RiWifiLine size={14} />}
                  />
                  <Input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="5555"
                    aria-label="Port"
                    spellCheck={false}
                    block={false}
                    className="w-full font-mono text-xs sm:w-28"
                  />
                  <Input
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder="Name (optional)"
                    aria-label="Device name"
                    block={false}
                    className="w-full text-xs sm:w-44"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] text-content-faint">
                    The phone must have wireless debugging on. Run{' '}
                    <button
                      type="button"
                      onClick={handleCopyCommand}
                      className="cursor-pointer font-mono text-content-secondary underline decoration-line-strong underline-offset-2 hover:text-content"
                    >
                      adb tcpip 5555
                    </button>{' '}
                    once over USB. {copied && <span className="text-sage-400">Copied</span>}
                  </p>
                  <Button size="sm" loading={saving} onClick={saveDevice}>
                    Save
                  </Button>
                </div>
              </div>
            )}

            {errorMsg && (
              <div className="border-b border-line px-4 py-2.5 text-[11px] text-coral-400">
                {errorMsg}
              </div>
            )}

            {deviceHistory.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <RiSmartphoneLine size={26} className="text-content-faint" />
                <p className="text-[13px] font-medium text-content-secondary">No devices yet</p>
                <p className="max-w-xs text-[11px] leading-relaxed text-content-faint">
                  Add your phone’s IP address to mirror its screen from here.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-line-subtle">
                {deviceHistory.map((dev) => {
                  const key = `${dev.ip}:${dev.port}`
                  const linking = status === 'connecting' && ip === dev.ip
                  const armed = armedDelete === key
                  return (
                    <li key={key} className="flex items-center gap-3 px-4 py-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-muted text-content-muted">
                        <RiSmartphoneLine size={15} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-content">
                          {dev.model || 'Android device'}
                        </p>
                        <p className="truncate font-mono text-[11px] text-content-faint">{key}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={linking}
                        onClick={() => connectToDevice(dev.ip, String(dev.port))}
                      >
                        {linking ? 'Connecting' : 'Connect'}
                      </Button>
                      <Button
                        size="sm"
                        variant={armed ? 'secondary' : 'tertiary'}
                        tone="danger"
                        iconOnly={!armed}
                        aria-label={`Forget ${dev.model || key}`}
                        onClick={() => forgetDevice(dev)}
                      >
                        {armed ? 'Confirm' : <RiDeleteBin6Line size={15} />}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* ── Phone AI (LAN bridge) ────────────────────────────────────────
              The SAME component Settings → Phone Bridge renders. Mounting it
              rather than rebuilding it is the point: the bridge protocol is
              duplicated in the Flutter app and has to stay in lockstep, so
              there must be exactly one implementation of the pairing UI no
              matter which of the two places you open it from. */}
          <section className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-[13px] font-medium text-content">Phone AI</h2>
              <p className="mt-0.5 text-[11px] text-content-muted">
                Pair the Brutus phone app over your local network. Also available in Settings →
                Phone Bridge.
              </p>
            </div>
            <div className="p-4">
              <BridgePanel />
            </div>
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col lg:flex-row items-center justify-center gap-10 p-10 animate-in fade-in duration-500 bg-canvas min-h-screen overflow-y-auto">
      <div className="w-1/4 flex flex-col">
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-purple-500/10 rounded-xl border border-purple-500/30">
            <RiSmartphoneLine className="text-purple-400" size={24} />
          </div>
          <div>
            <h2 className="text-lg font-black text-white tracking-widest uppercase">
              {telemetry.model}
            </h2>
            <p className="text-[10px] text-zinc-500 font-mono tracking-widest uppercase">
              {telemetry.os}
            </p>
          </div>
        </div>

        <div className="flex justify-between text-[10px] font-mono text-cyan-500 border-b border-white/5 pb-4 mb-4">
          <span>UPTIME: LIVE</span>
          <span className="text-orange-500">TEMP: {telemetry.battery.temp}°C</span>
        </div>

        <h3 className="text-fuchsia-500 font-bold tracking-widest text-sm text-center my-6 drop-shadow-[0_0_10px_rgba(217,70,239,0.5)]">
          DEVICE TELEMETRY
        </h3>

        <div className="flex flex-col gap-4">
          <div className="bg-surface border border-white/5 rounded-2xl p-5 hover:border-purple-500/30 transition-all">
            <div className="flex justify-between items-center mb-3">
              <span className="text-[10px] font-bold text-zinc-500 tracking-widest">NETWORK</span>
              <RiSignalWifi3Line className="text-purple-500" />
            </div>
            <h4 className="text-2xl font-black text-white">ACTIVE</h4>
            <span className="text-[10px] font-mono text-zinc-500">TCP/IP BRIDGE</span>
          </div>

          <div className="bg-surface border border-white/5 rounded-2xl p-5 hover:border-purple-500/30 transition-all">
            <div className="flex justify-between items-center mb-3">
              <span className="text-[10px] font-bold text-zinc-500 tracking-widest">BATTERY</span>
              <RiBattery2ChargeLine className="text-red-500" />
            </div>
            <div className="flex justify-between items-end mb-2">
              <h4 className="text-3xl font-black text-white">{telemetry.battery.level}%</h4>
              <span className="text-[10px] font-mono text-red-500">
                {telemetry.battery.isCharging ? 'CHARGING' : 'DISCHARGING'}
              </span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-red-500 h-1.5 shadow-[0_0_10px_rgba(var(--brutus-accent-c),0.8)]"
                style={{ width: `${telemetry.battery.level}%` }}
              ></div>
            </div>
          </div>

          <div className="bg-surface border border-white/5 rounded-2xl p-5 hover:border-purple-500/30 transition-all">
            <div className="flex justify-between items-center mb-3">
              <span className="text-[10px] font-bold text-zinc-500 tracking-widest">STORAGE</span>
              <RiDatabase2Line className="text-orange-500" />
            </div>
            <div className="flex justify-between items-end mb-2">
              <h4 className="text-3xl font-black text-white">{telemetry.storage.used}</h4>
              <span className="text-[10px] font-mono text-zinc-500">{telemetry.storage.total}</span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-orange-500 h-1.5 shadow-[0_0_10px_rgba(249,115,22,0.8)]"
                style={{ width: `${telemetry.storage.percent}%` }}
              ></div>
            </div>
          </div>
        </div>
      </div>

      <div className="w-1/3 flex justify-center relative">
        <div className="w-full max-w-[320px] h-162.5 bg-black rounded-[3rem] border-12 border-elevated shadow-[0_0_50px_rgba(168,85,247,0.1)] relative overflow-hidden flex flex-col">
          <div className="absolute top-2 left-1/2 -translate-x-1/2 w-28 h-7 bg-black rounded-full z-20 flex items-center justify-end px-3 gap-2 shadow-md">
            <div className="w-2 h-2 rounded-full bg-purple-500/50"></div>
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
          </div>
          <img ref={screenRef} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_20px_rgba(0,0,0,0.8)]"></div>
        </div>
      </div>

      <div className="w-1/4 flex flex-col h-162.5 relative">
        <div className="bg-surface border border-white/5 rounded-2xl p-6 flex flex-col h-full shadow-lg">
          <div className="flex items-center gap-3 mb-8 pb-4 border-b border-white/5">
            <div className="p-2 bg-purple-500/10 rounded-lg">
              <RiTerminalBoxLine className="text-purple-400" size={20} />
            </div>
            <div>
              <h3 className="text-xs font-bold text-white tracking-widest uppercase">
                SYSTEM CONTROLS
              </h3>
              <span className="text-[10px] text-purple-400 font-mono flex items-center gap-1">
                NEURAL UPLINK SECURED
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-auto">
            <button
              onClick={() => executeQuickCommand('camera')}
              className="group flex flex-col items-center justify-center gap-3 p-6 bg-black/50 border border-white/5 hover:border-purple-500/50 hover:bg-purple-500/10 rounded-2xl transition-all"
            >
              <RiCameraLensLine
                size={28}
                className="text-zinc-500 group-hover:text-purple-400 transition-colors"
              />
              <span className="text-[10px] font-bold text-white tracking-widest">CAMERA</span>
            </button>
            <button
              onClick={() => executeQuickCommand('lock')}
              className="group flex flex-col items-center justify-center gap-3 p-6 bg-black/50 border border-white/5 hover:border-purple-500/50 hover:bg-purple-500/10 rounded-2xl transition-all"
            >
              <RiLockPasswordLine
                size={28}
                className="text-zinc-500 group-hover:text-purple-400 transition-colors"
              />
              <span className="text-[10px] font-bold text-white tracking-widest">LOCK</span>
            </button>
            <button
              onClick={() => executeQuickCommand('wake')}
              className="group flex flex-col items-center justify-center gap-3 p-6 bg-black/50 border border-white/5 hover:border-purple-500/50 hover:bg-purple-500/10 rounded-2xl transition-all"
            >
              <RiSunLine
                size={28}
                className="text-zinc-500 group-hover:text-purple-400 transition-colors"
              />
              <span className="text-[10px] font-bold text-white tracking-widest">WAKE</span>
            </button>
            <button
              onClick={() => executeQuickCommand('home')}
              className="group flex flex-col items-center justify-center gap-3 p-6 bg-black/50 border border-white/5 hover:border-purple-500/50 hover:bg-purple-500/10 rounded-2xl transition-all"
            >
              <RiHome5Line
                size={28}
                className="text-zinc-500 group-hover:text-purple-400 transition-colors"
              />
              <span className="text-[10px] font-bold text-white tracking-widest">HOME</span>
            </button>
          </div>

          <div className="mb-6 p-4 bg-purple-500/5 border border-purple-500/20 rounded-xl">
            <p className="text-[10px] text-purple-400 font-mono leading-relaxed text-center">
              BRUTUS is listening via the primary neural audio interface. Voice commands for app
              execution are online.
            </p>
          </div>

          <button
            onClick={handleDisconnect}
            className="w-full py-4 bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white font-bold rounded-xl tracking-widest transition-all duration-300 border border-red-500/30 flex items-center justify-center gap-3"
          >
            <RiShutDownLine size={20} /> SEVER CONNECTION
          </button>
        </div>
      </div>
    </div>
  )
}

export default PhoneView
