import { useState, useEffect, useRef } from 'react'
import {
  RiCloseLine,
  RiSlideshow3Line,
  RiSparkling2Line,
  RiLoader4Line,
  RiFilePpt2Line,
  RiFilePdf2Line,
  RiCheckboxCircleFill,
  RiErrorWarningLine
} from 'react-icons/ri'

const STAGE_LABEL: Record<string, string> = {
  research: 'Researching the topic',
  planning: 'Designing structure & palette',
  refine: 'Design director review',
  images: 'Sourcing contextual images',
  rendering: 'Rendering slides',
  qa: 'Visual QA — inspecting slides',
  'qa-fix': 'Fixing flagged slides',
  preview: 'Rendering PDF preview',
  done: 'Done',
  error: 'Error'
}

interface DeckResult {
  success: boolean
  path?: string
  pdfPath?: string | null
  title?: string
  slideCount?: number
  qaSlidesFlagged?: number
  error?: string
}

const getGeminiKey = async (): Promise<string> => {
  try {
    const keys = await window.electron.ipcRenderer.invoke('secure-get-keys')
    return (keys?.geminiKey || localStorage.getItem('brutus_custom_api_key') || '').trim()
  } catch {
    return (localStorage.getItem('brutus_custom_api_key') || '').trim()
  }
}

export default function DeckStudioWidget() {
  const [open, setOpen] = useState(false)
  const [brief, setBrief] = useState('')
  const [slideCount, setSlideCount] = useState<number | ''>('')
  const [qaOn, setQaOn] = useState(true)
  const [maxQuality, setMaxQuality] = useState(true)
  const [maxPasses, setMaxPasses] = useState(5)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [result, setResult] = useState<DeckResult | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const openHandler = () => setOpen(true)
    window.addEventListener('open-deck-studio', openHandler)

    const progress = (_e: unknown, p: any) => {
      if (!p) return
      setStage(p.stage || '')
      const label = STAGE_LABEL[p.stage] || p.stage || ''
      setLog((l) => [...l.slice(-20), p.message || label])
    }
    window.electron.ipcRenderer.on('deck-progress', progress)

    return () => {
      window.removeEventListener('open-deck-studio', openHandler)
      window.electron.ipcRenderer.removeAllListeners('deck-progress')
    }
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [log])

  const generate = async () => {
    if (!brief.trim() || busy) return
    const geminiKey = await getGeminiKey()
    if (!geminiKey) {
      setResult({ success: false, error: 'Missing Gemini API Key. Add it in Settings → API Keys.' })
      return
    }
    setBusy(true)
    setResult(null)
    setLog([])
    setStage('planning')
    try {
      const tavilyKey = localStorage.getItem('brutus_tailvy_api_key') || ''
      const r: DeckResult = await window.electron.ipcRenderer.invoke('deck-generate', {
        instructions: brief.trim(),
        geminiKey,
        tavilyKey,
        research: true,
        qaLoop: qaOn,
        quality: maxQuality ? 'max' : 'standard',
        maxPasses,
        slideCount: slideCount || undefined,
        fetchImages: true,
        renderPdf: true
      })
      setResult(r)
    } catch (e) {
      setResult({ success: false, error: String(e) })
    } finally {
      setBusy(false)
    }
  }

  const openFile = (p?: string | null) => {
    if (p) window.electron.ipcRenderer.invoke('file:open', p).catch(() => {})
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[9075] flex items-center justify-center bg-black/80 backdrop-blur-xl animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl border border-red-500/30 bg-zinc-950/95 shadow-[0_24px_70px_rgba(0,0,0,0.7)]">
        {/* header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <RiSlideshow3Line className="text-red-500" size={20} />
            <div className="flex flex-col leading-none">
              <span className="text-sm font-bold tracking-[0.18em] text-zinc-100 uppercase">
                Deck Studio
              </span>
              <span className="text-[10px] font-mono text-red-500/60 tracking-widest mt-0.5">
                PRESENTATION INTELLIGENCE
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

        <div className="flex-1 overflow-y-auto scrollbar-small p-6 space-y-5">
          {/* brief */}
          <div>
            <label className="text-[10px] text-zinc-400 font-mono tracking-widest uppercase">
              What should the deck be about?
            </label>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              disabled={busy}
              rows={4}
              placeholder="e.g. A 12-slide hackathon pitch for an AI study assistant for college students. Investor tone, emphasize the problem, demo, and business model."
              className="mt-2 w-full bg-[#050505] border border-white/10 rounded-lg p-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 resize-none outline-none focus:border-red-500/40 transition-colors disabled:opacity-50"
            />
          </div>

          {/* controls */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Slides</span>
              <input
                type="number"
                min={3}
                max={30}
                value={slideCount}
                onChange={(e) => setSlideCount(e.target.value ? Number(e.target.value) : '')}
                disabled={busy}
                placeholder="auto"
                className="w-20 bg-[#050505] border border-white/10 rounded-md px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-red-500/40 disabled:opacity-50"
              />
            </div>

            <button
              onClick={() => setMaxQuality((v) => !v)}
              disabled={busy}
              title="Adds a design-director critique pass and more QA cycles. Takes longer, looks better."
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold tracking-wide border transition-all disabled:opacity-50 ${
                maxQuality
                  ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                  : 'bg-white/5 border-white/10 text-zinc-400'
              }`}
            >
              <RiSparkling2Line size={14} /> Max Quality {maxQuality ? 'ON' : 'OFF'}
            </button>

            <button
              onClick={() => setQaOn((v) => !v)}
              disabled={busy}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold tracking-wide border transition-all disabled:opacity-50 ${
                qaOn
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-white/5 border-white/10 text-zinc-400'
              }`}
            >
              <RiSparkling2Line size={14} /> AI Visual QA {qaOn ? 'ON' : 'OFF'}
            </button>

            {qaOn && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">QA passes</span>
                <select
                  value={maxPasses}
                  onChange={(e) => setMaxPasses(Number(e.target.value))}
                  disabled={busy}
                  className="bg-[#050505] border border-white/10 rounded-md px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-red-500/40 disabled:opacity-50"
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={5}>5</option>
                  <option value={6}>6</option>
                  <option value={7}>7</option>
                  <option value={8}>8</option>
                </select>
              </div>
            )}
          </div>

          <button
            onClick={generate}
            disabled={busy || !brief.trim()}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-200 text-sm font-bold tracking-widest uppercase transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {busy ? <RiLoader4Line className="animate-spin" size={18} /> : <RiSparkling2Line size={18} />}
            {busy ? 'Building…' : 'Generate Deck'}
          </button>

          {/* progress log */}
          {(busy || log.length > 0) && (
            <div
              ref={logRef}
              className="max-h-40 overflow-y-auto scrollbar-small bg-[#050505] border border-white/10 rounded-lg p-3 space-y-1.5"
            >
              {log.map((line, i) => (
                <div key={i} className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                  <span className="text-red-500/60">›</span> {line}
                </div>
              ))}
              {busy && (
                <div className="flex items-center gap-2 text-xs font-mono text-red-400">
                  <RiLoader4Line className="animate-spin" size={13} />
                  {STAGE_LABEL[stage] || 'Working'}…
                </div>
              )}
            </div>
          )}

          {/* result */}
          {result && (
            <div
              className={`rounded-xl border p-4 ${
                result.success
                  ? 'bg-emerald-500/10 border-emerald-500/30'
                  : 'bg-red-500/10 border-red-500/30'
              }`}
            >
              {result.success ? (
                <>
                  <div className="flex items-center gap-2 text-emerald-300 font-bold text-sm">
                    <RiCheckboxCircleFill size={18} /> "{result.title}" — {result.slideCount} slides
                  </div>
                  <div className="mt-1.5 text-xs text-zinc-400 flex items-center gap-1.5">
                    {result.qaSlidesFlagged ? (
                      <>
                        <RiErrorWarningLine className="text-amber-400" /> QA flagged{' '}
                        {result.qaSlidesFlagged} slide(s) — give them a final glance.
                      </>
                    ) : (
                      <>
                        <RiCheckboxCircleFill className="text-emerald-400" /> Visual QA passed clean.
                      </>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => openFile(result.path)}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-zinc-200 hover:border-white/30 text-xs font-bold tracking-widest transition-all"
                    >
                      <RiFilePpt2Line size={15} /> OPEN DECK
                    </button>
                    {result.pdfPath && (
                      <button
                        onClick={() => openFile(result.pdfPath)}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-zinc-200 hover:border-white/30 text-xs font-bold tracking-widest transition-all"
                      >
                        <RiFilePdf2Line size={15} /> OPEN PDF
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-red-300 text-sm">
                  <RiErrorWarningLine size={18} /> {result.error}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
