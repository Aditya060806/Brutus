import { useMemo, useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cpu, TerminalSquare, Network, Fingerprint, Activity, Database, Lock } from 'lucide-react'
import { FcGoogle } from 'react-icons/fc'

const normalizeBackendUrl = (url?: string) => (url || '').trim().replace(/\/+$/, '')

export default function LoginPage() {
  const backendBaseUrl = useMemo(
    () => normalizeBackendUrl(import.meta.env.VITE_BACKEND_KEY || import.meta.env.VITE_BACKEND_URL),
    []
  )

  const missingBackendMessage =
    'BRUTUS backend URL is missing. Set VITE_BACKEND_KEY in your renderer environment.'

  const [errorMessage, setErrorMessage] = useState(backendBaseUrl ? '' : missingBackendMessage)
  const [bootLogs, setBootLogs] = useState<string[]>([])
  const [isReady, setIsReady] = useState(false)

  const handleGoogleLogin = () => {
    if (!backendBaseUrl) {
      setErrorMessage(missingBackendMessage)
      return
    }
    setErrorMessage('')
    window.open(backendBaseUrl + '/api/v1/auth/google', '_blank')
  }

  useEffect(() => {
    const messages = [
      '> BRUTUS OS v3.7.1 booting...',
      '> Loading kernel modules...',
      '> Neural interface drivers OK',
      '> Mounting encrypted vault...',
      '> Biometric subsystem online',
      '> Network stack initialized',
      '> Auth gateway handshake...',
      '> All systems nominal.',
      '> READY FOR AUTHENTICATION'
    ]
    let i = 0
    const interval = setInterval(() => {
      if (i < messages.length) {
        setBootLogs((prev) => [...prev, messages[i]])
        i++
        if (i === messages.length) {
          setIsReady(true)
          clearInterval(interval)
        }
      }
    }, 550)
    return () => clearInterval(interval)
  }, [])

  const containerVariants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.1, delayChildren: 0.1 }
    }
  }

  const cardVariants: any = {
    hidden: { opacity: 0, y: 20 },
    show: {
      opacity: 1,
      y: 0,
      transition: { type: 'spring', stiffness: 300, damping: 24 }
    }
  }

  const panelVariants: any = {
    hidden: { opacity: 0, x: -20 },
    show: {
      opacity: 1,
      x: 0,
      transition: { type: 'spring', stiffness: 200, damping: 24 }
    }
  }

  const rightPanelVariants: any = {
    hidden: { opacity: 0, x: 20 },
    show: {
      opacity: 1,
      x: 0,
      transition: { type: 'spring', stiffness: 200, damping: 24 }
    }
  }

  return (
    <div className="min-h-screen bg-[#020305] text-white font-sans flex items-center justify-center p-6 relative overflow-hidden selection:bg-red-500 selection:text-black">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#ef444405_1px,transparent_1px),linear-gradient(to_bottom,#ef444405_1px,transparent_1px)] bg-size-[40px_40px] pointer-events-none mix-blend-screen" />
      <div className="absolute top-[-10%] left-[-5%] w-125 h-125 bg-red-600/10 blur-[150px] rounded-full pointer-events-none animate-pulse" />
      <div className="absolute bottom-[-10%] right-[-5%] w-125 h-125 bg-red-900/10 blur-[150px] rounded-full pointer-events-none" />

      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="w-full max-w-7xl relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-4 items-center"
      >
        <motion.div variants={panelVariants} className="hidden lg:flex col-span-3 flex-col h-125">
          <div className="bg-black/60 border border-white/10 rounded-2xl p-5 h-full flex flex-col gap-3 backdrop-blur-sm shadow-xl">
            <div className="flex items-center gap-2 border-b border-white/10 pb-3">
              <TerminalSquare size={14} className="text-red-400" />
              <span className="text-[10px] font-mono font-bold tracking-widest text-red-400">SYSTEM LOG</span>
            </div>
            <div className="flex-1 flex flex-col gap-1.5 overflow-hidden">
              <AnimatePresence>
                {bootLogs.map((log, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2 }}
                    className={`text-[10px] font-mono leading-relaxed ${i === bootLogs.length - 1 && isReady ? 'text-red-400 font-bold' : 'text-zinc-500'}`}
                  >
                    {log}
                  </motion.div>
                ))}
              </AnimatePresence>
              {isReady && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 1, 0] }}
                  transition={{ repeat: Infinity, duration: 1 }}
                  className="text-red-400 font-mono text-[10px]"
                >
                  █
                </motion.span>
              )}
            </div>
          </div>
        </motion.div>

        <motion.div variants={cardVariants} className="col-span-1 lg:col-span-6 flex flex-col items-center gap-6">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/30 shadow-[0_0_30px_rgba(239,68,68,0.15)] mb-6 relative overflow-hidden">
              <Cpu className="w-8 h-8 text-red-400 relative z-10" />
              <motion.div
                className="absolute inset-x-0 h-0.5 bg-red-400/60 shadow-[0_0_6px_rgba(239,68,68,0.8)]"
                animate={{ top: ['-10%', '110%'] }}
                transition={{ repeat: Infinity, duration: 1.8, ease: 'linear' }}
              />
            </div>
            <h1 className="text-3xl md:text-4xl font-black tracking-tighter mb-2">
              <span className="text-transparent bg-clip-text bg-linear-to-r from-red-500 to-red-400">
                BRUTUS OS
              </span>
            </h1>
            <p className="text-zinc-500 text-[10px] font-mono tracking-[0.3em] uppercase">
              Neural Authentication Gateway
            </p>
          </div>

          <div className="bg-black/70 border border-white/10 rounded-2xl p-8 shadow-2xl relative overflow-hidden flex flex-col items-center w-full backdrop-blur-sm">
            <div className="absolute top-0 left-0 w-full h-px bg-linear-to-r from-transparent via-red-500/50 to-transparent" />

            <div className="mb-8 p-4 rounded-xl bg-red-500/5 border border-red-500/20 flex items-start gap-3 w-full">
              <Lock className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-zinc-400 font-mono leading-relaxed">
                OAuth handshake is routed through a secure external gateway. Your browser will open
                to verify your identity.
              </p>
            </div>

            <div className="relative group w-full mb-2">
              <div className="absolute -inset-0.5 bg-linear-to-r from-red-500 to-red-600 rounded-xl opacity-0 group-hover:opacity-100 blur transition duration-300" />
              <button
                onClick={handleGoogleLogin}
                disabled={!isReady}
                className={`relative flex w-full items-center justify-center gap-3 py-4 px-6 rounded-xl bg-black border border-white/40 text-white transition-all duration-200 ease-in-out font-bold text-xs tracking-widest uppercase shadow-lg ${!isReady ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white hover:text-black hover:border-red-500/90 cursor-pointer'}`}
              >
                <FcGoogle className="w-6 h-6" />
                {isReady ? 'Initialize Link' : 'Booting...'}
              </button>
            </div>

            {errorMessage && (
              <div className="mt-4 w-full rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs font-mono text-red-300">
                {errorMessage}
              </div>
            )}
          </div>
        </motion.div>

        <motion.div variants={rightPanelVariants} className="hidden lg:flex col-span-3 flex-col h-125">
          <div className="bg-black/60 border border-white/10 rounded-2xl p-5 h-full flex flex-col gap-4 backdrop-blur-sm shadow-xl">
            <div className="flex items-center gap-2 border-b border-white/10 pb-3">
              <Activity size={14} className="text-red-400" />
              <span className="text-[10px] font-mono font-bold tracking-widest text-red-400">TELEMETRY</span>
            </div>

            {[
              {
                icon: <Network size={14} />,
                label: 'Network',
                status: isReady ? 'SECURE' : 'WAITING',
                active: isReady
              },
              {
                icon: <Database size={14} />,
                label: 'Local Vault',
                status: 'ENCRYPTED',
                active: true
              },
              {
                icon: <Fingerprint size={14} />,
                label: 'Biometrics',
                status: 'STANDBY',
                active: false
              }
            ].map((item, i) => (
              <div
                key={i}
                className="flex items-center justify-between bg-white/[0.03] rounded-lg px-3 py-2.5 border border-white/5"
              >
                <div className="flex items-center gap-2 text-zinc-400">
                  {item.icon}
                  <span className="text-[10px] font-mono tracking-widest">{item.label}</span>
                </div>
                <span
                  className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded-full border ${item.active ? 'text-red-400 border-red-500/30 bg-red-500/10' : 'text-zinc-600 border-zinc-700'}`}
                >
                  {item.status}
                </span>
              </div>
            ))}

            <p className="text-[9px] text-zinc-700 font-mono mt-auto leading-relaxed">
              All processing is local. No data leaves your machine without explicit authorization.
            </p>
          </div>
        </motion.div>
      </motion.div>
    </div>
  )
}
