import { useState, useEffect } from 'react'
import {
  RiSubtractLine,
  RiCloseLine,
  RiCheckboxBlankLine,
  RiCheckboxMultipleBlankLine
} from 'react-icons/ri'

const TitleBar = () => {
  const [isMaximized, setIsMaximized] = useState(false)
  const [isMac, setIsMac] = useState(false)

  useEffect(() => {
    if (window.electron && window.electron.process) {
      setIsMac(window.electron.process.platform === 'darwin')
    } else {
      setIsMac(navigator.userAgent.toLowerCase().includes('mac'))
    }
  }, [])

  const minimize = () => window.electron.ipcRenderer.send('window-min')
  const toggleMaximize = () => {
    setIsMaximized(!isMaximized)
    window.electron.ipcRenderer.send('window-max')
  }
  const close = () => window.electron.ipcRenderer.send('window-close')

  return (
    <div className="w-full h-10 flex items-center justify-between px-4 bg-surface border-b border-line drag-region select-none z-1000 relative">
      {isMac && (
        <div className="flex items-center gap-2 no-drag z-50">
          <button
            onClick={close}
            aria-label="Close window"
            className="w-3 h-3 rounded-full bg-coral-500 hover:bg-coral-600 border border-coral-600 flex items-center justify-center group"
          >
            <span className="hidden group-hover:block text-[8px] text-black/70 font-bold">×</span>
          </button>
          <button
            onClick={minimize}
            aria-label="Minimize window"
            className="w-3 h-3 rounded-full bg-amber-500 hover:bg-amber-600 border border-amber-600 flex items-center justify-center group"
          >
            <span className="hidden group-hover:block text-[8px] text-black/70 font-bold">−</span>
          </button>
          {/* Green, per the macOS convention. This was red — a copy of the
              close button — which made the two most different actions in the
              titlebar look identical. */}
          <button
            onClick={toggleMaximize}
            aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
            className="w-3 h-3 rounded-full bg-sage-500 hover:bg-sage-600 border border-sage-600 flex items-center justify-center group"
          >
            <span className="hidden group-hover:block text-[6px] text-black/70 font-bold">↗</span>
          </button>
        </div>
      )}

      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2 opacity-60 pointer-events-none">
        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse shadow-[0_0_10px_rgba(var(--brutus-accent-c),0.9)]" />
        <div className="text-[11px] font-bold text-zinc-300 tracking-[0.3em]">
          BRUTUS OS // {isMac ? 'MAC' : 'SYSTEM'}
        </div>
      </div>

      {!isMac && (
        <div className="flex h-full no-drag ml-auto -mr-4 z-50">
          <button
            onClick={minimize}
            className="w-12 h-full flex items-center justify-center text-zinc-400 hover:bg-white/10 hover:text-white transition-colors"
          >
            <RiSubtractLine size={16} />
          </button>
          <button
            onClick={toggleMaximize}
            className="w-12 h-full flex items-center justify-center text-zinc-400 hover:bg-white/10 hover:text-white transition-colors"
          >
            {isMaximized ? (
              <RiCheckboxMultipleBlankLine size={14} />
            ) : (
              <RiCheckboxBlankLine size={14} />
            )}
          </button>
          <button
            onClick={close}
            className="w-12 h-full flex items-center justify-center text-zinc-400 hover:bg-red-600 hover:text-white transition-colors"
          >
            <RiCloseLine size={18} />
          </button>
        </div>
      )}
    </div>
  )
}

export default TitleBar
