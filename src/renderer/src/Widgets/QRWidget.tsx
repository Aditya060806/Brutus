import { useState, useEffect, useRef } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { RiCloseLine, RiQrCodeLine, RiDownloadLine } from 'react-icons/ri'

interface QRPayload {
  value: string
  label: string
  type: string
}

export default function QRWidget() {
  const [qr, setQr] = useState<QRPayload | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: any) => setQr(e.detail)
    window.addEventListener('show-qr', handler)
    return () => window.removeEventListener('show-qr', handler)
  }, [])

  if (!qr) return null

  const download = () => {
    const canvas = containerRef.current?.querySelector('canvas')
    if (!canvas) return
    const url = canvas.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `brutus_qr_${qr.type}_${Date.now()}.png`
    a.click()
  }

  return (
    <div className="fixed inset-0 z-[9060] flex items-center justify-center bg-black/80 backdrop-blur-xl animate-in fade-in duration-300">
      <div className="relative w-full max-w-sm rounded-3xl border border-red-500/30 bg-zinc-950/90 p-8 shadow-[0_0_80px_rgba(239,68,68,0.15)]">
        <button
          onClick={() => setQr(null)}
          className="absolute top-4 right-4 p-2 text-zinc-500 hover:text-white rounded-full hover:bg-white/5 transition-all"
        >
          <RiCloseLine size={22} />
        </button>

        <div className="flex items-center gap-2 mb-6">
          <RiQrCodeLine className="text-red-500" size={20} />
          <span className="text-xs font-bold tracking-[0.2em] text-red-400 uppercase">
            BRUTUS QR // {qr.type}
          </span>
        </div>

        <div
          ref={containerRef}
          className="flex items-center justify-center rounded-2xl bg-white p-5 mx-auto w-fit shadow-inner"
        >
          <QRCodeCanvas value={qr.value} size={220} level="M" />
        </div>

        <p className="mt-5 text-center text-sm text-zinc-300 font-mono break-words">{qr.label}</p>

        <button
          onClick={download}
          className="mt-6 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 text-xs font-bold tracking-widest uppercase transition-all"
        >
          <RiDownloadLine size={16} /> Save PNG
        </button>
      </div>
    </div>
  )
}
