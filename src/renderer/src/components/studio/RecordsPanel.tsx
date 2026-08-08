import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  RiAlertLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCloseCircleLine,
  RiDownload2Line,
  RiFilterOffLine,
  RiLoader4Line,
  RiSearchLine,
  RiDeleteBinLine,
  RiFlaskLine
} from 'react-icons/ri'
import SourceChecklist from './SourceChecklist'
import {
  studio,
  type FilterOptions,
  type RecordHit,
  type RecordQuery
} from '@renderer/services/studio-client'

/**
 * Everything the agents have produced, searchable.
 *
 * ── WHY SEARCH GOES THROUGH MAIN ───────────────────────────────────────────
 * The records live on disk in the main process and the outputs are long. Pulling
 * every record over IPC to filter them in the renderer would ship the entire
 * corpus on each keystroke; sending the query instead sends a few bytes and gets
 * back only what matched — with the match offsets already computed, which is
 * what makes highlighting possible without re-scanning the text here.
 *
 * ── WHY RESET IS THE SAME PATH AS AN EMPTY QUERY ───────────────────────────
 * Reset clears the controls and re-runs the same call. There is no separate
 * "show everything" branch that could drift from the filtered one — the empty
 * query IS the unfiltered list, in the renderer and in main alike.
 */

const EMPTY: RecordQuery = {
  text: '',
  section: 'any',
  status: 'any',
  owner: 'any',
  missingDataOnly: false
}

const STATUS_TONE: Record<string, string> = {
  done: 'text-emerald-400',
  running: 'text-amber-400',
  failed: 'text-red-400',
  aborted: 'text-zinc-500',
  blocked: 'text-zinc-600',
  pending: 'text-zinc-500',
  planned: 'text-zinc-400'
}

/** Wrap every occurrence of `term` in a mark. Case-insensitive. */
function Highlighted({ text, term }: { text: string; term: string }): ReactElement {
  if (!term.trim() || !text) return <>{text}</>

  const parts: ReactElement[] = []
  const hay = text.toLowerCase()
  const pin = term.toLowerCase()
  let at = 0
  let key = 0

  for (;;) {
    const found = hay.indexOf(pin, at)
    if (found === -1) break
    if (found > at) parts.push(<span key={key++}>{text.slice(at, found)}</span>)
    parts.push(
      <mark key={key++} className="rounded-[3px] bg-amber-400/25 px-[1px] text-amber-200">
        {text.slice(found, found + term.length)}
      </mark>
    )
    at = found + term.length
  }
  parts.push(<span key={key++}>{text.slice(at)}</span>)
  return <>{parts}</>
}

export interface RecordsPanelProps {
  /** The canvas this panel opened on. Records default to it. */
  workspaceId: string
}

export default function RecordsPanel({ workspaceId }: RecordsPanelProps): ReactElement {
  const [query, setQuery] = useState<RecordQuery>({ ...EMPTY, workspaceId })
  /**
   * Whether to look beyond this canvas.
   *
   * Defaults to off, for the same reason missions are scoped: a Dashboard
   * showing another project's runs is confusing rather than useful. Reviewing
   * across projects is a real thing to want though, so it is one click away —
   * and the toggle says which it is, rather than leaving you to guess why a run
   * you remember is not in the list.
   */
  const [allWorkspaces, setAllWorkspaces] = useState(false)
  const [hits, setHits] = useState<RecordHit[]>([])
  const [total, setTotal] = useState(0)
  const [options, setOptions] = useState<FilterOptions>({
    sections: [],
    statuses: [],
    owners: []
  })
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busyExport, setBusyExport] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  /**
   * Re-run on every change, debounced.
   *
   * 180ms: fast enough that it feels live while typing, slow enough that a
   * ten-character word is one round trip rather than ten.
   */
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      void studio.records(query).then((res) => {
        if (!live) return
        setHits(res.hits)
        setTotal(res.total)
        setOptions(res.options)
        setLoading(false)
      })
    }, 180)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  const patch = useCallback((next: Partial<RecordQuery>) => {
    setQuery((q) => ({ ...q, ...next }))
  }, [])

  useEffect(() => {
    setQuery((q) => ({ ...q, workspaceId, allWorkspaces }))
  }, [workspaceId, allWorkspaces])

  /**
   * Reset clears the filters, not the scope.
   *
   * Which workspace you are looking at is a place, not a filter — silently
   * teleporting someone somewhere else when they press Reset would be a
   * surprise, and they never asked for it.
   */
  const reset = useCallback(
    () => setQuery({ ...EMPTY, workspaceId, allWorkspaces }),
    [workspaceId, allWorkspaces]
  )

  /** Whether the seeded records are currently in the store. */
  const hasSamples = useMemo(() => hits.some((h) => h.record.sample), [hits])

  const filtered = useMemo(
    () =>
      Boolean(query.text?.trim()) ||
      query.section !== 'any' ||
      query.status !== 'any' ||
      query.owner !== 'any' ||
      Boolean(query.missingDataOnly),
    [query]
  )

  const exportPacket = useCallback(async (id: string, format: 'md' | 'json' | 'pdf') => {
    setBusyExport(id)
    try {
      const saved = await studio.exportRecord(id, format)
      setToast(saved ? `Saved to ${saved}` : null)
    } finally {
      setBusyExport(null)
    }
  }, [])

  /** Re-read after an edit, so the missing-data flag and warnings stay true. */
  const refresh = useCallback(() => {
    void studio.records(query).then((res) => {
      setHits(res.hits)
      setTotal(res.total)
    })
  }, [query])

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* ── Search and filters ── */}
      <div data-tour="records.search" className="flex flex-col gap-2">
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-2.5 py-2 transition-colors focus-within:border-red-500/30">
          <RiSearchLine size={13} className="shrink-0 text-zinc-500" />
          <input
            value={query.text ?? ''}
            onChange={(e) => patch({ text: e.target.value })}
            placeholder="Search everything the agents wrote…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600"
          />
          {loading && <RiLoader4Line size={12} className="shrink-0 animate-spin text-zinc-600" />}
          {Boolean(query.text) && (
            <button
              onClick={() => patch({ text: '' })}
              title="Clear the search"
              className="shrink-0 cursor-pointer rounded p-0.5 text-zinc-600 transition-colors hover:text-zinc-300"
            >
              <RiCloseCircleLine size={13} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Filter
            label="Section"
            value={query.section ?? 'any'}
            options={options.sections}
            onChange={(v) => patch({ section: v })}
          />
          <Filter
            label="Status"
            value={query.status ?? 'any'}
            options={options.statuses}
            onChange={(v) => patch({ status: v })}
          />
          <Filter
            label="Agent"
            value={query.owner ?? 'any'}
            options={options.owners}
            onChange={(v) => patch({ owner: v })}
          />

          <button
            onClick={() => patch({ missingDataOnly: !query.missingDataOnly })}
            aria-pressed={Boolean(query.missingDataOnly)}
            className={`flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors ${
              query.missingDataOnly
                ? 'bg-amber-400/15 text-amber-400'
                : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
            }`}
          >
            <RiAlertLine size={10} /> Missing data
          </button>

          {/* Only offered when there is something to reset — a permanently
              enabled Reset gives no signal about whether a filter is on. */}
          {filtered && (
            <button
              onClick={reset}
              className="ml-auto flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
            >
              <RiFilterOffLine size={10} /> Reset
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 px-0.5">
          <p className="text-[10px] text-zinc-600">
            {filtered
              ? `${hits.length} of ${total} task${total === 1 ? '' : 's'}`
              : `${total} task${total === 1 ? '' : 's'} recorded`}
          </p>

          <button
            onClick={() => setAllWorkspaces((v) => !v)}
            aria-pressed={allWorkspaces}
            className={`cursor-pointer rounded px-1.5 py-0.5 text-[9.5px] font-semibold transition-colors ${
              allWorkspaces
                ? 'bg-white/10 text-zinc-200'
                : 'text-zinc-600 hover:bg-white/5 hover:text-zinc-400'
            }`}
          >
            {allWorkspaces ? 'All workspaces' : 'This workspace'}
          </button>

          {/* The demonstration records, both ways. Removing them was promised
              as one click and had no button at all; putting them back needed
              an empty store, which after removing them it no longer was. */}
          <span className="ml-auto flex items-center gap-1">
            {hasSamples ? (
              <button
                onClick={() => void studio.seedRecords(true).then(refresh)}
                title="Delete the seeded demonstration records"
                className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-semibold text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-300"
              >
                <RiFlaskLine size={10} /> Remove samples
              </button>
            ) : (
              <button
                onClick={() => void studio.seedRecords(false).then(refresh)}
                title="Add three demonstration records"
                className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-semibold text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-300"
              >
                <RiFlaskLine size={10} /> Load samples
              </button>
            )}
          </span>
        </div>
      </div>

      {toast && (
        <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-2.5 py-1.5 text-[10.5px] text-emerald-300">
          {toast}
        </p>
      )}

      {/* ── Results ── */}
      {!loading && hits.length === 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-8 text-center">
          <p className="text-[12px] text-zinc-400">
            {total === 0 ? 'No agent tasks have been run yet.' : 'Nothing matches that.'}
          </p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-zinc-600">
            {total === 0
              ? 'Plan and run a crew from the New tab and it will be recorded here.'
              : 'Try a different word, or reset the filters.'}
          </p>
          {total === 0 && (
            <button
              onClick={() => void studio.seedRecords(false).then(refresh)}
              className="mt-3 cursor-pointer rounded-lg bg-white/[0.06] px-2.5 py-1 text-[10px] font-semibold text-zinc-300 transition-colors hover:bg-white/10"
            >
              Load sample records
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {hits.map((hit) => (
          <RecordRow
            key={hit.record.id}
            hit={hit}
            term={query.text ?? ''}
            open={openId === hit.record.id}
            exporting={busyExport === hit.record.id}
            onToggle={() => setOpenId((id) => (id === hit.record.id ? null : hit.record.id))}
            onExport={(format) => void exportPacket(hit.record.id, format)}
            onChanged={refresh}
          />
        ))}
      </div>
    </div>
  )
}

/** One filter select, showing only values that actually occur. */
function Filter({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}): ReactElement {
  const active = value !== 'any'
  return (
    <label className="flex items-center gap-1">
      <span className="text-[9.5px] uppercase tracking-wider text-zinc-600">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`cursor-pointer rounded-md border bg-black/40 px-1.5 py-1 text-[10px] outline-none transition-colors ${
          active ? 'border-red-500/30 text-zinc-100' : 'border-white/10 text-zinc-400'
        }`}
      >
        <option value="any">Any</option>
        {options.map((o) => (
          <option key={o} value={o} className="bg-zinc-950">
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

/** One task record: summary row, and everything about it when expanded. */
function RecordRow({
  hit,
  term,
  open,
  exporting,
  onToggle,
  onExport,
  onChanged
}: {
  hit: RecordHit
  term: string
  open: boolean
  exporting: boolean
  onToggle: () => void
  onExport: (format: 'md' | 'json' | 'pdf') => void
  onChanged: () => void
}): ReactElement {
  const record = hit.record
  const [notes, setNotes] = useState(record.notes ?? '')

  const owners = useMemo(
    () => Array.from(new Set(record.sections.map((s) => s.agentKind))),
    [record.sections]
  )

  /**
   * Recomputed here from the same rules main uses.
   *
   * A record carries facts, never verdicts, so this is the one place the badge
   * could disagree with the packet — and it does not, because both count an
   * unticked required item and an empty finished section the same way.
   */
  const missing = useMemo(() => {
    const out: string[] = []
    for (const i of record.checklist) if (i.required && !i.done) out.push(i.label)
    for (const s of record.sections) {
      if (s.status === 'done' && !s.output?.trim()) out.push(`${s.title} produced nothing`)
    }
    return out
  }, [record])

  const saveNotes = useCallback(() => {
    if (notes === (record.notes ?? '')) return
    void studio.updateRecord({ id: record.id, notes }).then(onChanged)
  }, [notes, record.id, record.notes, onChanged])

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        <span className="mt-0.5 shrink-0 text-zinc-600">
          {open ? <RiArrowDownSLine size={14} /> : <RiArrowRightSLine size={14} />}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] font-medium text-zinc-200">
              <Highlighted text={record.summary || record.task} term={term} />
            </span>
            {record.sample && (
              <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-bold text-sky-400">
                Sample
              </span>
            )}
            {missing.length > 0 && (
              <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-400">
                Missing data
              </span>
            )}
          </span>

          <span className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-zinc-600">
            <span className={STATUS_TONE[record.status] ?? 'text-zinc-500'}>{record.status}</span>
            <span>
              {record.sections.length} section{record.sections.length === 1 ? '' : 's'}
            </span>
            <span className="font-mono">{owners.join(' · ')}</span>
            <span>{new Date(record.createdAt).toLocaleDateString()}</span>
          </span>

          {/* Why this row matched — the excerpt, with the term marked. Shown
              only while searching, since otherwise there is nothing to explain. */}
          {term.trim() && hit.matches.length > 0 && (
            <span className="mt-1.5 flex flex-col gap-0.5">
              {hit.matches.slice(0, 2).map((m, i) => (
                <span key={i} className="text-[10px] leading-relaxed text-zinc-500">
                  <span className="text-zinc-600">{m.label}: </span>
                  …<Highlighted text={m.excerpt} term={term} />…
                </span>
              ))}
              {hit.matches.length > 2 && (
                <span className="text-[9.5px] text-zinc-700">
                  +{hit.matches.length - 2} more match
                  {hit.matches.length - 2 === 1 ? '' : 'es'}
                </span>
              )}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-white/[0.06] px-3 py-3">
          <p className="text-[10.5px] leading-relaxed text-zinc-500">
            <span className="text-zinc-600">Requested: </span>
            <Highlighted text={record.task} term={term} />
          </p>

          {missing.length > 0 && (
            <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-2.5 py-2">
              <p className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-amber-400">
                Missing data
              </p>
              <ul className="mt-1 space-y-0.5">
                {missing.map((m) => (
                  <li key={m} className="text-[10.5px] leading-relaxed text-amber-200/80">
                    • {m}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <SourceChecklist
            items={record.checklist}
            readOnly
            onToggle={(itemId, done) =>
              void studio.updateRecord({ id: record.id, itemId, item: { done } }).then(onChanged)
            }
            onValue={() => {}}
          />

          {/* ── Sections ── */}
          <div className="flex flex-col gap-1.5">
            {record.sections.map((s) => (
              <div
                key={s.ref}
                className={`rounded-lg border px-2.5 py-2 ${
                  hit.sections.includes(s.ref)
                    ? 'border-amber-400/25 bg-amber-400/[0.03]'
                    : 'border-white/[0.06] bg-black/20'
                }`}
              >
                <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-zinc-200">
                  <Highlighted text={s.title} term={term} />
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] font-normal text-zinc-400">
                    {s.agentKind}
                  </span>
                  <span className="text-[10px] font-normal text-zinc-500">
                    <Highlighted text={s.role} term={term} />
                  </span>
                  <span
                    className={`ml-auto text-[9.5px] ${STATUS_TONE[s.status] ?? 'text-zinc-500'}`}
                  >
                    {s.status}
                  </span>
                </p>
                {s.output?.trim() ? (
                  <p className="mt-1 whitespace-pre-wrap rounded bg-white/[0.03] px-2 py-1.5 text-[10.5px] leading-relaxed text-zinc-400">
                    <Highlighted text={s.output} term={term} />
                  </p>
                ) : (
                  <p className="mt-1 text-[10px] italic text-zinc-600">No output was produced.</p>
                )}
                {s.note && <p className="mt-1 text-[10px] text-red-400/80">{s.note}</p>}
              </div>
            ))}
          </div>

          {/* ── Reviewer notes ── */}
          <div>
            <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
              Your notes
            </p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={saveNotes}
              rows={2}
              placeholder="Anything a reviewer should know. Goes into the packet."
              className="w-full resize-none rounded-lg border border-white/[0.07] bg-black/40 px-2 py-1.5 text-[10.5px] text-zinc-300 outline-none transition-colors placeholder:text-zinc-700 focus:border-red-500/30"
            />
          </div>

          <div className="flex items-center gap-1.5">
            {/* PDF leads: it is the one a reviewer can open anywhere, and the
                only format that carries the branding and pagination. Markdown
                and JSON stay as quiet siblings for editing and for scripts. */}
            <button
              data-tour="records.export"
              onClick={() => onExport('pdf')}
              disabled={exporting}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-red-500/15 px-2.5 py-1.5 text-[10.5px] font-semibold text-red-400 transition-colors hover:bg-red-500/25 disabled:opacity-40"
            >
              {exporting ? (
                <RiLoader4Line size={12} className="animate-spin" />
              ) : (
                <RiDownload2Line size={12} />
              )}
              Export PDF report
            </button>
            <button
              onClick={() => onExport('md')}
              disabled={exporting}
              className="cursor-pointer rounded-lg px-2 py-1.5 text-[10.5px] text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300 disabled:opacity-40"
            >
              as Markdown
            </button>
            <button
              onClick={() => onExport('json')}
              disabled={exporting}
              className="cursor-pointer rounded-lg px-2 py-1.5 text-[10.5px] text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300 disabled:opacity-40"
            >
              as JSON
            </button>
            <span className="ml-auto text-[9.5px] text-zinc-700">
              Includes sections, warnings, missing fields and your notes
            </span>

            {/* Destructive, so it is last, quiet, and asks first. */}
            <button
              onClick={() => {
                if (!confirm('Delete this task record? The packet cannot be exported afterwards.'))
                  return
                void studio.deleteRecord(record.id).then(onChanged)
              }}
              title="Delete this record"
              className="cursor-pointer rounded p-1 text-zinc-700 transition-colors hover:bg-red-500/10 hover:text-red-400"
            >
              <RiDeleteBinLine size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
