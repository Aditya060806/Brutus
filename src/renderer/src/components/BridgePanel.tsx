import { useEffect, useState, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  RiSmartphoneLine,
  RiRefreshLine,
  RiRadarLine,
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiComputerLine
} from 'react-icons/ri'
import {
  getBridgeStatus,
  startBridge,
  stopBridge,
  setBridgeConfig,
  regenerateBridgeCode,
  onBridgeEvent,
  buildPairingPayload,
  type BridgeStatus,
  type BridgeDevice
} from '@renderer/services/bridge-client'
import { duetController } from '@renderer/services/duet-controller'

const card = 'bg-canvas border border-white/10 rounded-xl p-4 flex flex-col gap-3'
const title =
  'text-[13px] font-bold text-white tracking-widest flex items-center gap-2 uppercase'

/**
 * Phone Bridge control panel. Turns the PC into a LAN hub the Brutus phone app
 * auto-discovers and pairs with (scan the QR, or type the 6-digit code). Once
 * paired, chat + live state flow both ways as one Brutus.
 */
const BridgePanel = () => {
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [duetActive, setDuetActive] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await getBridgeStatus()
      if (s) setStatus(s)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    refresh()
    const off = onBridgeEvent((e) => {
      if (e.type === 'status') setStatus(e.payload as BridgeStatus)
      else if (e.type === 'devices')
        setStatus((prev) => (prev ? { ...prev, devices: e.payload.devices } : prev))
    })
    const offDuet = duetController.subscribe((e) => {
      if (e.kind === 'start') setDuetActive(true)
      else if (e.kind === 'stop') setDuetActive(false)
    })
    return () => {
      off()
      offDuet()
    }
  }, [refresh])

  const toggleEnabled = async (): Promise<void> => {
    if (!status) return
    setBusy(true)
    try {
      const res = status.running ? await stopBridge() : await startBridge()
      if (res?.status) setStatus(res.status)
    } finally {
      setBusy(false)
    }
  }

  const patch = async (p: Parameters<typeof setBridgeConfig>[0]): Promise<void> => {
    const s = await setBridgeConfig(p)
    if (s) setStatus(s)
  }

  const regenerate = async (): Promise<void> => {
    const s = await regenerateBridgeCode()
    if (s) setStatus(s)
  }

  const copy = (text: string): void => {
    try {
      navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  if (!status) {
    return (
      <div className={`${card} md:col-span-2`}>
        <span className={title}>
          <RiSmartphoneLine className="text-zinc-400" size={18} /> Phone Bridge
        </span>
        <p className="text-xs text-zinc-500">Loading bridge status…</p>
      </div>
    )
  }

  const phones = status.devices.filter((d) => d.role === 'mobile')
  const running = status.running

  return (
    <div className={`${card} md:col-span-2`}>
      <div className="flex justify-between items-center">
        <span className={title}>
          <RiSmartphoneLine className="text-zinc-400" size={18} /> Phone Bridge
        </span>
        {running ? (
          <span className="text-[10px] text-emerald-400 font-mono tracking-widest flex items-center gap-1 bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20">
            <RiCheckboxCircleLine /> LIVE · {status.wsPort}
          </span>
        ) : (
          <span className="text-[10px] text-zinc-400 font-mono tracking-widest flex items-center gap-1 bg-white/5 px-2 py-1 rounded border border-white/10">
            <RiErrorWarningLine /> OFFLINE
          </span>
        )}
      </div>

      <p className="text-xs text-zinc-500 -mt-1 leading-relaxed">
        Link the Brutus phone app over Wi-Fi so both share one conversation and one live state.
        Open the phone app, tap <span className="text-zinc-300">Connect to PC</span>, and scan this
        code (or enter the digits). Both devices must be on the same network.
      </p>

      {status.error && (
        <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
          {status.error}
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4">
        {/* QR + pairing */}
        <div className="flex items-center gap-4">
          <div className="bg-white rounded-lg p-2 shrink-0" title="Scan from the Brutus phone app">
            <QRCodeSVG value={buildPairingPayload(status)} size={104} level="M" />
          </div>
          <div className="flex flex-col gap-2 min-w-0">
            <div>
              <div className="text-[10px] text-zinc-500 uppercase tracking-widest">Address</div>
              <button
                onClick={() => copy(status.wsUrl)}
                className="text-sm text-zinc-200 font-mono flex items-center gap-1 hover:text-white transition-colors"
                title="Copy address"
              >
                {status.wsUrl} <RiFileCopyLine size={13} className="text-zinc-500" />
              </button>
            </div>
            <div>
              <div className="text-[10px] text-zinc-500 uppercase tracking-widest">
                Pairing code
              </div>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold text-white tracking-[0.3em] font-mono">
                  {status.pairingCode}
                </span>
                <button
                  onClick={regenerate}
                  className="text-zinc-500 hover:text-white transition-colors"
                  title="Generate a new code (disconnects paired phones)"
                >
                  <RiRefreshLine size={16} />
                </button>
              </div>
            </div>
            {copied && <span className="text-[10px] text-emerald-400">Copied</span>}
          </div>
        </div>

        {/* Devices */}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-zinc-500 uppercase tracking-widest mb-2 flex items-center gap-1">
            <RiRadarLine /> Connected ({phones.length})
          </div>
          <div className="flex flex-col gap-1.5 max-h-28 overflow-y-auto">
            <DeviceRow
              device={{
                id: status.serverId,
                name: `${status.serverName} (this PC)`,
                platform: 'desktop',
                role: 'host',
                online: true
              }}
            />
            {phones.length === 0 ? (
              <span className="text-[11px] text-zinc-600 italic">No phones paired yet.</span>
            ) : (
              phones.map((d) => <DeviceRow key={d.id} device={d} />)
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          onClick={toggleEnabled}
          disabled={busy}
          className={`cursor-pointer px-4 h-10 flex items-center justify-center text-[12px] font-bold rounded-lg transition-all tracking-widest border ${
            running
              ? 'bg-canvas border-white/10 text-zinc-300 hover:border-red-500/40 hover:text-red-300'
              : 'bg-white text-black border-white shadow-[0_0_15px_rgba(255,255,255,0.2)]'
          }`}
        >
          {running ? 'STOP BRIDGE' : 'START BRIDGE'}
        </button>

        <button
          onClick={() => (duetActive ? duetController.stop() : duetController.start())}
          disabled={!running}
          title="Have PC-Brutus and Robo-Brutus talk to each other"
          className={`cursor-pointer px-4 h-10 flex items-center justify-center gap-2 text-[12px] font-bold rounded-lg transition-all tracking-widest border disabled:opacity-40 disabled:cursor-not-allowed ${
            duetActive
              ? 'bg-red-500/20 border-red-500/50 text-red-200 animate-pulse'
              : 'bg-gradient-to-r from-cyan-500/20 to-red-500/20 border-white/20 text-white hover:border-white/40'
          }`}
        >
          {duetActive ? 'STOP DUET' : '✦ DUET'}
        </button>

        <ToggleChip
          active={status.orchestrate}
          onClick={() => patch({ orchestrate: !status.orchestrate })}
          label="PC ANSWERS PHONE"
          hint="Let the desktop brain reply to messages sent from the phone"
        />
        <ToggleChip
          active={status.requirePairing}
          onClick={() => patch({ requirePairing: !status.requirePairing })}
          label="REQUIRE CODE"
          hint="Require the pairing code before a phone can connect"
        />
      </div>
    </div>
  )
}

const DeviceRow = ({ device }: { device: BridgeDevice }) => (
  <div className="flex items-center gap-2 bg-canvas border border-white/5 rounded px-2 py-1.5">
    {device.role === 'host' ? (
      <RiComputerLine className="text-zinc-400 shrink-0" size={14} />
    ) : (
      <RiSmartphoneLine className="text-emerald-400 shrink-0" size={14} />
    )}
    <span className="text-[12px] text-zinc-300 truncate">{device.name}</span>
    <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
  </div>
)

const ToggleChip = ({
  active,
  onClick,
  label,
  hint
}: {
  active: boolean
  onClick: () => void
  label: string
  hint: string
}) => (
  <button
    onClick={onClick}
    title={hint}
    className={`cursor-pointer px-3 h-10 flex items-center justify-center text-[11px] font-bold rounded-lg transition-all tracking-widest border ${
      active
        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
        : 'bg-canvas border-white/10 text-zinc-500 hover:text-white hover:border-white/30'
    }`}
  >
    {label}
  </button>
)

export default BridgePanel
