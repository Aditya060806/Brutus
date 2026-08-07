import { useState, useEffect, useRef, useCallback } from 'react'
import {
  RiAppsLine,
  RiTerminalBoxLine,
  RiChromeLine,
  RiCodeLine,
  RiSpotifyLine,
  RiDiscordLine,
  RiGamepadLine,
  RiSearchLine,
  RiCloseLine
} from 'react-icons/ri'
import { getAllApps, AppItem } from '@renderer/services/system-info'

const SmartIcon = ({ name }: { name: string }) => {
  if (!name) return <div className="w-10 h-10 bg-zinc-800 rounded-lg border border-white/5" />

  const lower = name.toLowerCase()
  let icon = <RiTerminalBoxLine size={20} />
  let color = 'text-zinc-400'
  let bg = 'bg-zinc-800'

  if (lower.includes('chrome') || lower.includes('edge')) {
    icon = <RiChromeLine size={20} />
    color = 'text-blue-400'
    bg = 'bg-blue-500/10'
  } else if (lower.includes('code') || lower.includes('dev')) {
    icon = <RiCodeLine size={20} />
    color = 'text-cyan-400'
    bg = 'bg-cyan-500/10'
  } else if (lower.includes('spotify') || lower.includes('music')) {
    icon = <RiSpotifyLine size={20} />
    color = 'text-red-400'
    bg = 'bg-red-500/10'
  } else if (lower.includes('discord') || lower.includes('telegram')) {
    icon = <RiDiscordLine size={20} />
    color = 'text-indigo-400'
    bg = 'bg-indigo-500/10'
  } else if (lower.includes('game') || lower.includes('launcher')) {
    icon = <RiGamepadLine size={20} />
    color = 'text-purple-400'
    bg = 'bg-purple-500/10'
  }

  return (
    <div
      className={`w-10 h-10 rounded-lg flex items-center justify-center border border-white/5 ${bg} ${color} shadow-sm group-hover:scale-110 transition-transform`}
    >
      {icon}
    </div>
  )
}

const AppCard = ({ app }: { app: AppItem }) => (
  <div
    onClick={() => window.electron.ipcRenderer.invoke('open-app', app.name)}
    className="relative overflow-hidden bg-zinc-950/40 backdrop-blur-xl border border-white/5 rounded-xl p-4 flex items-center gap-4 hover:bg-white/10 hover:border-red-500/30 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(var(--brutus-accent-c),0.12)] transition-all duration-300 cursor-pointer group active:scale-95"
  >
    <div className="absolute top-0 left-0 h-px w-full bg-linear-to-r from-transparent via-red-500/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    <SmartIcon name={app.name} />
    <div className="flex-1 overflow-hidden">
      <div className="text-xs font-bold text-zinc-200 truncate group-hover:text-red-400 transition-colors">
        {app.name}
      </div>
      <div className="text-[8px] text-zinc-600 truncate font-mono mt-1 opacity-70 group-hover:opacity-100 flex items-center gap-1">
        <span className="w-1 h-1 rounded-full bg-emerald-500/70 group-hover:bg-emerald-400 transition-colors" />
        INSTALLED
      </div>
    </div>
    <span className="text-[8px] font-mono text-red-400/0 group-hover:text-red-400/80 transition-colors tracking-widest shrink-0">
      LAUNCH →
    </span>
  </div>
)

const AppSkeleton = () => (
  <div className="bg-zinc-950/40 border border-white/5 rounded-xl p-4 flex items-center gap-4 animate-pulse">
    <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/5" />
    <div className="flex-1 flex flex-col gap-2">
      <div className="h-2.5 w-2/3 rounded bg-white/5" />
      <div className="h-1.5 w-1/3 rounded bg-white/5" />
    </div>
  </div>
)

const AppsView = () => {
  const [allApps, setAllApps] = useState<AppItem[]>([])
  const [visibleApps, setVisibleApps] = useState<AppItem[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const query = search.trim().toLowerCase()
  const isSearching = query.length > 0
  // When searching, match across the whole index; otherwise use the paginated list.
  const displayApps = isSearching
    ? allApps.filter((a) => a.name.toLowerCase().includes(query))
    : visibleApps

  const observer = useRef<IntersectionObserver | null>(null)
  const lastAppElementRef = useCallback(
    (node: HTMLDivElement) => {
      if (loading) return
      if (observer.current) observer.current.disconnect()

      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && visibleApps.length < allApps.length) {
          setPage((prev) => prev + 1)
        }
      })
      if (node) observer.current.observe(node)
    },
    [loading, visibleApps.length, allApps.length]
  )

  useEffect(() => {
    getAllApps().then((raw) => {
      const cleanData = (Array.isArray(raw) ? raw : []).filter(
        (item) => item && typeof item === 'object' && item.name && item.id
      )

      setAllApps(cleanData)
      setVisibleApps(cleanData.slice(0, 15))
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (page > 1) {
      const nextBatch = allApps.slice(0, page * 12 + 6)
      setVisibleApps(nextBatch)
    }
  }, [page, allApps])

  return (
    <div className="flex-1 bg-white/8 p-8 h-full flex flex-col animate-in fade-in zoom-in duration-300">
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-red-500/10 rounded-lg border border-red-500/20 shadow-[0_0_10px_rgba(var(--brutus-accent-c),0.1)]">
            <RiAppsLine className="text-red-400" size={20} />
          </div>
          <div>
            <h2 className="text-sm font-bold text-zinc-200 tracking-widest">SYSTEM APPLICATIONS</h2>
            <p className="text-[10px] text-zinc-500 font-mono">INDEXED SOFTWARE LIBRARY</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative group">
            <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 group-focus-within:text-red-400 transition-colors" size={13} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              disabled={loading}
              placeholder="Filter apps..."
              className="w-40 focus:w-56 bg-black/40 border border-white/10 focus:border-red-500/40 rounded-full text-[11px] text-zinc-200 placeholder-zinc-600 font-mono pl-8 pr-7 py-1.5 outline-none transition-all duration-300 disabled:opacity-40"
            />
            {isSearching && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-red-400 transition-colors"
              >
                <RiCloseLine size={13} />
              </button>
            )}
          </div>
          <div className="text-xs font-mono text-red-500 bg-red-500/5 px-3 py-1 rounded-full border border-red-500/20 whitespace-nowrap">
            {loading ? 'INDEXING...' : isSearching ? `${displayApps.length} MATCH` : `${allApps.length} FOUND`}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-4 pb-4 scrollbar-small min-h-0">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {loading &&
            Array.from({ length: 12 }).map((_, i) => <AppSkeleton key={`sk-${i}`} />)}

          {!loading &&
            displayApps.map((app, index) => {
              const safeKey = `${app.id}-${index}`
              // Infinite-scroll sentinel only applies to the un-filtered paginated list.
              if (!isSearching && displayApps.length === index + 1) {
                return (
                  <div ref={lastAppElementRef} key={safeKey}>
                    <AppCard app={app} />
                  </div>
                )
              }
              return <AppCard key={safeKey} app={app} />
            })}

          {!loading && displayApps.length === 0 && (
            <div className="col-span-full flex flex-col items-center justify-center gap-3 py-16 text-zinc-600 animate-in fade-in duration-300">
              <RiSearchLine size={28} className="opacity-40" />
              <span className="text-xs font-mono tracking-widest">
                {isSearching ? `NO APPS MATCH "${search.trim().toUpperCase()}"` : 'NO APPS FOUND'}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default AppsView
