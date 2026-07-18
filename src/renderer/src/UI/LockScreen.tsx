import { useState, useEffect, useRef } from 'react'
import {
  RiShieldKeyholeLine,
  RiShieldCheckLine,
  RiLockPasswordLine,
  RiAlertLine,
  RiDatabase2Line,
  RiCpuLine,
  RiWifiLine,
  RiLoader4Line
} from 'react-icons/ri'
import { motion, AnimatePresence } from 'framer-motion'

interface LockScreenProps {
  onUnlock: () => void
}

export default function LockScreen({ onUnlock }: LockScreenProps) {
  const [pin, setPin] = useState('')

  const [needsPinSetup, setNeedsPinSetup] = useState(false)

  const [error, setError] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const [aiStatus, setAiStatus] = useState('INITIALIZING SECURITY ENCLAVE...')

  const [isAuthorized, setIsAuthorized] = useState(false)
  const [decryptProgress, setDecryptProgress] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)

  const [time, setTime] = useState(new Date().toLocaleTimeString())

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (window.electron?.ipcRenderer) {
      window.electron.ipcRenderer
        .invoke('check-vault-status')
        .then((status: { hasPin: boolean }) => {
          const needsSetup = !status?.hasPin
          setNeedsPinSetup(needsSetup)
          setAiStatus(needsSetup ? 'CREATE MASTER ACCESS CODE' : 'ENTER ACCESS CODE')
          setIsLoading(false)
          setTimeout(() => inputRef.current?.focus(), 100)
        })
        .catch(() => {
          setAiStatus('ENTER ACCESS CODE')
          setIsLoading(false)
          setTimeout(() => inputRef.current?.focus(), 100)
        })
    } else {
      setIsLoading(false)
    }
  }, [])

  const triggerAccessGranted = () => {
    setIsAuthorized(true)
    setError(false)
    setAiStatus('IDENTITY VERIFIED. DECRYPTING VAULT...')

    let progress = 0
    const progressInterval = setInterval(() => {
      progress += Math.floor(Math.random() * 15) + 5
      if (progress >= 100) {
        progress = 100
        clearInterval(progressInterval)
      }
      setDecryptProgress(progress)
    }, 150)

    setTimeout(() => setAiStatus('ESTABLISHING NEURAL UPLINK...'), 1500)
    setTimeout(() => setAiStatus('WORKSPACE READY. REDIRECTING.'), 2500)

    setTimeout(() => {
      onUnlock()
    }, 3300)
  }

  const handlePinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (error || isAuthorized) return
    const value = e.target.value.replace(/\D/g, '')
    if (value.length <= 4) {
      setPin(value)
      if (value.length === 4) processPin(value)
    }
  }

  const processPin = async (currentPin: string) => {
    if (!window.electron?.ipcRenderer) return
    try {
      if (needsPinSetup) {
        await window.electron.ipcRenderer.invoke('setup-vault-pin', currentPin)
        triggerAccessGranted()
      } else {
        const isValid = await window.electron.ipcRenderer.invoke('verify-vault-pin', currentPin)
        if (isValid) {
          triggerAccessGranted()
        } else {
          setError(true)
          setAiStatus('ACCESS DENIED')
          setTimeout(() => {
            setPin('')
            setError(false)
            setAiStatus('ENTER ACCESS CODE')
            inputRef.current?.focus()
          }, 800)
        }
      }
    } catch (err) {
      setError(true)
      setAiStatus('VAULT ERROR — RETRY')
      setTimeout(() => {
        setPin('')
        setError(false)
        setAiStatus(needsPinSetup ? 'CREATE MASTER ACCESS CODE' : 'ENTER ACCESS CODE')
        inputRef.current?.focus()
      }, 1200)
    }
  }

  if (isLoading) return <div className="w-screen h-screen bg-[#030303]"></div>

  const headerText = error
    ? 'SECURITY BREACH'
    : isAuthorized
      ? 'AUTHORIZATION GRANTED'
      : needsPinSetup
        ? 'INITIALIZE VAULT'
        : 'SYSTEM LOCKED'

  return (
    <div
      className="flex flex-col items-center justify-center w-screen h-screen bg-[#030303] relative overflow-hidden select-none font-sans"
      onClick={() => !isAuthorized && inputRef.current?.focus()}
    >
      <div
        className={`absolute inset-0 transition-colors duration-700 bg-[radial-gradient(circle_at_center,var(--tw-gradient-stops))] ${
          error
            ? 'from-red-900/20 via-[#030303] to-[#030303]'
            : isAuthorized
              ? 'from-red-900/30 via-[#030303] to-[#030303]'
              : 'from-red-900/5 via-[#030303] to-[#030303]'
        }`}
      />
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px),linear-gradient(to_bottom,#ffffff03_1px,transparent_1px)] bg-size-[48px_48px] pointer-events-none mix-blend-screen opacity-50" />

      <div className="absolute top-0 w-full h-12 border-b border-white/5 bg-black/40 backdrop-blur-md flex items-center justify-between px-8 z-50 text-[10px] font-mono tracking-widest text-zinc-500 uppercase">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2">
            <RiCpuLine size={14} className={isAuthorized ? 'text-red-400' : 'text-red-600'} /> KERNEL ACTIVE
          </span>
          <span className="flex items-center gap-2">
            <RiDatabase2Line size={14} className={isAuthorized ? 'text-red-400 animate-pulse' : ''} /> {isAuthorized ? 'DECRYPTING' : 'ENCLAVE SECURE'}
          </span>
        </div>
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2">
            <RiWifiLine size={14} /> LOCALHOST
          </span>
          <span className="text-white font-bold">{time}</span>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className={`z-10 flex flex-col items-center gap-8 p-10 w-137.5 rounded-4xl backdrop-blur-2xl border transition-all duration-700 ${
          error
            ? 'border-red-500/50 bg-red-950/10 shadow-[0_0_100px_rgba(239,68,68,0.2)]'
            : isAuthorized
              ? 'border-red-400/60 bg-red-950/20 shadow-[0_0_120px_rgba(239,68,68,0.3)] scale-[1.02]'
              : 'border-white/10 bg-black/40 shadow-2xl'
        }`}
      >
        <div className="text-center space-y-4 w-full">
          <h1
            className={`text-2xl font-black tracking-[0.3em] transition-colors duration-300 flex items-center justify-center gap-3 uppercase ${
              error
                ? 'text-red-500'
                : isAuthorized
                  ? 'text-red-400 drop-shadow-[0_0_15px_rgba(239,68,68,0.5)]'
                  : 'text-white'
            }`}
          >
            {error && <RiAlertLine size={28} className="animate-pulse" />}
            {headerText}
          </h1>

          <div className="flex items-center justify-center w-full">
            <div
              className={`px-4 py-1.5 rounded-md border backdrop-blur-md flex items-center gap-2 transition-all duration-300 ${
                error
                  ? 'bg-red-500/10 border-red-500/30 text-red-400'
                  : isAuthorized
                    ? 'bg-red-400/10 border-red-400/30 text-red-300'
                    : 'bg-white/5 border-white/10 text-zinc-400'
              }`}
            >
              {!error && !isAuthorized && <RiShieldKeyholeLine size={12} />}
              {isAuthorized && <RiLoader4Line size={12} className="animate-spin text-red-400" />}
              <p className="text-[10px] font-mono tracking-widest font-bold uppercase">
                {aiStatus}
              </p>
            </div>
          </div>
        </div>

        <div className="h-70 flex items-center justify-center w-full relative">
          <AnimatePresence mode="wait">
            {isAuthorized && (
              <motion.div
                key="authorized-view"
                initial={{ opacity: 0, scale: 0.9, filter: 'blur(10px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
                className="w-full h-full flex flex-col items-center justify-center relative"
              >
                <div className="relative flex items-center justify-center mb-10">
                  <motion.div
                    animate={{ rotate: 360, scale: [1, 1.05, 1] }}
                    transition={{ rotate: { repeat: Infinity, duration: 10, ease: 'linear' }, scale: { repeat: Infinity, duration: 4, ease: 'easeInOut' } }}
                    className="absolute w-48 h-48 rounded-full border-t border-r border-red-500/20 shadow-[inset_0_0_20px_rgba(239,68,68,0.1)]"
                  />
                  <motion.div
                    animate={{ rotate: -360 }}
                    transition={{ repeat: Infinity, duration: 8, ease: 'linear' }}
                    className="absolute w-40 h-40 rounded-full border-b-[3px] border-l-[3px] border-red-500/30 border-dashed"
                  />
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 3, ease: 'linear' }}
                    className="absolute w-32 h-32 rounded-full border-t-2 border-r-2 border-red-400/60 shadow-[0_0_15px_rgba(239,68,68,0.3)]"
                  />
                  <motion.div
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', damping: 12, stiffness: 90, delay: 0.2 }}
                    className="relative z-10 bg-gradient-to-tr from-red-600/20 to-red-400/10 p-6 rounded-full border border-red-400/50 shadow-[0_0_40px_rgba(239,68,68,0.6)] backdrop-blur-sm overflow-hidden"
                  >
                    <motion.div
                      animate={{ scale: [1, 1.1, 1], filter: ['brightness(1)', 'brightness(1.3)', 'brightness(1)'] }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                    >
                      <RiShieldCheckLine size={56} className="text-red-400 drop-shadow-[0_0_15px_rgba(239,68,68,0.8)]" />
                    </motion.div>

                    <motion.div
                      animate={{ top: ['-20%', '120%'] }}
                      transition={{ duration: 1.8, repeat: Infinity, ease: 'linear' }}
                      className="absolute left-0 w-full h-[2px] bg-white/70 blur-[1px] shadow-[0_0_8px_white] z-20"
                    />
                  </motion.div>
                </div>

                <motion.div
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4, duration: 0.5 }}
                  className="w-[85%] flex flex-col gap-3"
                >
                  <div className="flex justify-between items-center text-[10px] font-mono text-red-300 tracking-widest font-bold">
                    <span className="flex items-center gap-2">
                       <RiLoader4Line size={14} className="animate-spin text-red-500" /> DECRYPTING VAULT
                    </span>
                    <motion.span
                      key={decryptProgress}
                      initial={{ scale: 1.3, color: '#ffffff' }}
                      animate={{ scale: 1, color: '#fca5a5' }}
                      transition={{ duration: 0.3 }}
                      className="text-red-400"
                    >
                      {decryptProgress}%
                    </motion.span>
                  </div>
                  <div className="w-full h-2 bg-black rounded-full overflow-hidden border border-red-900/50 relative shadow-[inset_0_0_5px_rgba(0,0,0,1)]">
                    <motion.div
                      className="absolute inset-y-0 left-0 bg-red-900/30"
                      style={{ width: `${decryptProgress}%` }}
                      transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
                    />
                    <motion.div
                      className="h-full bg-gradient-to-r from-red-600 via-red-500 to-red-400 shadow-[0_0_15px_rgba(239,68,68,0.8)] relative overflow-hidden rounded-full"
                      style={{ width: `${decryptProgress}%` }}
                      transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
                    >
                      <motion.div
                        animate={{ x: ['-100%', '200%'] }}
                        transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
                        className="absolute top-0 w-1/2 h-full bg-gradient-to-r from-transparent via-white/50 to-transparent skew-x-[-20deg]"
                      />
                    </motion.div>
                  </div>
                </motion.div>
              </motion.div>
            )}

            {!isAuthorized && (
              <motion.div
                key="pin-view"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
                transition={{ duration: 0.3 }}
                className="flex flex-col items-center justify-center h-full gap-10 w-full"
              >
                <div
                  className={`p-6 rounded-2xl border transition-colors duration-500 ${
                    error
                      ? 'border-red-500/30 text-red-500 bg-red-950/20'
                      : 'border-white/10 text-zinc-400 bg-black/60'
                  }`}
                >
                  {needsPinSetup ? (
                    <RiLockPasswordLine size={48} />
                  ) : (
                    <RiShieldKeyholeLine size={48} />
                  )}
                </div>

                <div className="flex gap-4">
                  {[0, 1, 2, 3].map((index) => {
                    const isFilled = pin.length > index
                    const isActive = pin.length === index && !error
                    return (
                      <div
                        key={index}
                        className={`w-16 h-20 flex items-center justify-center text-2xl rounded-xl border transition-all duration-300 ${
                          isFilled
                            ? error
                              ? 'border-red-500 bg-red-500/10 text-red-500 shadow-[0_0_30px_rgba(239,68,68,0.3)]'
                              : 'border-red-500/50 bg-red-950/30 text-red-400 shadow-[0_0_15px_rgba(239,68,68,0.2)]'
                            : isActive
                              ? 'border-red-500/70 bg-black shadow-[0_0_15px_rgba(239,68,68,0.1)] scale-105'
                              : 'border-white/10 bg-black/40 text-zinc-700'
                        }`}
                      >
                        {isFilled ? (
                          <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="text-3xl">
                            ●
                          </motion.span>
                        ) : isActive ? (
                          <span className="animate-pulse text-red-500/50 text-3xl font-light">|</span>
                        ) : null}
                      </div>
                    )
                  })}
                </div>

                <p className="text-[10px] font-mono tracking-widest text-zinc-600 uppercase">
                  {needsPinSetup
                    ? 'Set a 4-digit code to secure your vault'
                    : 'Enter your 4-digit access code'}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <input
          ref={inputRef}
          type="text"
          pattern="\d*"
          value={pin}
          onChange={handlePinChange}
          className="opacity-0 absolute -left-2499.75"
          maxLength={4}
          autoComplete="off"
          disabled={isAuthorized}
        />
      </motion.div>

      <div className="absolute bottom-6 flex flex-col items-center gap-1 z-50">
        <span className="text-[9px] font-mono tracking-widest text-zinc-600 uppercase">
          IRIS Kernel Security Engine V3.5
        </span>
        <span className="text-[8px] font-mono tracking-widest text-red-700/50 uppercase">
          100% Local Execution Environment
        </span>
      </div>
    </div>
  )
}
