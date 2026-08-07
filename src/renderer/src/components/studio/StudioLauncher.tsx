import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import {
  RiAddLine,
  RiFolderOpenLine,
  RiGitBranchLine,
  RiLinkM,
  RiLoader4Line,
  RiCloseLine,
  RiShieldFlashLine
} from 'react-icons/ri'
import WorkspaceCard from './WorkspaceCard'
import { studio, type WorkspaceSummary } from '@renderer/services/studio-client'

/**
 * The first screen of Studio: pick a workspace, or start one.
 *
 * A workspace is a canvas plus the project it belongs to, so this is where the
 * project gets chosen — before any agent exists. That ordering matters: every
 * agent added afterwards inherits the workspace's folder, which is what makes
 * them share a project journal and coordinate instead of working blind.
 */

type Dialog = null | 'clone' | 'link'

export default function StudioLauncher({ onOpen }: { onOpen: (id: string) => void }): ReactElement {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [error, setError] = useState<string | null>(null)
  const reduceMotion = useReducedMotion()

  /** Bump to re-read the list after a create, import or delete. */
  const [reloadKey, setReloadKey] = useState(0)
  const refresh = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    let cancelled = false
    void studio.listWorkspaces().then((list) => {
      // Guarded because leaving the launcher mid-request is entirely normal.
      if (cancelled) return
      setWorkspaces(list)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  // ── Actions ───────────────────────────────────────────────────────────────

  const newWorkspace = useCallback(async () => {
    setBusy('new')
    const ws = await studio.createWorkspace({ name: 'Untitled workspace' })
    setBusy(null)
    if (ws) onOpen(ws.id)
  }, [onOpen])

  const openFolder = useCallback(async () => {
    const dir = await studio.pickFolder()
    if (!dir) return
    setBusy('folder')
    const ws = await studio.createWorkspace({ rootDir: dir })
    setBusy(null)
    if (ws) onOpen(ws.id)
  }, [onOpen])

  const cloneRepo = useCallback(
    async (url: string) => {
      setError(null)
      const parent = await studio.pickFolder()
      if (!parent) return
      setBusy('clone')
      const res = await studio.cloneRepo(url, parent)
      if (!res.ok || !res.path) {
        setBusy(null)
        setError(res.error ?? 'Clone failed.')
        return
      }
      const ws = await studio.createWorkspace({ rootDir: res.path, name: res.name })
      setBusy(null)
      setDialog(null)
      if (ws) onOpen(ws.id)
    },
    [onOpen]
  )

  const openFromLink = useCallback(
    async (payload: string) => {
      setError(null)
      setBusy('link')
      const res = await studio.importWorkspace(payload)
      setBusy(null)
      if (!res.ok) {
        setError(res.error ?? 'That could not be read as a workspace.')
        return
      }
      setDialog(null)
      refresh()
    },
    [refresh]
  )

  const actions = [
    { id: 'new', label: 'New workspace', icon: <RiAddLine size={15} />, run: newWorkspace },
    { id: 'folder', label: 'Open folder', icon: <RiFolderOpenLine size={15} />, run: openFolder },
    {
      id: 'clone',
      label: 'Clone repo',
      icon: <RiGitBranchLine size={15} />,
      run: () => {
        setError(null)
        setDialog('clone')
      }
    },
    {
      id: 'link',
      label: 'Open from link',
      icon: <RiLinkM size={15} />,
      run: () => {
        setError(null)
        setDialog('link')
      }
    }
  ]

  return (
    <div className="relative h-full w-full overflow-y-auto">
      {/* Same scenery vocabulary as the canvas, so entering a workspace feels
          like walking into the next room rather than a different app. */}
      <div
        className="studio-layer"
        style={{
          background:
            'radial-gradient(ellipse 100% 60% at 50% -10%, #1a0c10 0%, #0d0a0c 45%, #08080a 100%)'
        }}
      />
      <div
        className="studio-layer studio-bloom"
        style={{
          background:
            'radial-gradient(38% 44% at 20% 12%, rgba(var(--brutus-accent-c),0.16) 0%, transparent 70%),' +
            'radial-gradient(42% 48% at 84% 30%, rgba(249,115,22,0.10) 0%, transparent 72%)'
        }}
      />
      <div className="studio-layer studio-grain" />

      <div className="relative mx-auto w-full max-w-5xl px-8 py-10">
        {/* ── Header ── */}
        <div className="mb-9 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-500/25 bg-red-500/10">
            <RiShieldFlashLine className="text-red-500" size={16} />
          </div>
          <div>
            <h1 className="text-[15px] font-bold tracking-tight text-zinc-100">Studio</h1>
            <p className="text-[11px] text-zinc-500">
              Run your real coding agents side by side, on one canvas.
            </p>
          </div>
        </div>

        {/* ── Open or create ── */}
        <h2 className="mb-3 text-[13px] font-semibold text-zinc-200">Open or create</h2>
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <button
              key={a.id}
              onClick={() => void a.run()}
              disabled={busy !== null}
              className="group flex cursor-pointer items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-[12px] font-medium text-zinc-200 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="text-zinc-400 transition-colors group-hover:text-red-400">
                {busy === a.id ? <RiLoader4Line size={15} className="animate-spin" /> : a.icon}
              </span>
              {a.label}
            </button>
          ))}
        </div>

        {error && !dialog && (
          <p className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
            {error}
          </p>
        )}

        {/* ── Recent ── */}
        <div className="mb-3 mt-10 flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold text-zinc-200">Recent</h2>
          {!loading && <span className="text-[11px] text-zinc-600">· {workspaces.length}</span>}
        </div>

        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[196px] animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02]"
              />
            ))}
          </div>
        ) : workspaces.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-6 py-10 text-center">
            <p className="text-[12px] text-zinc-400">No workspaces yet.</p>
            <p className="mt-1 text-[11px] text-zinc-600">
              Open a folder to start one on a project you already have.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
            {workspaces.map((ws) => (
              <WorkspaceCard
                key={ws.id}
                ws={ws}
                onOpen={() => onOpen(ws.id)}
                onDelete={async () => {
                  await studio.deleteWorkspace(ws.id)
                  refresh()
                }}
                onExport={async () => {
                  const data = await studio.exportWorkspace(ws.id)
                  if (data) await navigator.clipboard.writeText(data)
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Dialogs ── */}
      <AnimatePresence>
        {dialog && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
            onClick={() => setDialog(null)}
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: 14, scale: 0.97 }}
              transition={
                reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 320, damping: 30 }
              }
              onClick={(e) => e.stopPropagation()}
              className="studio-glass w-[min(460px,calc(100vw-3rem))] rounded-2xl p-4"
            >
              <PromptDialog
                kind={dialog}
                busy={busy !== null}
                error={error}
                onCancel={() => setDialog(null)}
                onSubmit={(value) =>
                  dialog === 'clone' ? void cloneRepo(value) : void openFromLink(value)
                }
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function PromptDialog({
  kind,
  busy,
  error,
  onCancel,
  onSubmit
}: {
  kind: 'clone' | 'link'
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (value: string) => void
}): ReactElement {
  const [value, setValue] = useState('')
  const clone = kind === 'clone'

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-zinc-100">
            {clone ? 'Clone a repository' : 'Open from link'}
          </h3>
          <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">
            {clone
              ? 'Brutus runs git clone, then opens a workspace on the result. You pick where it lands.'
              : 'Paste a workspace someone shared. It recreates their canvas — agents and wiring — on your machine.'}
          </p>
        </div>
        <button
          onClick={onCancel}
          className="cursor-pointer rounded p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          <RiCloseLine size={14} />
        </button>
      </div>

      {clone ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value.trim() && onSubmit(value.trim())}
          placeholder="https://github.com/user/repo.git"
          className="mt-3 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11.5px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-red-500/40"
        />
      ) : (
        <textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={5}
          placeholder='{ "brutusStudioWorkspace": 1, "name": "…", "nodes": [ … ] }'
          className="mt-3 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-red-500/40"
        />
      )}

      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="cursor-pointer rounded-lg px-3 py-1.5 text-[11px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
        >
          Cancel
        </button>
        <button
          onClick={() => value.trim() && onSubmit(value.trim())}
          disabled={!value.trim() || busy}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-red-500/20 px-3 py-1.5 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy && <RiLoader4Line size={12} className="animate-spin" />}
          {clone ? 'Choose folder & clone' : 'Open'}
        </button>
      </div>
    </>
  )
}
