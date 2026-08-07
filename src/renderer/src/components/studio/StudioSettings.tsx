import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import {
  RiArrowUpSLine,
  RiArrowDownSLine,
  RiCloseLine,
  RiAddLine,
  RiRefreshLine,
  RiCheckLine
} from 'react-icons/ri'
import { BACKDROPS } from './backdrops'
import {
  studio,
  type AgentInfo,
  type DockItem,
  type DockState,
  type OrphanedWorktree,
  type StudioHealth
} from '@renderer/services/studio-client'

/**
 * Studio's settings: what the canvas looks like, and what sits on its dock.
 *
 * The dock list is deliberately built from what Brutus can actually place —
 * the adapter registry plus the node types the canvas renders. A longer list of
 * tools that looked clickable and did nothing would be worse than a short list
 * where every entry works.
 */
export default function StudioSettings(): ReactElement {
  const [dock, setDock] = useState<DockState | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void studio.getDock().then((d) => {
      if (!cancelled) setDock(d)
    })
    // Re-detect so a CLI installed since launch appears without a restart.
    void studio.agents(true).then((a) => {
      if (!cancelled) setAgents(a)
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** Persist an order, and flash a confirmation so the save is visible. */
  const commit = useCallback(async (next: Promise<DockState>) => {
    const d = await next
    setDock(d)
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1400)
  }, [])

  const move = useCallback(
    (index: number, delta: number) => {
      if (!dock) return
      const ids = dock.onDock.map((i) => i.id)
      const to = index + delta
      if (to < 0 || to >= ids.length) return
      ;[ids[index], ids[to]] = [ids[to], ids[index]]
      void commit(studio.setDock({ onDock: ids }))
    },
    [dock, commit]
  )

  const remove = useCallback(
    (id: string) => {
      if (!dock) return
      void commit(
        studio.setDock({ onDock: dock.onDock.filter((i) => i.id !== id).map((i) => i.id) })
      )
    },
    [dock, commit]
  )

  const add = useCallback(
    (id: string) => {
      if (!dock) return
      void commit(studio.setDock({ onDock: [...dock.onDock.map((i) => i.id), id] }))
    },
    [dock, commit]
  )

  if (!dock) {
    return (
      <div className="h-40 animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02]" />
    )
  }

  return (
    <div className="flex flex-col gap-10">
      {/* ── Default agent ── */}
      <section>
        <h3 className="text-[14px] font-bold text-zinc-100">Default agent</h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">
          The agent new nodes open with. You can still change it on any individual node before
          launching it.
        </p>

        <div className="mt-4 flex flex-col gap-1.5">
          {agents.map((a) => {
            const isDefault = dock.defaultAgent === a.kind
            const state = !a.available
              ? { dot: 'bg-red-500', text: 'Not installed — see Setup below' }
              : a.signedIn
                ? { dot: 'bg-emerald-500', text: 'Ready' }
                : { dot: 'bg-amber-400', text: 'Installed, no credentials found' }
            return (
              <div
                key={a.kind}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                  isDefault
                    ? 'border-red-500/40 bg-red-500/[0.07]'
                    : 'border-white/[0.06] bg-white/[0.025]'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-zinc-100">{a.label}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-zinc-500">
                    <span className={`h-1.5 w-1.5 rounded-full ${state.dot}`} />
                    {state.text}
                  </p>
                </div>
                {isDefault ? (
                  <span className="shrink-0 rounded-full bg-red-500/20 px-2.5 py-1 text-[10px] font-bold text-red-300">
                    Default
                  </span>
                ) : (
                  <button
                    onClick={() => void commit(studio.setDock({ defaultAgent: a.kind }))}
                    disabled={!a.available}
                    className="shrink-0 cursor-pointer rounded-lg px-2.5 py-1 text-[10.5px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    Make default
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* ── Parallel work ── */}
      <section>
        <h3 className="text-[14px] font-bold text-zinc-100">Parallel work</h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">
          How several agents share one repository without standing on each other.
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <Toggle
            on={dock.worktrees}
            onChange={(v) => void commit(studio.setDock({ worktrees: v }))}
            title="Isolate each agent in its own worktree"
            blurb="Every agent gets its own git worktree and branch, cut from the branch you are on, so two agents editing the same repository cannot overwrite each other. Closing an agent removes the directory but always keeps the branch — including unmerged work. Needs a repository with at least one commit."
          />
          <Toggle
            on={dock.autoMerge}
            disabled={!dock.worktrees}
            requires="Requires worktree isolation."
            onChange={(v) => void commit(studio.setDock({ autoMerge: v }))}
            title="Merge each turn back automatically"
            blurb="When a turn finishes, Brutus commits what that agent changed and merges its branch back with --no-ff. A conflict aborts the merge, leaves your working tree exactly as it was, and hands you the branch name to resolve. Nothing is ever force-merged, reset or discarded."
          />
          <Toggle
            on={dock.shareContext}
            onChange={(v) => void commit(studio.setDock({ shareContext: v }))}
            title="Share project context between agents"
            blurb="Each handoff carries a short digest of what the other agents in this repository just did and which files they touched, so the next one does not redo or overwrite their work. Turn off to pass only what the connection itself carries."
          />
          <Toggle
            on={dock.skipPermissions}
            disabled={!dock.worktrees}
            danger
            requires="Requires worktree isolation."
            onChange={(v) => void commit(studio.setDock({ skipPermissions: v }))}
            title="Skip permission prompts (autonomous)"
            blurb="Agents launch in their CLI's bypass mode — Claude Code with --dangerously-skip-permissions, Codex with --dangerously-bypass-approvals-and-sandbox. Gemini CLI has no such flag and is unaffected. Only offered alongside worktree isolation, because an unsupervised agent belongs in a branch it owns rather than in your working tree."
          />
        </div>
      </section>

      {/* ── Setup ── */}
      <section>
        <h3 className="text-[14px] font-bold text-zinc-100">Setup</h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">
          Brutus runs your own CLIs, so it uses whatever you are already signed into. Sign-in is
          inferred from each CLI&apos;s credential folder — it is not a verified session.
        </p>

        <div className="mt-4 flex flex-col gap-2">
          {agents.map((a) => (
            <div
              key={a.kind}
              className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-[12.5px] font-semibold text-zinc-100">{a.label}</p>
                {a.models.length > 0 && (
                  <label className="flex items-center gap-2">
                    <span className="text-[10.5px] text-zinc-500">Default model</span>
                    <select
                      value={dock.models[a.kind] ?? ''}
                      onChange={(e) =>
                        void commit(studio.setDock({ models: { [a.kind]: e.target.value } }))
                      }
                      className="cursor-pointer rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-red-500/40"
                    >
                      {a.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
                {!a.available
                  ? 'Not found — install it to use it.'
                  : a.signedIn
                    ? `Signed in via ${a.bin} — nothing to set.`
                    : `Installed, but no credentials found. Run ${a.bin} once in a terminal to sign in.`}
              </p>

              {!a.available && a.install && (
                <button
                  onClick={() => void navigator.clipboard.writeText(a.install)}
                  title="Copy the install command"
                  className="mt-2 cursor-pointer rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 font-mono text-[10.5px] text-zinc-300 transition-colors hover:bg-white/[0.07]"
                >
                  {a.install}
                </button>
              )}
              {a.available && a.path && (
                <p className="mt-1 truncate font-mono text-[10px] text-zinc-600" title={a.path}>
                  {a.path}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── Health ── */}
      <StudioHealthPanel />

      {/* ── Reclaim ── */}
      <ReclaimPanel />

      {/* ── Appearance ── */}
      <section>
        <h3 className="text-[14px] font-bold text-zinc-100">Appearance</h3>
        <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">
          Scenery behind the canvas, under the dot grid. This is the default for new workspaces —
          each canvas can still be changed from the palette button in its bottom-right corner.
        </p>

        <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
          {BACKDROPS.map((b) => {
            const active = dock.backdrop === b.id
            return (
              <button
                key={b.id}
                onClick={() => void commit(studio.setDock({ backdrop: b.id }))}
                className={`cursor-pointer overflow-hidden rounded-xl border text-left transition-all duration-200 hover:-translate-y-0.5 ${
                  active
                    ? 'border-red-500/50 shadow-[0_0_0_1px_rgba(var(--brutus-accent-c),0.25)]'
                    : 'border-white/[0.08] hover:border-white/20'
                }`}
              >
                <div className="relative h-16 w-full" style={{ background: b.base }}>
                  <div className="absolute inset-0" style={{ background: b.bloom }} />
                  <div className="studio-grain absolute inset-0" />
                </div>
                <div className="flex items-center gap-1.5 bg-white/[0.03] px-2.5 py-1.5">
                  {active && <RiCheckLine size={12} className="text-red-400" />}
                  <span className="text-[11px] font-medium text-zinc-200">{b.label}</span>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {/* ── Dock ── */}
      <section>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[14px] font-bold text-zinc-100">Dock</h3>
            <p className="mt-1 max-w-xl text-[11.5px] leading-relaxed text-zinc-500">
              Choose which agents and tools sit on the canvas dock, and in what order. The command
              bar is always there — everything else is up to you.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {saved && <span className="text-[10px] text-emerald-400">Saved</span>}
            <button
              onClick={() => void commit(studio.resetDock())}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[10.5px] text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-zinc-200"
            >
              <RiRefreshLine size={11} /> Reset to default
            </button>
          </div>
        </div>

        <p className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          On the dock
        </p>
        {dock.onDock.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-[11px] text-zinc-600">
            The dock is empty. Add something below.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {dock.onDock.map((item, i) => (
              <Row key={item.id} item={item}>
                <button
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  className="cursor-pointer rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-25"
                >
                  <RiArrowUpSLine size={15} />
                </button>
                <button
                  onClick={() => move(i, 1)}
                  disabled={i === dock.onDock.length - 1}
                  title="Move down"
                  className="cursor-pointer rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-25"
                >
                  <RiArrowDownSLine size={15} />
                </button>
                <button
                  onClick={() => remove(item.id)}
                  title="Remove from dock"
                  className="cursor-pointer rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-red-500/15 hover:text-red-400"
                >
                  <RiCloseLine size={15} />
                </button>
              </Row>
            ))}
          </div>
        )}

        <p className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          Available
        </p>
        {dock.available.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-[11px] text-zinc-600">
            Everything Brutus can place is already on the dock.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {dock.available.map((item) => (
              <Row key={item.id} item={item}>
                <button
                  onClick={() => add(item.id)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
                >
                  <RiAddLine size={12} /> Add
                </button>
              </Row>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * Live view of what Studio is actually doing.
 *
 * Polled rather than pushed: the underlying call only reads counters, so
 * polling costs nothing and cannot perturb what it is measuring. Two seconds is
 * fast enough to watch a merge queue drain and slow enough to ignore.
 */
function StudioHealthPanel(): ReactElement {
  const [health, setHealth] = useState<StudioHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = (): void => {
      void studio.health().then((h) => {
        if (!cancelled) setHealth(h)
      })
    }
    tick()
    const id = window.setInterval(tick, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const engineOk = health?.engine.ok ?? false
  /**
   * Slowest first: the point of showing timings is finding what is costing you,
   * and a reframe that averages four seconds is the thing to see immediately.
   */
  const timings = Object.entries(health?.metrics?.durations ?? {}).sort(
    (a, b) => b[1].avgMs - a[1].avgMs
  )
  const stats: { label: string; value: string; warn?: boolean }[] = health
    ? [
        { label: 'Live agents', value: String(health.sessions.total) },
        { label: 'Isolated', value: String(health.sessions.isolated) },
        { label: 'Hooked', value: String(health.sessions.hooked) },
        {
          label: 'Awaiting you',
          value: String(health.policy.awaitingHuman),
          warn: health.policy.awaitingHuman > 0
        },
        { label: 'Repos busy', value: String(health.git.reposBusy) },
        { label: 'Projects', value: String(health.projects) },
        { label: 'Starting', value: String(health.spawning) },
        {
          label: 'Policy server',
          value: health.policy.serverRunning ? `:${health.policy.port}` : 'idle'
        }
      ]
    : []

  return (
    <section>
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-bold text-zinc-100">Health</h3>
        <span
          className={`h-1.5 w-1.5 rounded-full ${engineOk ? 'bg-emerald-500' : 'bg-red-500'}`}
        />
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">
        {engineOk
          ? 'Terminal engine ready. Everything below updates live.'
          : `Terminal engine unavailable${health?.engine.error ? `: ${health.engine.error}` : ''}.`}
      </p>

      <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
        {stats.map((s) => (
          <div
            key={s.label}
            className={`rounded-xl border px-3 py-2.5 ${
              s.warn
                ? 'border-amber-500/30 bg-amber-500/[0.07]'
                : 'border-white/[0.06] bg-white/[0.025]'
            }`}
          >
            <p
              className={`font-mono text-[17px] tabular-nums ${
                s.warn ? 'text-amber-400' : 'text-zinc-100'
              }`}
            >
              {s.value}
            </p>
            <p className="mt-0.5 text-[10px] uppercase tracking-wider text-zinc-500">{s.label}</p>
          </div>
        ))}
      </div>

      {timings.length > 0 && (
        <>
          <p className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            Timings
          </p>
          <div className="flex flex-col gap-1.5">
            {timings.map(([name, h]) => (
              <div
                key={name}
                className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">
                  {name}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-zinc-500">
                  {h.count}x
                </span>
                <span className="w-24 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-zinc-200">
                  {h.avgMs}ms avg
                </span>
                <span className="w-28 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-600">
                  {h.minMs}–{h.maxMs}ms
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

/**
 * Worktrees Brutus left behind, and what to do about them.
 *
 * Listing is read-only and safe to do on open. Every action is a button you
 * press, per item — Brutus never merges or deletes on your behalf here, because
 * a branch can hold work that never merged and that loss is unrecoverable.
 * Removing takes the directory only; the branch always survives.
 */
function ReclaimPanel(): ReactElement | null {
  const [orphans, setOrphans] = useState<OrphanedWorktree[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    setOrphans(await studio.orphans())
    setLoaded(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    void studio.orphans().then((o) => {
      if (!cancelled) {
        setOrphans(o)
        setLoaded(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const act = useCallback(
    async (o: OrphanedWorktree, action: 'merge' | 'remove') => {
      setBusy(o.dir)
      setNote(null)
      const res = await studio.orphanAction(o, action)
      setBusy(null)
      setNote(
        res.ok
          ? action === 'merge'
            ? `Merged ${o.branch}.`
            : `Removed the directory for ${o.branch} — the branch is still there.`
          : (res.error ?? `Could not ${action} ${o.branch}.`)
      )
      await refresh()
    },
    [refresh]
  )

  // Nothing to reclaim is the normal case; an empty panel would be noise.
  if (loaded && orphans.length === 0) return null

  return (
    <section>
      <h3 className="text-[14px] font-bold text-zinc-100">Reclaim</h3>
      <p className="mt-1 max-w-xl text-[11.5px] leading-relaxed text-zinc-500">
        Worktrees left behind by an agent that did not close cleanly. Brutus lists them and does
        nothing else — merging or removing is your call, one at a time. Removing deletes the
        directory only; the branch and its commits always survive.
      </p>

      {note && <p className="mt-3 text-[11px] text-emerald-400">{note}</p>}

      <div className="mt-4 flex flex-col gap-1.5">
        {orphans.map((o) => (
          <div
            key={o.dir}
            className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11.5px] text-zinc-200">{o.branch}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-zinc-500">
                {o.unmerged > 0 ? (
                  <span className="text-amber-400">
                    {o.unmerged} unmerged commit{o.unmerged === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span>nothing unmerged</span>
                )}
                <span className="text-zinc-700">·</span>
                <span className="truncate" title={o.dir}>
                  {o.missing ? 'directory already gone' : o.dir.split(/[/\\]/).slice(-1)[0]}
                </span>
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {o.unmerged > 0 && !o.missing && (
                <button
                  onClick={() => void act(o, 'merge')}
                  disabled={busy !== null}
                  className="cursor-pointer rounded-lg px-2.5 py-1 text-[10.5px] font-medium text-emerald-400 transition-colors hover:bg-emerald-500/15 disabled:opacity-40"
                >
                  Merge
                </button>
              )}
              <button
                onClick={() => void act(o, 'remove')}
                disabled={busy !== null}
                title="Deletes the directory; the branch is kept"
                className="cursor-pointer rounded-lg px-2.5 py-1 text-[10.5px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * A setting that is either on or off.
 *
 * `requires` is shown when the toggle is disabled, so a greyed control always
 * explains what would enable it rather than leaving you guessing.
 */
function Toggle({
  on,
  onChange,
  title,
  blurb,
  disabled,
  danger,
  requires
}: {
  on: boolean
  onChange: (v: boolean) => void
  title: string
  blurb: string
  disabled?: boolean
  danger?: boolean
  requires?: string
}): ReactElement {
  return (
    <div
      className={`flex items-start gap-4 rounded-xl border px-3.5 py-3 ${
        disabled
          ? 'border-white/[0.05] bg-white/[0.015] opacity-60'
          : 'border-white/[0.06] bg-white/[0.025]'
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold text-zinc-100">{title}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{blurb}</p>
        {disabled && requires && (
          <p className="mt-1.5 text-[10.5px] font-medium text-amber-400/80">{requires}</p>
        )}
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={title}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`mt-0.5 flex h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors ${
          disabled
            ? 'cursor-not-allowed bg-white/[0.06]'
            : on
              ? `cursor-pointer ${danger ? 'bg-red-500' : 'bg-emerald-500'}`
              : 'cursor-pointer bg-white/10'
        }`}
      >
        <span
          className={`block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${
            on ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

function Row({ item, children }: { item: DockItem; children: ReactNode }): ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${item.available ? 'bg-current' : 'bg-zinc-700'} ${item.accent}`}
      />
      <span className="flex-1 truncate text-[12px] text-zinc-200">{item.label}</span>
      {!item.available && (
        <span
          title={item.install ? `Install with: ${item.install}` : undefined}
          className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-amber-400/90"
        >
          NOT INSTALLED
        </span>
      )}
      <div className="flex shrink-0 items-center gap-0.5">{children}</div>
    </div>
  )
}
