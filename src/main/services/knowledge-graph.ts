import { IpcMain, app } from 'electron'
import { BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { GoogleGenAI } from '@google/genai'

/**
 * BRUTUS KNOWLEDGE GRAPH ENGINE — Industrial Operations Brain
 * -----------------------------------------------------------
 * Turns a pile of heterogeneous industrial documents (PDF / DOCX / XLSX / CSV /
 * TXT / MD / scanned drawings) into a persistent, queryable knowledge graph.
 *
 *   build   → ingest docs → extract entities + relationships (Gemini, strict
 *             industrial ontology) → merge into a deduped graph + embed chunks
 *   query   → GraphRAG: vector chunk retrieval ⨉ graph-neighborhood facts →
 *             cited, confidence-scored answer
 *   connect → BFS shortest path of relationships between two entities
 *   stats   → node/edge breakdown, top entities, document inventory
 *   export  → Mermaid diagram / JSON (architecture-diagram deliverable)
 *   pid     → parse a P&ID / engineering drawing image into tags + connections
 *
 * Storage mirrors the RAG-oracle convention: one JSON state file per graph in
 * userData/brutus_knowledge_graphs/<id>.json. Embeddings use the same
 * gemini-embedding-001 model the Oracle uses, so behaviour is consistent.
 */

// ─── types ────────────────────────────────────────────────────────────
interface KGNode {
  id: string
  type: string
  name: string
  aliases: string[]
  props: Record<string, string>
  docs: string[] // document ids that mention this node
  mentions: number
}

interface KGEdge {
  id: string
  source: string // node id
  target: string // node id
  type: string
  label: string
  docId: string
  confidence: number
}

interface KGDoc {
  id: string
  path: string
  name: string
  type: string
  ingestedAt: number
  chunkCount: number
}

interface KGChunk {
  id: string
  docId: string
  text: string
  embedding: number[]
}

interface KnowledgeGraph {
  graphId: string
  name: string
  createdAt: number
  updatedAt: number
  documents: KGDoc[]
  nodes: Record<string, KGNode>
  edges: KGEdge[]
  chunks: KGChunk[]
}

// ─── industrial ontology ──────────────────────────────────────────────
const NODE_TYPES = [
  'Equipment', 'Tag', 'Instrument', 'Parameter', 'Material', 'Personnel',
  'Procedure', 'Regulation', 'Standard', 'Incident', 'WorkOrder', 'Inspection',
  'Area', 'System', 'Vendor', 'FailureMode', 'Hazard', 'Document', 'Date', 'Metric'
]

const EDGE_TYPES = [
  'CONNECTED_TO', 'PART_OF', 'LOCATED_IN', 'GOVERNED_BY', 'REFERENCES',
  'MAINTAINED_BY', 'INSPECTED_BY', 'OPERATED_BY', 'CAUSED_BY', 'MITIGATED_BY',
  'REQUIRES', 'PRECEDED_BY', 'MEASURES', 'HAS_PARAMETER', 'AFFECTS', 'SUPPLIES',
  'COMPLIES_WITH', 'ASSOCIATED_WITH'
]

const EXTRACTION_PROMPT = `You are BRUTUS KNOWLEDGE GRAPH — an industrial knowledge engineer that reads operations documents (engineering drawings, P&IDs, maintenance work orders, SOPs, inspection reports, incident reports, regulatory filings, spreadsheets) and extracts a precise knowledge graph.

From the provided text, extract ENTITIES and RELATIONSHIPS for an asset-intensive industrial plant.

ENTITY TYPES (use ONLY these): ${NODE_TYPES.join(', ')}.
- Equipment: physical assets (pump, compressor, coke oven battery, transformer, UPS).
- Tag: alphanumeric equipment/line/instrument tags (e.g. P-101, FT-2305, 11KV-BUS-A).
- Instrument: sensors/transmitters/analyzers (gas detector, pressure transmitter).
- Parameter: a measurable process variable (pressure, temperature, flow, gas concentration) — put its value/unit in props if stated.
- Material: substances/grades (lithium, coke oven gas, LFP cell, diesel).
- Personnel: roles or named people (shift in-charge, safety officer).
- Procedure: SOPs, permits-to-work, method statements, test procedures.
- Regulation / Standard: OISD, Factory Act, DGMS, PESO, TIA-942, MITRE, BIS, etc.
- Incident / FailureMode / Hazard: events, failure modes, hazardous conditions.
- WorkOrder / Inspection: maintenance work orders, inspection records (put numbers/dates in props).
- Area / System: plant zones, units, systems (coke oven area, cooling system, 11kV switchyard).
- Vendor: OEMs / suppliers. Metric: KPIs/measurements. Date: significant dates.

RELATIONSHIP TYPES (use ONLY these): ${EDGE_TYPES.join(', ')}.

RULES
- Extract only what the text supports. NEVER invent entities, tags, values, or sources.
- Normalize entity names to their canonical form; list surface variants in "aliases".
- Keep names concise (≤ 6 words). Put values/units/IDs/dates in "props" (string→string).
- A relationship's source and target MUST each match a "name" you list in entities.
- Prefer specific tags over generic descriptions when a tag exists.
- If the text has no meaningful industrial content, return empty arrays.

Output ONLY this JSON (no markdown):
{
  "entities": [ { "name": str, "type": <one of the entity types>, "aliases": [str], "props": { str: str } } ],
  "relationships": [ { "source": str, "target": str, "type": <one of the relationship types>, "label": str } ]
}`

// ─── storage ──────────────────────────────────────────────────────────
const graphsDir = (): string => path.join(app.getPath('userData'), 'brutus_knowledge_graphs')
const idOf = (name: string): string =>
  crypto.createHash('md5').update(name.trim().toLowerCase() || 'default').digest('hex').slice(0, 12)
const graphFile = (graphId: string): string => path.join(graphsDir(), `${graphId}.json`)

const blankGraph = (name: string): KnowledgeGraph => ({
  graphId: idOf(name),
  name: name || 'default',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  documents: [],
  nodes: {},
  edges: [],
  chunks: []
})

async function loadGraph(name: string): Promise<KnowledgeGraph> {
  try {
    const data = await fs.readFile(graphFile(idOf(name)), 'utf-8')
    const g = JSON.parse(data) as KnowledgeGraph
    g.nodes ||= {}
    g.edges ||= []
    g.chunks ||= []
    g.documents ||= []
    return g
  } catch {
    return blankGraph(name)
  }
}

async function saveGraph(g: KnowledgeGraph): Promise<void> {
  g.updatedAt = Date.now()
  await fs.mkdir(graphsDir(), { recursive: true })
  await fs.writeFile(graphFile(g.graphId), JSON.stringify(g))
}

// ─── helpers ──────────────────────────────────────────────────────────
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const slug = (s: string): string =>
  (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

const nodeKey = (type: string, name: string): string => `${slug(type)}:${slug(name)}`

const stripJson = (t: string): string =>
  (t || '{}').replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim()

const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

const canonicalType = (t: string): string => {
  const found = NODE_TYPES.find((x) => x.toLowerCase() === String(t || '').toLowerCase())
  return found || 'Document'
}
const canonicalEdge = (t: string): string => {
  const found = EDGE_TYPES.find((x) => x.toLowerCase() === String(t || '').toLowerCase().replace(/\s+/g, '_'))
  return found || 'ASSOCIATED_WITH'
}

// ─── multi-format text extraction ─────────────────────────────────────
const TEXT_EXTS = ['.txt', '.md', '.csv', '.json', '.log', '.xml', '.yml', '.yaml', '.html', '.htm']
const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']
const SUPPORTED_EXTS = ['.pdf', '.docx', '.xlsx', '.xls', ...TEXT_EXTS, ...IMG_EXTS]

async function extractText(ai: any, filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  try {
    if (ext === '.pdf') {
      const { PDFParse } = await import('pdf-parse')
      const data = await fs.readFile(filePath)
      const parser = new PDFParse({ data: new Uint8Array(data) })
      try {
        const res = await parser.getText()
        return res.text || ''
      } finally {
        await parser.destroy()
      }
    }
    if (ext === '.docx') {
      const mod: any = await import('mammoth')
      const mammoth = mod.default ?? mod
      return (await mammoth.extractRawText({ path: filePath })).value || ''
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const mod: any = await import('exceljs')
      const ExcelJS = mod.default ?? mod
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(filePath)
      const lines: string[] = []
      wb.worksheets.forEach((ws: any) => {
        lines.push(`# Sheet: ${ws.name}`)
        ws.eachRow((row: any) => {
          const cells = (row.values || []).slice(1).map((v: any) =>
            v == null ? '' : typeof v === 'object' ? v.text || v.result || JSON.stringify(v) : String(v)
          )
          if (cells.some((c: string) => c.trim())) lines.push(cells.join(' | '))
        })
      })
      return lines.join('\n')
    }
    if (IMG_EXTS.includes(ext)) {
      // Gemini vision OCR — reads tags/labels off scanned forms & drawings
      const buf = await fs.readFile(filePath)
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Transcribe ALL visible text from this industrial document/drawing verbatim — every equipment tag, instrument tag, label, value, unit, note and table cell. Preserve tag formats exactly. Output plain text only.'
              },
              { inlineData: { mimeType: mime, data: buf.toString('base64') } }
            ]
          }
        ],
        config: { temperature: 0.1 }
      })
      return res.text || ''
    }
    // plain-text family
    return await fs.readFile(filePath, 'utf-8')
  } catch (e) {
    return ''
  }
}

const chunkText = (text: string, size = 1800): string[] =>
  (text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || []).filter((c) => c.trim().length > 30)

// ─── embeddings (Gemini, batched) ─────────────────────────────────────
async function embedBatch(ai: any, texts: string[]): Promise<number[][]> {
  if (!texts.length) return []
  const res: any = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: texts,
    config: { taskType: 'RETRIEVAL_DOCUMENT' }
  })
  return (res.embeddings || []).map((e: any) => e.values)
}

async function embedQuery(ai: any, text: string): Promise<number[]> {
  const res: any = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: text,
    config: { taskType: 'RETRIEVAL_QUERY' }
  })
  return res.embeddings?.[0]?.values || []
}

// ─── entity / relationship extraction ─────────────────────────────────
async function extractGraph(ai: any, text: string): Promise<{ entities: any[]; relationships: any[] }> {
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: `${EXTRACTION_PROMPT}\n\n# DOCUMENT TEXT\n${text.slice(0, 16000)}`,
    config: { responseMimeType: 'application/json', temperature: 0.15 }
  })
  try {
    const parsed = JSON.parse(stripJson(res.text || '{}'))
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : []
    }
  } catch {
    return { entities: [], relationships: [] }
  }
}

// ─── merge extraction into the graph (dedupe + alias union) ────────────
function mergeIntoGraph(
  g: KnowledgeGraph,
  docId: string,
  entities: any[],
  relationships: any[]
): void {
  // name → nodeId lookup for this doc's relationship resolution
  const nameToId = new Map<string, string>()

  for (const e of entities) {
    const name = String(e?.name || '').trim()
    if (!name) continue
    const type = canonicalType(e.type)
    const key = nodeKey(type, name)
    const aliases: string[] = Array.isArray(e.aliases) ? e.aliases.map((a: any) => String(a)).filter(Boolean) : []
    const props: Record<string, string> = {}
    if (e.props && typeof e.props === 'object') {
      for (const [k, v] of Object.entries(e.props)) props[String(k)] = String(v)
    }

    if (!g.nodes[key]) {
      g.nodes[key] = { id: key, type, name, aliases: [], props: {}, docs: [], mentions: 0 }
    }
    const node = g.nodes[key]
    node.mentions++
    if (!node.docs.includes(docId)) node.docs.push(docId)
    for (const a of aliases) if (a && !node.aliases.includes(a) && a !== name) node.aliases.push(a)
    for (const [k, v] of Object.entries(props)) if (v && !node.props[k]) node.props[k] = v

    nameToId.set(name.toLowerCase(), key)
    for (const a of aliases) nameToId.set(a.toLowerCase(), key)
  }

  // resolve a relationship endpoint to a node id (create a loose node if needed)
  const resolve = (rawName: string): string | null => {
    const nm = String(rawName || '').trim()
    if (!nm) return null
    const hit = nameToId.get(nm.toLowerCase())
    if (hit) return hit
    // search existing graph nodes by name/alias
    const lower = nm.toLowerCase()
    for (const node of Object.values(g.nodes)) {
      if (node.name.toLowerCase() === lower || node.aliases.some((a) => a.toLowerCase() === lower)) return node.id
    }
    // create a minimal node so the relationship is not lost
    const key = nodeKey('Document', nm)
    if (!g.nodes[key]) {
      g.nodes[key] = { id: key, type: 'Document', name: nm, aliases: [], props: {}, docs: [docId], mentions: 1 }
    }
    nameToId.set(lower, key)
    return key
  }

  const seen = new Set(g.edges.map((e) => `${e.source}|${e.type}|${e.target}`))
  for (const r of relationships) {
    const s = resolve(r?.source)
    const t = resolve(r?.target)
    if (!s || !t || s === t) continue
    const type = canonicalEdge(r.type)
    const sig = `${s}|${type}|${t}`
    if (seen.has(sig)) continue
    seen.add(sig)
    g.edges.push({
      id: crypto.randomUUID(),
      source: s,
      target: t,
      type,
      label: String(r.label || type).slice(0, 80),
      docId,
      confidence: 0.85
    })
  }
}

// ─── graph neighborhood → text (for GraphRAG context) ─────────────────
function neighborhoodFacts(g: KnowledgeGraph, nodeIds: Set<string>, hopBudget = 60): string[] {
  const facts: string[] = []
  let count = 0
  for (const edge of g.edges) {
    if (count >= hopBudget) break
    if (nodeIds.has(edge.source) || nodeIds.has(edge.target)) {
      const s = g.nodes[edge.source]
      const t = g.nodes[edge.target]
      if (!s || !t) continue
      facts.push(`(${s.type}) ${s.name} —[${edge.type}]→ (${t.type}) ${t.name}${edge.label && edge.label !== edge.type ? ` :: ${edge.label}` : ''}`)
      count++
    }
  }
  return facts
}

function matchNodes(g: KnowledgeGraph, query: string, limit = 12): string[] {
  const q = query.toLowerCase()
  const terms = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2)
  const scored = Object.values(g.nodes).map((n) => {
    const hay = `${n.name} ${n.aliases.join(' ')}`.toLowerCase()
    let score = 0
    if (q.includes(n.name.toLowerCase())) score += 5
    for (const t of terms) if (hay.includes(t)) score += 1
    score += Math.min(n.mentions, 3) * 0.1
    return { id: n.id, score }
  })
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.id)
}

// ─── BFS shortest relationship path between two entities ──────────────
function findPath(g: KnowledgeGraph, fromId: string, toId: string): { node: KGNode; via?: KGEdge }[] | null {
  if (fromId === toId) return [{ node: g.nodes[fromId] }]
  const adj = new Map<string, KGEdge[]>()
  for (const e of g.edges) {
    ;(adj.get(e.source) || adj.set(e.source, []).get(e.source)!).push(e)
    ;(adj.get(e.target) || adj.set(e.target, []).get(e.target)!).push(e)
  }
  const prev = new Map<string, { node: string; edge: KGEdge }>()
  const visited = new Set<string>([fromId])
  const queue = [fromId]
  while (queue.length) {
    const cur = queue.shift()!
    if (cur === toId) break
    for (const e of adj.get(cur) || []) {
      const next = e.source === cur ? e.target : e.source
      if (!visited.has(next)) {
        visited.add(next)
        prev.set(next, { node: cur, edge: e })
        queue.push(next)
      }
    }
  }
  if (!prev.has(toId)) return null
  const path: { node: KGNode; via?: KGEdge }[] = []
  let cur = toId
  while (cur !== fromId) {
    const p = prev.get(cur)!
    path.unshift({ node: g.nodes[cur], via: p.edge })
    cur = p.node
  }
  path.unshift({ node: g.nodes[fromId] })
  return path
}

const resolveByName = (g: KnowledgeGraph, name: string): string | null => {
  const lower = String(name || '').toLowerCase().trim()
  if (!lower) return null
  if (g.nodes[lower]) return lower
  let best: { id: string; score: number } | null = null
  for (const n of Object.values(g.nodes)) {
    const exact = n.name.toLowerCase() === lower || n.aliases.some((a) => a.toLowerCase() === lower)
    const partial = n.name.toLowerCase().includes(lower) || lower.includes(n.name.toLowerCase())
    const score = exact ? 10 : partial ? 3 : 0
    if (score && (!best || score > best.score)) best = { id: n.id, score }
  }
  return best?.id || null
}

// ─── exports ──────────────────────────────────────────────────────────
function toMermaid(g: KnowledgeGraph, maxEdges = 120): string {
  const lines = ['graph LR']
  const used = new Set<string>()
  const safe = (id: string): string => id.replace(/[^a-z0-9]/gi, '_')
  for (const e of g.edges.slice(0, maxEdges)) {
    const s = g.nodes[e.source]
    const t = g.nodes[e.target]
    if (!s || !t) continue
    if (!used.has(s.id)) { lines.push(`  ${safe(s.id)}["${s.name.replace(/"/g, "'")}<br/>(${s.type})"]`); used.add(s.id) }
    if (!used.has(t.id)) { lines.push(`  ${safe(t.id)}["${t.name.replace(/"/g, "'")}<br/>(${t.type})"]`); used.add(t.id) }
    lines.push(`  ${safe(s.id)} -->|${e.type}| ${safe(t.id)}`)
  }
  return lines.join('\n')
}

function statsOf(g: KnowledgeGraph): any {
  const nodeTypes: Record<string, number> = {}
  const edgeTypes: Record<string, number> = {}
  for (const n of Object.values(g.nodes)) nodeTypes[n.type] = (nodeTypes[n.type] || 0) + 1
  for (const e of g.edges) edgeTypes[e.type] = (edgeTypes[e.type] || 0) + 1
  const topEntities = Object.values(g.nodes)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 15)
    .map((n) => ({ name: n.name, type: n.type, mentions: n.mentions, connections: g.edges.filter((e) => e.source === n.id || e.target === n.id).length }))
  return {
    name: g.name,
    graphId: g.graphId,
    documents: g.documents.length,
    nodes: Object.keys(g.nodes).length,
    edges: g.edges.length,
    chunks: g.chunks.length,
    nodeTypes,
    edgeTypes,
    topEntities,
    updatedAt: g.updatedAt
  }
}

// graph payload for the visualization widget (capped for performance)
function vizPayload(g: KnowledgeGraph, maxNodes = 140): any {
  const ranked = Object.values(g.nodes)
    .sort((a, b) => (b.mentions + b.docs.length) - (a.mentions + a.docs.length))
    .slice(0, maxNodes)
  const keep = new Set(ranked.map((n) => n.id))
  return {
    nodes: ranked.map((n) => ({ id: n.id, name: n.name, type: n.type, mentions: n.mentions })),
    edges: g.edges
      .filter((e) => keep.has(e.source) && keep.has(e.target))
      .slice(0, 400)
      .map((e) => ({ source: e.source, target: e.target, type: e.type }))
  }
}

// ─── file discovery ───────────────────────────────────────────────────
async function discoverDocs(target: string): Promise<string[]> {
  const stat = await fs.stat(target)
  if (stat.isFile()) return SUPPORTED_EXTS.includes(path.extname(target).toLowerCase()) ? [target] : []
  const out: string[] = []
  const ignore = ['node_modules', '.git', 'dist', 'build', 'out', '$RECYCLE.BIN']
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return
    let entries: any[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!ignore.includes(e.name)) await walk(full, depth + 1)
      } else if (SUPPORTED_EXTS.includes(path.extname(e.name).toLowerCase())) {
        out.push(full)
      }
    }
  }
  await walk(target, 0)
  return out
}

// ─── registration ─────────────────────────────────────────────────────
export default function registerKnowledgeGraph({ ipcMain }: { ipcMain: IpcMain }): void {
  const handle = (channel: string, fn: (event: any, params: any) => Promise<any>): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }

  // ── BUILD / INGEST ──────────────────────────────────────────────────
  handle('kg-build', async (event, params) => {
    const send = (p: object): void => {
      try { event.sender.send('kg-progress', p) } catch { /* ignore */ }
    }
    try {
      const { target, graphName, geminiKey, maxFiles } = params || {}
      if (!geminiKey || !String(geminiKey).trim()) {
        return { success: false, error: 'Missing Gemini API Key. Configure it in the Command Center Vault.' }
      }
      if (!target || !String(target).trim()) return { success: false, error: 'No file or folder provided.' }
      const resolved = path.resolve(String(target))
      try { await fs.stat(resolved) } catch { return { success: false, error: `Path not found: ${resolved}` } }

      const ai = new GoogleGenAI({ apiKey: geminiKey })
      const g = await loadGraph(graphName || 'default')

      send({ stage: 'scanning', message: 'Discovering documents…' })
      let files = await discoverDocs(resolved)
      const already = new Set(g.documents.map((d) => d.path))
      files = files.filter((f) => !already.has(f)).slice(0, Math.max(1, Math.min(Number(maxFiles) || 60, 300)))
      if (!files.length) {
        return { success: false, error: 'No new supported documents found (PDF/DOCX/XLSX/CSV/TXT/MD/images).' }
      }
      send({ stage: 'scanning', message: `Found ${files.length} document(s) to ingest.`, total: files.length })

      let processed = 0
      for (const file of files) {
        const name = path.basename(file)
        const ext = path.extname(file).toLowerCase().replace('.', '')
        send({ stage: 'extracting', message: `Reading ${name}…`, processed, total: files.length, nodes: Object.keys(g.nodes).length, edges: g.edges.length })

        const text = await extractText(ai, file)
        if (!text || text.trim().length < 40) { processed++; continue }

        const docId = crypto.randomUUID()
        const chunks = chunkText(text)
        const doc: KGDoc = { id: docId, path: file, name, type: ext, ingestedAt: Date.now(), chunkCount: chunks.length }

        // entity / relationship extraction — chunk-wise for long docs (cap to stay free-tier friendly)
        const extractChunks = chunks.slice(0, 6)
        for (const ch of extractChunks) {
          try {
            send({ stage: 'reasoning', message: `Extracting entities from ${name}…`, processed, total: files.length, nodes: Object.keys(g.nodes).length, edges: g.edges.length })
            const { entities, relationships } = await extractGraph(ai, ch)
            mergeIntoGraph(g, docId, entities, relationships)
            await sleep(1200)
          } catch { await sleep(2500) }
        }

        // embed chunks for GraphRAG (batch, capped)
        try {
          const toEmbed = chunks.slice(0, 12)
          const embs = await embedBatch(ai, toEmbed.map((c) => `${name}\n${c}`))
          embs.forEach((emb, i) => { if (emb) g.chunks.push({ id: crypto.randomUUID(), docId, text: toEmbed[i], embedding: emb }) })
          await sleep(800)
        } catch { /* embeddings optional */ }

        g.documents.push(doc)
        processed++
        await saveGraph(g)
        send({ stage: 'ingested', message: `Ingested ${name}`, processed, total: files.length, nodes: Object.keys(g.nodes).length, edges: g.edges.length })
      }

      await saveGraph(g)
      send({ stage: 'done', message: 'Knowledge graph updated.' })
      return { success: true, ...statsOf(g) }
    } catch (err) {
      send({ stage: 'error', message: String(err) })
      return { success: false, error: String(err) }
    }
  })

  // ── QUERY (GraphRAG) ────────────────────────────────────────────────
  handle('kg-query', async (_event, params) => {
    try {
      const { query, graphName, geminiKey } = params || {}
      if (!geminiKey) return { success: false, error: 'Missing Gemini API Key.' }
      if (!query || !String(query).trim()) return { success: false, error: 'Empty query.' }
      const g = await loadGraph(graphName || 'default')
      if (!Object.keys(g.nodes).length) return { success: false, error: 'This knowledge graph is empty — build it from your documents first.' }

      const ai = new GoogleGenAI({ apiKey: geminiKey })

      // 1) vector retrieval over chunks (hybrid)
      let topChunks: KGChunk[] = []
      if (g.chunks.length) {
        try {
          const qv = await embedQuery(ai, String(query))
          topChunks = g.chunks
            .map((c) => ({ c, score: cosine(qv, c.embedding) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map((x) => x.c)
        } catch { /* fall back to graph-only */ }
      }

      // 2) graph neighborhood facts
      const matched = new Set(matchNodes(g, String(query)))
      const facts = neighborhoodFacts(g, matched)

      const docName = (id: string): string => g.documents.find((d) => d.id === id)?.name || 'document'
      const factBlock = facts.length ? facts.map((f) => `- ${f}`).join('\n') : '(no directly matching graph relationships)'
      const chunkBlock = topChunks.length
        ? topChunks.map((c) => `[${docName(c.docId)}] ${c.text.slice(0, 900)}`).join('\n\n---\n\n')
        : '(no source excerpts retrieved)'

      const prompt = `You are BRUTUS — an industrial operations intelligence copilot. Answer the user's question using ONLY the knowledge-graph relationships and source excerpts below. Cite the source document name in [brackets] when you use an excerpt. If the evidence is insufficient, say so plainly and state what document would be needed. Give a precise, operational answer. End with a one-line "Confidence: high/medium/low" based strictly on evidence strength.

# KNOWLEDGE GRAPH RELATIONSHIPS
${factBlock}

# SOURCE EXCERPTS
${chunkBlock}

# QUESTION
${query}`

      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { temperature: 0.3 }
      })

      return {
        success: true,
        answer: res.text || '(no answer)',
        usedFacts: facts.length,
        usedChunks: topChunks.length,
        sources: [...new Set(topChunks.map((c) => docName(c.docId)))]
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── CONNECTION PATH ─────────────────────────────────────────────────
  handle('kg-connect', async (_event, params) => {
    try {
      const { from, to, graphName } = params || {}
      const g = await loadGraph(graphName || 'default')
      const fromId = resolveByName(g, from)
      const toId = resolveByName(g, to)
      if (!fromId) return { success: false, error: `Entity not found: "${from}".` }
      if (!toId) return { success: false, error: `Entity not found: "${to}".` }
      const path = findPath(g, fromId, toId)
      if (!path) return { success: true, connected: false, message: `No relationship path found between "${g.nodes[fromId].name}" and "${g.nodes[toId].name}".` }
      const readable = path
        .map((step, i) => (i === 0 ? `${step.node.name}` : `—[${step.via?.type}]→ ${step.node.name}`))
        .join(' ')
      return {
        success: true,
        connected: true,
        hops: path.length - 1,
        path: path.map((s) => ({ name: s.node.name, type: s.node.type, via: s.via?.type })),
        readable
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── ENTITY LOOKUP ───────────────────────────────────────────────────
  handle('kg-entity', async (_event, params) => {
    try {
      const { name, graphName } = params || {}
      const g = await loadGraph(graphName || 'default')
      const id = resolveByName(g, name)
      if (!id) return { success: false, error: `Entity not found: "${name}".` }
      const node = g.nodes[id]
      const rels = g.edges
        .filter((e) => e.source === id || e.target === id)
        .map((e) => {
          const other = e.source === id ? g.nodes[e.target] : g.nodes[e.source]
          const dir = e.source === id ? 'out' : 'in'
          return { type: e.type, direction: dir, entity: other?.name, entityType: other?.type, label: e.label }
        })
      return {
        success: true,
        entity: { name: node.name, type: node.type, aliases: node.aliases, props: node.props, mentions: node.mentions },
        relationships: rels,
        documents: node.docs.map((d) => g.documents.find((x) => x.id === d)?.name).filter(Boolean)
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── STATS + VIZ ─────────────────────────────────────────────────────
  handle('kg-stats', async (_event, params) => {
    try {
      const g = await loadGraph(params?.graphName || 'default')
      return { success: true, ...statsOf(g), viz: vizPayload(g) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── EXPORT (Mermaid / JSON) ─────────────────────────────────────────
  handle('kg-export', async (_event, params) => {
    try {
      const { graphName, format, outputDir } = params || {}
      const g = await loadGraph(graphName || 'default')
      const fmt = String(format || 'mermaid').toLowerCase()
      const destDir = outputDir ? path.resolve(outputDir) : app.getPath('documents')
      await fs.mkdir(destDir, { recursive: true })
      const base = `knowledge-graph-${slug(g.name)}`
      if (fmt === 'json') {
        const dest = path.join(destDir, `${base}.json`)
        await fs.writeFile(dest, JSON.stringify({ nodes: Object.values(g.nodes), edges: g.edges, documents: g.documents }, null, 2))
        return { success: true, path: dest, format: 'json' }
      }
      const dest = path.join(destDir, `${base}.mmd`)
      await fs.writeFile(dest, toMermaid(g), 'utf-8')
      return { success: true, path: dest, format: 'mermaid', mermaid: toMermaid(g, 40) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── P&ID / DRAWING PARSER (computer vision) ─────────────────────────
  handle('kg-parse-pid', async (_event, params) => {
    try {
      const { imagePath, graphName, geminiKey } = params || {}
      if (!geminiKey) return { success: false, error: 'Missing Gemini API Key.' }
      const resolved = path.resolve(String(imagePath || ''))
      const ext = path.extname(resolved).toLowerCase()
      if (!IMG_EXTS.includes(ext)) return { success: false, error: 'Provide a P&ID image (.png/.jpg/.jpeg/.webp).' }
      const buf = await fs.readFile(resolved)
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
      const ai = new GoogleGenAI({ apiKey: geminiKey })

      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `You are reading a Piping & Instrumentation Diagram (P&ID) / engineering drawing. Extract its structure as a knowledge graph.
- "entities": every equipment item, instrument/tag, line, and labelled component. Use entity types from: ${NODE_TYPES.join(', ')}. Put the tag string in props.tag when present.
- "relationships": physical/logical connections between them (process flow, signal lines, containment). Use relationship types from: ${EDGE_TYPES.join(', ')} — typically CONNECTED_TO, PART_OF, MEASURES, LOCATED_IN.
NEVER invent tags you cannot see. Output ONLY JSON: {"entities":[{"name","type","aliases":[],"props":{}}],"relationships":[{"source","target","type","label"}]}.`
              },
              { inlineData: { mimeType: mime, data: buf.toString('base64') } }
            ]
          }
        ],
        config: { responseMimeType: 'application/json', temperature: 0.15 }
      })

      let parsed: any = { entities: [], relationships: [] }
      try { parsed = JSON.parse(stripJson(res.text || '{}')) } catch { /* keep empty */ }
      const entities = Array.isArray(parsed.entities) ? parsed.entities : []
      const relationships = Array.isArray(parsed.relationships) ? parsed.relationships : []

      const g = await loadGraph(graphName || 'default')
      const docId = crypto.randomUUID()
      g.documents.push({ id: docId, path: resolved, name: path.basename(resolved), type: 'pid', ingestedAt: Date.now(), chunkCount: 0 })
      mergeIntoGraph(g, docId, entities, relationships)
      await saveGraph(g)

      return {
        success: true,
        entitiesFound: entities.length,
        relationshipsFound: relationships.length,
        tags: entities.map((e: any) => e?.props?.tag || e?.name).filter(Boolean).slice(0, 50),
        ...statsOf(g)
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── LIST GRAPHS ─────────────────────────────────────────────────────
  handle('kg-list', async () => {
    try {
      await fs.mkdir(graphsDir(), { recursive: true })
      const files = (await fs.readdir(graphsDir())).filter((f) => f.endsWith('.json'))
      const graphs: any[] = []
      for (const f of files) {
        try {
          const g = JSON.parse(await fs.readFile(path.join(graphsDir(), f), 'utf-8')) as KnowledgeGraph
          graphs.push({ name: g.name, graphId: g.graphId, nodes: Object.keys(g.nodes || {}).length, edges: (g.edges || []).length, documents: (g.documents || []).length, updatedAt: g.updatedAt })
        } catch { /* skip corrupt */ }
      }
      return { success: true, graphs: graphs.sort((a, b) => b.updatedAt - a.updatedAt) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── CLEAR ───────────────────────────────────────────────────────────
  handle('kg-clear', async (_event, params) => {
    try {
      const id = idOf(params?.graphName || 'default')
      await fs.rm(graphFile(id), { force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── PICK TARGET (file or folder) ────────────────────────────────────
  handle('kg-pick-target', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const res = await dialog.showOpenDialog(win!, {
        title: 'Select a document or a folder of documents to ingest',
        properties: ['openFile', 'openDirectory']
      })
      if (res.canceled || !res.filePaths[0]) return { success: false, canceled: true }
      return { success: true, path: res.filePaths[0] }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
