import { useCallback, useEffect, useState } from 'react'
import {
  RiCheckLine,
  RiCloseLine,
  RiInboxLine,
  RiRefreshLine,
  RiShieldCheckLine,
  RiStopFill,
  RiTimeLine
} from 'react-icons/ri'
import { Badge, Button, Card, Textarea, cn } from '@renderer/components/ui'
import { openSettings } from '@renderer/components/settings/open-settings'

/**
 * Brutus Desk — the inbox loop.
 *
 * Three lists and a status strip, deliberately. The whole promise is "nothing
 * falls through", so the view answers exactly three questions: what is waiting
 * on me, what did Brutus do without me, and what has been promised.
 */

interface Triage {
  category: string
  priority: 1 | 2 | 3
  reason: string
  confidence: number
}

interface DeskThread {
  threadId: string
  subject: string
  contact: string
  lastMessageAt: number
  state: string
  triage?: Triage
  draft?: { to: string; subject: string; body: string; kind: string }
  blockedReason?: string
  lastAutoReplyAt?: number
}

interface Commitment {
  id: string
  text: string
  owedBy: 'us' | 'them'
  dueAt: number | null
  contact?: string
}

interface DeskState {
  config: { level: 'off' | 'draft' | 'autonomous'; pollMinutes: number }
  engine: {
    lastRunAt: number
    nextRunAt: number
    running: boolean
    busy: boolean
    lastError?: string
  }
  needsYou: DeskThread[]
  handled: DeskThread[]
  triaged: DeskThread[]
  commitments: Commitment[]
}

type Tab = 'needs-you' | 'handled' | 'commitments'

const when = (ms: number): string => {
  if (!ms) return 'never'
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3600_000)}h ago`
  return new Date(ms).toLocaleDateString()
}

/**
 * Turn an IPC rejection into something a person can act on.
 *
 * "No handler registered for 'desk-state'" names an Electron internal and tells
 * the user nothing they can do. It has exactly one cause in practice — the
 * window is talking to a main process older than this build, which is what
 * happens when the app was left running across an update or a rebuild — and
 * exactly one fix.
 */
const explain = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err)
  if (/No handler registered/i.test(raw)) {
    return 'The Desk background service is not running in this window. Restart Brutus — this happens when the app was left open across an update.'
  }
  if (/Blocked ipcRenderer/i.test(raw)) {
    return 'The Desk channel was blocked by the preload bridge. This is a build problem, not something you can fix from here — please report it.'
  }
  return raw
}

const dueLabel = (dueAt: number | null): { text: string; overdue: boolean } => {
  if (!dueAt) return { text: 'no date', overdue: false }
  const diff = dueAt - Date.now()
  if (diff < 0) return { text: `${Math.round(-diff / 86_400_000)}d overdue`, overdue: true }
  return { text: `due in ${Math.max(1, Math.round(diff / 86_400_000))}d`, overdue: false }
}

const DeskView = (): React.JSX.Element => {
  const [state, setState] = useState<DeskState | null>(null)
  const [tab, setTab] = useState<Tab>('needs-you')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  // Two slots, not one. Every action ends with a `refresh()`, so a single slot
  // would let the successful refresh wipe the failure the user needs to read
  // roughly 20ms after it appeared.
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await window.electron.ipcRenderer.invoke('desk-state')
      if (res?.success) {
        setState(res)
        // Clear on success, so a transient failure does not leave a stale
        // banner sitting above data that is now fine.
        setLoadError('')
      } else {
        setLoadError(res?.error || 'The Desk could not read its data.')
      }
    } catch (err) {
      setLoadError(explain(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Cheap poll: reads local JSON, no network. Keeps the strip honest while a
    // background run is in flight.
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh])

  /**
   * One place every button goes through.
   *
   * Each of these used to call `invoke` bare. When the channel is missing — the
   * stale-main-process case — a bare call rejects, the rejection is unhandled,
   * and the button simply does nothing with no explanation anywhere. Routing
   * them through here means a failure always ends up on screen.
   */
  const send = useCallback(
    async (channel: string, payload?: unknown, fallback = 'That did not work'): Promise<boolean> => {
      setActionError('')
      try {
        const res = await window.electron.ipcRenderer.invoke(channel, payload)
        if (res && res.success === false) {
          setActionError(res.error || fallback)
          return false
        }
        return true
      } catch (err) {
        setActionError(explain(err))
        return false
      }
    },
    []
  )

  const runNow = async (): Promise<void> => {
    setBusy(true)
    try {
      await send('desk-run-now', undefined, 'The run could not be started')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const killSwitch = async (): Promise<void> => {
    await send('desk-stop', undefined, 'Could not stop the Desk')
    await refresh()
  }

  const approve = async (thread: DeskThread): Promise<void> => {
    setBusy(true)
    try {
      const ok = await send(
        'desk-approve',
        { threadId: thread.threadId, body: editing === thread.threadId ? editBody : undefined },
        'Could not send'
      )
      // Keep the editor open on failure — closing it would throw away an edit
      // the user made and the message they were trying to send.
      if (ok) setEditing(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const dismiss = async (thread: DeskThread): Promise<void> => {
    await send('desk-dismiss', { threadId: thread.threadId }, 'Could not dismiss that thread')
    await refresh()
  }

  const completeCommitment = async (id: string): Promise<void> => {
    await send('desk-commitment-done', { id }, 'Could not mark that done')
    await refresh()
  }

  const level = state?.config.level ?? 'off'
  const counts = {
    'needs-you': state?.needsYou.length ?? 0,
    handled: state?.handled.length ?? 0,
    commitments: state?.commitments.length ?? 0
  }

  return (
    <div className="scrollbar-small absolute inset-0 overflow-y-auto bg-canvas">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight text-content">Desk</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-content-muted">
              Brutus reads your inbox, works out what needs you, and drafts the replies.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={busy || state?.engine.busy}
              onClick={() => void runNow()}
              leadingIcon={busy || state?.engine.busy ? undefined : <RiRefreshLine size={14} />}
            >
              Run now
            </Button>
            {level !== 'off' && (
              <Button
                variant="secondary"
                tone="danger"
                size="sm"
                onClick={() => void killSwitch()}
                leadingIcon={<RiStopFill size={14} />}
              >
                Stop
              </Button>
            )}
          </div>
        </header>

        {/* ── Status strip ──
            The one place that answers "is this thing on, and when did it last
            do anything?" without needing to open settings. */}
        <Card tone="surface" className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
          <span className="flex items-center gap-2">
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                level === 'autonomous'
                  ? 'bg-primary-500'
                  : level === 'draft'
                    ? 'bg-amber-500'
                    : 'bg-line-strong'
              )}
            />
            <span className="text-[12px] font-medium text-content">
              {level === 'autonomous'
                ? 'Sending on its own'
                : level === 'draft'
                  ? 'Drafting only'
                  : 'Off'}
            </span>
          </span>

          <span className="text-[12px] text-content-muted">
            Last run {when(state?.engine.lastRunAt ?? 0)}
          </span>
          {level !== 'off' && (state?.engine.nextRunAt ?? 0) > 0 && (
            <span className="text-[12px] text-content-muted">
              every {state?.config.pollMinutes}m
            </span>
          )}

          <Button variant="tertiary" size="sm" className="ml-auto" onClick={() => openSettings()}>
            Configure
          </Button>
        </Card>

        {/* Newest first: what you just did, then whether the Desk can be read at
            all, then whatever the last background run reported. */}
        {(actionError || loadError || state?.engine.lastError) && (
          <Card tone="surface" className="border-coral-500/30 bg-coral-500/5 px-4 py-3">
            <p className="text-[12px] leading-relaxed text-coral-400">
              {actionError || loadError || state?.engine.lastError}
            </p>
          </Card>
        )}

        {level === 'off' && (
          <Card tone="surface" className="flex items-start gap-3 px-4 py-3.5">
            <RiShieldCheckLine size={16} className="mt-0.5 shrink-0 text-content-muted" />
            <p className="text-[12px] leading-relaxed text-content-muted">
              Brutus is not watching your inbox yet. Turn it on in Settings → Desk — start with
              drafting only, so you can see what it would have sent before it sends anything.
            </p>
          </Card>
        )}

        {/* ── Tabs ── */}
        <div className="flex gap-1.5">
          {(
            [
              ['needs-you', 'Needs you'],
              ['handled', 'Handled'],
              ['commitments', 'Commitments']
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? 'page' : undefined}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium',
                'transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                tab === id
                  ? 'bg-content text-canvas'
                  : 'bg-surface-muted text-content-muted hover:bg-hover hover:text-content-secondary'
              )}
            >
              {label}
              {counts[id] > 0 && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-[10px] tabular-nums',
                    tab === id ? 'bg-canvas/20' : 'bg-line'
                  )}
                >
                  {counts[id]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Needs you ── */}
        {tab === 'needs-you' &&
          (counts['needs-you'] === 0 ? (
            <Empty icon={<RiInboxLine size={26} />} title="Nothing waiting on you" />
          ) : (
            state?.needsYou.map((thread) => (
              <Card key={thread.threadId} tone="surface" className="overflow-hidden">
                <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-content">
                      {thread.subject}
                    </p>
                    <p className="truncate text-[11px] text-content-faint">
                      {thread.contact} · {when(thread.lastMessageAt)}
                    </p>
                  </div>
                  {thread.triage && (
                    <Badge tone={thread.triage.priority === 1 ? 'danger' : 'neutral'}>
                      P{thread.triage.priority}
                    </Badge>
                  )}
                </div>

                {thread.triage?.reason && (
                  <p className="border-b border-line-subtle px-4 py-2.5 text-[12px] text-content-secondary">
                    {thread.triage.reason}
                  </p>
                )}

                {/* Why it was held back. Shown always — a blocked action with no
                    reason gives the user nothing to decide with. */}
                {thread.blockedReason && (
                  <p className="border-b border-line-subtle bg-amber-500/5 px-4 py-2.5 text-[11px] leading-relaxed text-amber-400">
                    {thread.blockedReason}
                  </p>
                )}

                {thread.draft && (
                  <div className="px-4 py-3">
                    {editing === thread.threadId ? (
                      <Textarea
                        rows={6}
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        className="text-[12px]"
                      />
                    ) : (
                      <p className="whitespace-pre-wrap rounded-lg border border-line bg-canvas px-3 py-2.5 text-[12px] leading-relaxed text-content-secondary">
                        {thread.draft.body}
                      </p>
                    )}

                    <div className="mt-3 flex items-center gap-2">
                      <Button size="sm" loading={busy} onClick={() => void approve(thread)}>
                        Send
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          if (editing === thread.threadId) setEditing(null)
                          else {
                            setEditing(thread.threadId)
                            setEditBody(thread.draft!.body)
                          }
                        }}
                      >
                        {editing === thread.threadId ? 'Cancel edit' : 'Edit'}
                      </Button>
                      <Button
                        variant="tertiary"
                        size="sm"
                        className="ml-auto"
                        onClick={() => void dismiss(thread)}
                        leadingIcon={<RiCloseLine size={14} />}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            ))
          ))}

        {/* ── Handled ── */}
        {tab === 'handled' &&
          (counts.handled === 0 ? (
            <Empty
              icon={<RiCheckLine size={26} />}
              title="Brutus has not sent anything yet"
              note="Everything it sends on its own appears here, with the exact text."
            />
          ) : (
            state?.handled.map((thread) => (
              <Card key={thread.threadId} tone="surface" className="overflow-hidden">
                <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-content">
                      {thread.subject}
                    </p>
                    <p className="truncate text-[11px] text-content-faint">
                      {thread.contact} · replied {when(thread.lastAutoReplyAt ?? 0)}
                    </p>
                  </div>
                  <Badge tone="success" dot>
                    Sent
                  </Badge>
                </div>
                {thread.draft && (
                  <p className="whitespace-pre-wrap px-4 py-3 text-[12px] leading-relaxed text-content-secondary">
                    {thread.draft.body}
                  </p>
                )}
              </Card>
            ))
          ))}

        {/* ── Commitments ── */}
        {tab === 'commitments' &&
          (counts.commitments === 0 ? (
            <Empty icon={<RiTimeLine size={26} />} title="No open promises" />
          ) : (
            <Card tone="surface" className="overflow-hidden">
              <ul className="divide-y divide-line-subtle">
                {state?.commitments.map((c) => {
                  const due = dueLabel(c.dueAt)
                  return (
                    <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] text-content">{c.text}</p>
                        <p className="mt-0.5 text-[11px] text-content-faint">
                          {c.owedBy === 'us' ? 'You owe' : 'They owe'}
                          {c.contact ? ` · ${c.contact}` : ''}
                        </p>
                      </div>
                      <Badge tone={due.overdue ? 'danger' : 'neutral'}>{due.text}</Badge>
                      <Button
                        variant="tertiary"
                        size="sm"
                        iconOnly
                        aria-label="Mark done"
                        onClick={() => void completeCommitment(c.id)}
                      >
                        <RiCheckLine size={15} />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            </Card>
          ))}
      </div>
    </div>
  )
}

const Empty = ({
  icon,
  title,
  note
}: {
  icon: React.ReactNode
  title: string
  note?: string
}): React.JSX.Element => (
  <div className="flex flex-col items-center gap-2 py-14 text-center">
    <span className="text-content-faint">{icon}</span>
    <p className="text-[13px] font-medium text-content-secondary">{title}</p>
    {note && <p className="max-w-xs text-[11px] leading-relaxed text-content-faint">{note}</p>}
  </div>
)

export default DeskView
