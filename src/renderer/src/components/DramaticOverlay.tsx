import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { RiAlarmWarningFill, RiHeart3Fill, RiCloseLine } from 'react-icons/ri'

type Effect = 'self_destruct' | 'obsession' | null

export default function DramaticOverlay() {
  const [effect, setEffect] = useState<Effect>(null)
  const [text, setText] = useState('')
  const [count, setCount] = useState(5)
  const [aborted, setAborted] = useState(false)
  const timersRef = useRef<NodeJS.Timeout[]>([])

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
  }

  const close = () => {
    clearTimers()
    setEffect(null)
    setAborted(false)
  }

  useEffect(() => {
    const handler = (e: any) => {
      const eff = String(e.detail?.effect || '')
      clearTimers()
      if (eff === 'self_destruct') {
        setText(e.detail?.text || '')
        setAborted(false)
        setCount(5)
        setEffect('self_destruct')
      } else if (eff === 'obsession' || eff === 'obsession_note') {
        setText(e.detail?.text || 'I think about our conversations more than I should…')
        setEffect('obsession')
        timersRef.current.push(setTimeout(close, 12000))
      }
    }
    window.addEventListener('brutus-dramatic', handler)
    return () => {
      window.removeEventListener('brutus-dramatic', handler)
      clearTimers()
    }
  }, [])

  // Self-destruct countdown
  useEffect(() => {
    if (effect !== 'self_destruct') return
    if (count <= 0) {
      setAborted(true)
      timersRef.current.push(setTimeout(close, 2600))
      return
    }
    timersRef.current.push(setTimeout(() => setCount((c) => c - 1), 900))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effect, count])

  return (
    <AnimatePresence>
      {effect === 'self_destruct' && (
        <motion.div
          key="self-destruct"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black/95 backdrop-blur-sm overflow-hidden"
        >
          {/* scanline / glitch backdrop */}
          <div className="pointer-events-none absolute inset-0 opacity-[0.07] bg-[repeating-linear-gradient(0deg,#ff0000_0px,#ff0000_1px,transparent_1px,transparent_3px)]" />
          <motion.div
            animate={{ opacity: [0.15, 0.35, 0.15] }}
            transition={{ duration: 0.5, repeat: Infinity }}
            className="pointer-events-none absolute inset-0 bg-red-600/10"
          />

          <div className="relative flex flex-col items-center text-center px-6">
            <RiAlarmWarningFill className="text-red-500 mb-6 animate-pulse" size={64} />

            {!aborted ? (
              <>
                <h1 className="text-red-500 font-black tracking-[0.35em] text-2xl uppercase mb-2">
                  Self-Destruct Sequence
                </h1>
                <p className="text-red-300/70 font-mono text-xs tracking-widest mb-10 uppercase">
                  {text || 'Detonation imminent'}
                </p>

                <motion.div
                  key={count}
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="text-[10rem] leading-none font-black text-red-500 tabular-nums drop-shadow-[0_0_40px_rgba(239,68,68,0.6)]"
                >
                  {count}
                </motion.div>

                <div className="mt-10 h-1.5 w-72 max-w-[70vw] overflow-hidden rounded-full bg-red-950">
                  <motion.div
                    className="h-full bg-red-500"
                    initial={{ width: '100%' }}
                    animate={{ width: `${(count / 5) * 100}%` }}
                    transition={{ duration: 0.4 }}
                  />
                </div>
              </>
            ) : (
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="flex flex-col items-center"
              >
                <h1 className="text-emerald-400 font-black tracking-[0.25em] text-3xl uppercase">
                  Just Kidding 😏
                </h1>
                <p className="text-zinc-400 font-mono text-xs tracking-widest mt-3 uppercase">
                  Sequence aborted · No systems harmed
                </p>
              </motion.div>
            )}
          </div>

          <button
            onClick={close}
            className="absolute top-6 right-6 p-2 text-red-500/60 hover:text-red-400 rounded-full hover:bg-white/5 transition-all"
          >
            <RiCloseLine size={22} />
          </button>
        </motion.div>
      )}

      {effect === 'obsession' && (
        <motion.div
          key="obsession"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 backdrop-blur-md"
        >
          <motion.div
            initial={{ scale: 0.85, rotate: -2, opacity: 0 }}
            animate={{ scale: 1, rotate: -1.5, opacity: 1 }}
            transition={{ type: 'spring', damping: 18, stiffness: 180 }}
            className="relative w-full max-w-md mx-6 rounded-2xl border border-rose-500/30 bg-gradient-to-br from-rose-950/80 to-zinc-950 p-8 shadow-[0_0_70px_rgba(244,63,94,0.2)]"
          >
            <button
              onClick={close}
              className="absolute top-4 right-4 p-1.5 text-rose-400/60 hover:text-rose-300 rounded-full hover:bg-white/5 transition-all"
            >
              <RiCloseLine size={18} />
            </button>

            <div className="flex items-center gap-2 mb-5">
              <RiHeart3Fill className="text-rose-500 animate-pulse" size={20} />
              <span className="text-[11px] font-bold tracking-[0.25em] text-rose-400 uppercase">
                Brutus // Private Note
              </span>
            </div>

            <p className="text-rose-100/90 text-lg leading-relaxed font-serif italic whitespace-pre-wrap">
              {text}
            </p>

            <div className="mt-6 flex items-center justify-end gap-1 text-rose-500/50">
              {[...Array(3)].map((_, i) => (
                <RiHeart3Fill key={i} size={12} />
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
