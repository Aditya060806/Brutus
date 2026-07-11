import { useState, useEffect, useRef, useCallback } from 'react'
import {
  RiCloseLine,
  RiLoader4Line,
  RiFolderOpenLine,
  RiSparkling2Line,
  RiSearchLine,
  RiNodeTree,
  RiFileChartLine,
  RiErrorWarningLine,
  RiDownloadLine
} from 'react-icons/ri'

const STAGE_LABEL: Record<string, string> = {
  scanning: 'Discovering documents',
  extracting: 'Reading documents',
  reasoning: 'Extracting entities & relationships',
  ingested: 'Document ingested',
  done: 'Done',
  error: 'Error'
}

// stable color per entity type
const TYPE_COLORS: Record<string, string> = {
  Equipment: '#ef4444', Tag: '#f59e0b', Instrument: '#eab308', Parameter: '#84cc16',
  Material: '#22c55e', Personnel: '#14b8a6', Procedure: '#06b6d4', Regulation: '#3b82f6',
  Standard: '#6366f1', Incident: '#dc2626', WorkOrder: '#8b5cf6', Inspection: '#a855f7',
  Area: '#ec4899', System: '#f43f5e', Vendor: '#0ea5e9', FailureMode: '#fb7185',
  Hazard: '#f97316', Document: '#94a3b8', Date: '#64748b', Metric: '#10b981'
}
const colorOf = (t: string): string => TYPE_COLORS[t] || '#94a3b8'

interface VizNode { id: string; name: string; type: string; mentions: number; x?: number; y?: number; vx?: number; vy?: number }
interface VizEdge { source: string; target: string; type: string }
interface Stats {
  name: string
  documents: number
  nodes: number
  edges: number
  chunks: number
  nodeTypes: Record<string, number>
  edgeTypes: Record<string, number>
  topEntities: { name: string; type: string; mentions: number; connections: number }[]
  viz?: { nodes: VizNode[]; edges: VizEdge[] }
}

const getGeminiKey = async (): Promise<string> => {
  try {
    const keys = await window.electron.ipcRenderer.invoke('secure-get-keys')
    return (keys?.geminiKey || localStorage.getItem('brutus_custom_api_key') || '').trim()
  } catch {
    return (localStorage.getItem('brutus_custom_api_key') || '').trim()
  }
}

export default function KnowledgeGraphWidget() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'build' | 'ask' | 'graph'>('build')
  const [graphName, setGraphName] = useState('default')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [buildErr, setBuildErr] = useState('')

  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState('')
  const [sources, setSources] = useState<string[]>([])

  const logRef = useRef<HTMLDivElement>(null)

  const refreshStats = useCallback(async (name: string) => {
    const r = await window.electron.ipcRenderer.invoke('kg-stats', { graphName: name })
    if (r?.success) setStats(r)
  }, [])

  useEffect(() => {
    const openHandler = () => {
      setOpen(true)
      refreshStats(graphName)
    }
    window.addEventListener('open-knowledge-graph', openHandler)
    const progress = (_e: unknown, p: any) => {
      if (!p) return
      setStage(p.stage || '')
      const label = STAGE_LABEL[p.stage] || p.stage || ''
      const extra = p.nodes != null ? ` (${p.nodes} entities, ${p.edges} links)` : ''
      setLog((l) => [...l.slice(-40), (p.message || label) + extra])
    }
    window.electron.ipcRenderer.on('kg-progress', progress)
    return () => {
      window.removeEventListener('open-knowledge-graph', openHandler)
      window.electron.ipcRenderer.removeAllListeners('kg-progress')
    }
  }, [graphName, refreshStats])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [log])

  const pickFolder = async () => {
    try {
      const r = await window.electron.ipcRenderer.invoke('kg-pick-target')
      if (r?.success && r.path) setTarget(r.path)
    } catch {
      /* user can paste a path manually */
    }
  }

  const build = async () => {
    if (!target.trim() || busy) return
    const geminiKey = await getGeminiKey()
    if (!geminiKey) {
      setBuildErr('Missing Gemini API Key. Add it in Settings → API Keys.')
      return
    }
    setBusy(true)
    setBuildErr('')
    setLog([])
    setStage('scanning')
    try {
      const r = await window.electron.ipcRenderer.invoke('kg-build', {
        target: target.trim(),
        graphName: graphName.trim() || 'default',
        geminiKey
      })
      if (r?.success) {
        setStats(r)
        setTab('graph')
        await refreshStats(graphName.trim() || 'default')
      } else {
        setBuildErr(r?.error || 'Build failed.')
      }
    } catch (e) {
      setBuildErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const ask = async () => {
    if (!question.trim() || asking) return
    const geminiKey = await getGeminiKey()
    if (!geminiKey) {
      setAnswer('⚠️ Missing Gemini API Key. Add it in Settings → API Keys.')
      return
    }
    setAsking(true)
    setAnswer('')
    setSources([])
    try {
      const r = await window.electron.ipcRenderer.invoke('kg-query', {
        query: question.trim(),
        graphName: graphName.trim() || 'default',
        geminiKey
      })
      if (r?.success) {
        setAnswer(r.answer)
        setSources(r.sources || [])
      } else {
        setAnswer(`❌ ${r?.error}`)
      }
    } catch (e) {
      setAnswer(`❌ ${String(e)}`)
    } finally {
      setAsking(false)
    }
  }

  const exportGraph = async (format: 'mermaid' | 'json') => {
    const r = await window.electron.ipcRenderer.invoke('kg-export', {
      format,
      graphName: graphName.trim() || 'default'
    })
    if (r?.success) window.electron.ipcRenderer.invoke('file:open', r.path).catch(() => {})
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[9075] flex items-center justify-center bg-black/80 backdrop-blur-xl animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl border border-cyan-500/30 bg-zinc-950/95 shadow-[0_24px_70px_rgba(0,0,0,0.7)]">
        {/* header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <RiNodeTree className="text-cyan-400" size={20} />
            <div className="flex flex-col leading-none">
              <span className="text-sm font-bold tracking-[0.18em] text-zinc-100 uppercase">
                Knowledge Graph
              </span>
              <span className="text-[10px] font-mono text-cyan-400/60 tracking-widest mt-0.5">
                INDUSTRIAL OPERATIONS BRAIN
              </span>
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 text-zinc-500 hover:text-white rounded-full hover:bg-white/5 transition-all"
          >
            <RiCloseLine size={20} />
          </button>
        </div>

        {/* tabs */}
        <div className="flex items-center gap-1 px-6 pt-3">
          {([
            ['build', 'Build', RiNodeTree],
            ['ask', 'Ask', RiSearchLine],
            ['graph', 'Graph', RiFileChartLine]
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => {
                setTab(id)
                if (id === 'graph') refreshStats(graphName.trim() || 'default')
              }}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-t-lg text-xs font-bold tracking-widest uppercase transition-all ${
                tab === id
                  ? 'bg-cyan-500/15 text-cyan-300 border-b-2 border-cyan-400'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2 pb-2">
            <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">Graph</span>
            <input
              value={graphName}
              onChange={(e) => setGraphName(e.target.value)}
              disabled={busy}
              className="w-32 bg-[#050505] border border-white/10 rounded-md px-2 py-1 text-xs text-cyan-200 outline-none focus:border-cyan-500/40"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-small p-6 pt-4">
          {tab === 'build' && (
            <BuildTab
              target={target}
              setTarget={setTarget}
              pickFolder={pickFolder}
              build={build}
              busy={busy}
              stage={stage}
              log={log}
              logRef={logRef}
              buildErr={buildErr}
              stats={stats}
            />
          )}
          {tab === 'ask' && (
            <AskTab
              question={question}
              setQuestion={setQuestion}
              ask={ask}
              asking={asking}
              answer={answer}
              sources={sources}
              hasGraph={!!stats?.nodes}
            />
          )}
          {tab === 'graph' && <GraphTab stats={stats} exportGraph={exportGraph} />}
        </div>
      </div>
    </div>
  )
}

// ─── BUILD TAB ──────────────────────────────────────────────────────────
function BuildTab(props: any) {
  const { target, setTarget, pickFolder, build, busy, stage, log, logRef, buildErr, stats } = props
  return (
    <div className="space-y-5">
      <div>
        <label className="text-[10px] text-zinc-400 font-mono tracking-widest uppercase">
          Documents to ingest (file or folder)
        </label>
        <div className="mt-2 flex gap-2">
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={busy}
            placeholder="C:\Plant\Docs  (PDF, DOCX, XLSX, CSV, TXT, MD, drawings)"
            className="flex-1 bg-[#050505] border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-cyan-500/40 disabled:opacity-50"
          />
          <button
            onClick={pickFolder}
            disabled={busy}
            className="flex items-center gap-2 px-3 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:border-cyan-500/40 text-xs font-bold transition-all disabled:opacity-50"
          >
            <RiFolderOpenLine size={16} /> Browse
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-500">
          Extracts equipment, tags, parameters, procedures, regulations, incidents & their
          relationships — then embeds the text for GraphRAG querying. Re-running adds only new files.
        </p>
      </div>

      <button
        onClick={build}
        disabled={busy || !target.trim()}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {busy ? <RiLoader4Line className="animate-spin" size={18} /> : <RiSparkling2Line size={18} />}
        {busy ? 'Building Graph…' : 'Build Knowledge Graph'}
      </button>

      {(busy || log.length > 0) && (
        <div
          ref={logRef}
          className="max-h-48 overflow-y-auto scrollbar-small bg-[#050505] border border-white/10 rounded-lg p-3 space-y-1.5"
        >
          {log.map((line: string, i: number) => (
            <div key={i} className="flex items-center gap-2 text-xs font-mono text-zinc-400">
              <span className="text-cyan-400/60">›</span> {line}
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-xs font-mono text-cyan-400">
              <RiLoader4Line className="animate-spin" size={13} />
              {STAGE_LABEL[stage] || 'Working'}…
            </div>
          )}
        </div>
      )}

      {buildErr && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 flex items-center gap-2 text-red-300 text-sm">
          <RiErrorWarningLine size={18} /> {buildErr}
        </div>
      )}

      {stats && stats.nodes > 0 && (
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            ['Docs', stats.documents],
            ['Entities', stats.nodes],
            ['Relationships', stats.edges],
            ['Chunks', stats.chunks]
          ].map(([k, v]) => (
            <div key={k as string} className="rounded-lg bg-white/5 border border-white/10 py-3">
              <div className="text-xl font-bold text-cyan-300">{v as number}</div>
              <div className="text-[10px] text-zinc-500 uppercase tracking-widest">{k as string}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── ASK TAB ────────────────────────────────────────────────────────────
function AskTab(props: any) {
  const { question, setQuestion, ask, asking, answer, sources, hasGraph } = props
  const samples = [
    'Which equipment is governed by OISD or the Factory Act?',
    'What conditions preceded the incident, and what caused it?',
    'Summarise maintenance and inspections for the main asset.',
    'Which hazards are associated with confined-space entry here?'
  ]
  return (
    <div className="space-y-4">
      {!hasGraph && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          No graph loaded yet for this name. Build one in the <b>Build</b> tab first.
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="Ask anything about the ingested documents…"
          className="flex-1 bg-[#050505] border border-white/10 rounded-lg px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-cyan-500/40"
        />
        <button
          onClick={ask}
          disabled={asking || !question.trim()}
          className="flex items-center gap-2 px-5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-xs font-bold tracking-widest uppercase transition-all disabled:opacity-30"
        >
          {asking ? <RiLoader4Line className="animate-spin" size={16} /> : <RiSearchLine size={16} />}
          Ask
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {samples.map((s) => (
          <button
            key={s}
            onClick={() => setQuestion(s)}
            className="text-[11px] px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-zinc-400 hover:text-cyan-300 hover:border-cyan-500/40 transition-all"
          >
            {s}
          </button>
        ))}
      </div>

      {(asking || answer) && (
        <div className="rounded-xl border border-white/10 bg-[#050505] p-4">
          {asking ? (
            <div className="flex items-center gap-2 text-cyan-400 text-sm font-mono">
              <RiLoader4Line className="animate-spin" size={15} /> Reasoning over the graph…
            </div>
          ) : (
            <>
              <div className="text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">{answer}</div>
              {sources.length > 0 && (
                <div className="mt-3 pt-3 border-t border-white/5 flex flex-wrap gap-1.5">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-widest mr-1">Sources</span>
                  {sources.map((s: string) => (
                    <span key={s} className="text-[11px] px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── GRAPH TAB ──────────────────────────────────────────────────────────
function GraphTab(props: { stats: Stats | null; exportGraph: (f: 'mermaid' | 'json') => void }) {
  const { stats, exportGraph } = props
  if (!stats || !stats.nodes) {
    return (
      <div className="py-16 text-center text-zinc-500 text-sm">
        <RiNodeTree size={40} className="mx-auto mb-3 opacity-40" />
        No graph yet. Build one in the <b className="text-zinc-300">Build</b> tab.
      </div>
    )
  }
  const nodeTypeRows = Object.entries(stats.nodeTypes || {}).sort((a, b) => b[1] - a[1])
  const usedTypes = nodeTypeRows.map(([t]) => t)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-sm text-zinc-300">
          <b className="text-cyan-300">{stats.nodes}</b> entities ·{' '}
          <b className="text-cyan-300">{stats.edges}</b> relationships ·{' '}
          <b className="text-cyan-300">{stats.documents}</b> docs
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => exportGraph('mermaid')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:border-cyan-500/40 text-[11px] font-bold tracking-widest uppercase transition-all"
          >
            <RiDownloadLine size={13} /> Mermaid
          </button>
          <button
            onClick={() => exportGraph('json')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-zinc-300 hover:border-cyan-500/40 text-[11px] font-bold tracking-widest uppercase transition-all"
          >
            <RiDownloadLine size={13} /> JSON
          </button>
        </div>
      </div>

      <GraphCanvas viz={stats.viz} />

      {/* legend */}
      <div className="flex flex-wrap gap-2">
        {usedTypes.map((t) => (
          <div key={t} className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorOf(t) }} />
            {t} <span className="text-zinc-600">({stats.nodeTypes[t]})</span>
          </div>
        ))}
      </div>

      {/* top entities */}
      <div>
        <div className="text-[10px] text-zinc-500 uppercase tracking-widest mb-2">Most-connected entities</div>
        <div className="space-y-1.5">
          {stats.topEntities.slice(0, 8).map((e) => (
            <div key={e.name} className="flex items-center gap-2 text-xs">
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: colorOf(e.type) }} />
              <span className="text-zinc-200 truncate">{e.name}</span>
              <span className="text-zinc-600">{e.type}</span>
              <span className="ml-auto text-zinc-500 font-mono">{e.connections} links · {e.mentions}×</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── force-directed SVG canvas ──────────────────────────────────────────
function GraphCanvas({ viz }: { viz?: { nodes: VizNode[]; edges: VizEdge[] } }) {
  const [tick, setTick] = useState(0)
  const nodesRef = useRef<VizNode[]>([])
  const W = 640
  const H = 380

  useEffect(() => {
    if (!viz || !viz.nodes.length) {
      nodesRef.current = []
      setTick((t) => t + 1)
      return
    }
    // init positions on a circle
    const nodes: VizNode[] = viz.nodes.map((n, i) => {
      const a = (i / viz.nodes.length) * Math.PI * 2
      return { ...n, x: W / 2 + Math.cos(a) * 150, y: H / 2 + Math.sin(a) * 110, vx: 0, vy: 0 }
    })
    const index = new Map(nodes.map((n, i) => [n.id, i]))
    const edges = viz.edges
      .map((e) => ({ s: index.get(e.source), t: index.get(e.target) }))
      .filter((e) => e.s != null && e.t != null) as { s: number; t: number }[]

    // simple force simulation, fixed iterations (synchronous, then render)
    const ITER = 240
    const k = 42 // ideal edge length-ish
    for (let it = 0; it < ITER; it++) {
      // repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = nodes[i].x! - nodes[j].x!
          let dy = nodes[i].y! - nodes[j].y!
          let d2 = dx * dx + dy * dy || 0.01
          const f = (k * k) / d2
          const d = Math.sqrt(d2)
          const fx = (dx / d) * f
          const fy = (dy / d) * f
          nodes[i].vx! += fx; nodes[i].vy! += fy
          nodes[j].vx! -= fx; nodes[j].vy! -= fy
        }
      }
      // attraction along edges
      for (const e of edges) {
        const a = nodes[e.s], b = nodes[e.t]
        const dx = a.x! - b.x!, dy = a.y! - b.y!
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const f = (d * d) / k / 14
        const fx = (dx / d) * f, fy = (dy / d) * f
        a.vx! -= fx; a.vy! -= fy
        b.vx! += fx; b.vy! += fy
      }
      // center gravity + integrate + cool
      const cool = 0.85
      for (const n of nodes) {
        n.vx! += (W / 2 - n.x!) * 0.005
        n.vy! += (H / 2 - n.y!) * 0.005
        n.x! += Math.max(-12, Math.min(12, n.vx!))
        n.y! += Math.max(-12, Math.min(12, n.vy!))
        n.vx! *= cool; n.vy! *= cool
        n.x = Math.max(16, Math.min(W - 16, n.x!))
        n.y = Math.max(16, Math.min(H - 16, n.y!))
      }
    }
    nodesRef.current = nodes
    ;(GraphCanvas as any)._edges = edges
    setTick((t) => t + 1)
  }, [viz])

  const nodes = nodesRef.current
  const edges: { s: number; t: number }[] = (GraphCanvas as any)._edges || []
  const maxMentions = Math.max(1, ...nodes.map((n) => n.mentions))

  return (
    <div className="rounded-xl border border-white/10 bg-[#050505] overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 380 }}>
        {nodes.length > 0 &&
          edges.map((e, i) => {
            const a = nodes[e.s], b = nodes[e.t]
            if (!a || !b) return null
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#ffffff" strokeOpacity={0.1} strokeWidth={0.7} />
          })}
        {nodes.map((n) => {
          const r = 4 + (n.mentions / maxMentions) * 7
          return (
            <g key={n.id}>
              <circle cx={n.x} cy={n.y} r={r} fill={colorOf(n.type)} fillOpacity={0.85} stroke="#000" strokeWidth={0.5}>
                <title>{`${n.name} (${n.type}) — ${n.mentions}×`}</title>
              </circle>
              {r > 8 && (
                <text x={n.x} y={(n.y || 0) - r - 2} textAnchor="middle" fontSize={7} fill="#cbd5e1" className="pointer-events-none">
                  {n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name}
                </text>
              )}
            </g>
          )
        })}
        {nodes.length === 0 && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={12} fill="#64748b">
            No nodes to display
          </text>
        )}
      </svg>
    </div>
  )
}
