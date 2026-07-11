/**
 * BRUTUS Knowledge Graph — renderer tool wrappers.
 * Thin bridges over the kg-* IPC handlers, used by both the voice agent and
 * the Knowledge Graph widget.
 */

const getGeminiKey = async (): Promise<string> => {
  try {
    const keys = await window.electron.ipcRenderer.invoke('secure-get-keys')
    return (keys?.geminiKey || localStorage.getItem('brutus_custom_api_key') || '').trim()
  } catch {
    return (localStorage.getItem('brutus_custom_api_key') || '').trim()
  }
}

const DEFAULT_GRAPH = 'default'

/** Build / extend the knowledge graph from a file or folder of documents. */
export const buildKnowledgeGraph = async (
  target: string,
  graphName?: string
): Promise<string> => {
  const geminiKey = await getGeminiKey()
  if (!geminiKey) return '⚠️ Missing Gemini API Key. Add it in the Command Center Vault to build a knowledge graph.'
  if (!target?.trim()) return '⚠️ Tell me which file or folder to ingest (an absolute path).'

  window.dispatchEvent(new CustomEvent('kg-start', { detail: { target } }))
  const r = await window.electron.ipcRenderer.invoke('kg-build', {
    target: target.trim(),
    graphName: graphName || DEFAULT_GRAPH,
    geminiKey
  })
  window.dispatchEvent(new CustomEvent('kg-done', { detail: r }))
  if (!r?.success) return `❌ Knowledge graph build failed: ${r?.error}`
  return `✅ Knowledge graph "${r.name}" updated — ${r.documents} document(s), ${r.nodes} entities, ${r.edges} relationships. Ask me anything about it.`
}

/** GraphRAG question answering over the graph + source excerpts. */
export const queryKnowledgeGraph = async (
  query: string,
  graphName?: string
): Promise<string> => {
  const geminiKey = await getGeminiKey()
  if (!geminiKey) return '⚠️ Missing Gemini API Key.'
  const r = await window.electron.ipcRenderer.invoke('kg-query', {
    query,
    graphName: graphName || DEFAULT_GRAPH,
    geminiKey
  })
  if (!r?.success) return `❌ ${r?.error}`
  const src = r.sources?.length ? `\n\n📎 Sources: ${r.sources.join(', ')}` : ''
  return `${r.answer}${src}`
}

/** Find how two entities are connected (shortest relationship path). */
export const findConnection = async (
  from: string,
  to: string,
  graphName?: string
): Promise<string> => {
  const r = await window.electron.ipcRenderer.invoke('kg-connect', {
    from,
    to,
    graphName: graphName || DEFAULT_GRAPH
  })
  if (!r?.success) return `❌ ${r?.error}`
  if (!r.connected) return `🔗 ${r.message}`
  return `🔗 ${r.hops}-hop connection:\n${r.readable}`
}

/** Look up a single entity, its properties and relationships. */
export const lookupEntity = async (name: string, graphName?: string): Promise<string> => {
  const r = await window.electron.ipcRenderer.invoke('kg-entity', {
    name,
    graphName: graphName || DEFAULT_GRAPH
  })
  if (!r?.success) return `❌ ${r?.error}`
  const e = r.entity
  const props = Object.entries(e.props || {}).map(([k, v]) => `${k}: ${v}`).join(', ')
  const rels = (r.relationships || [])
    .slice(0, 12)
    .map((x: any) => `  ${x.direction === 'out' ? '→' : '←'} [${x.type}] ${x.entity} (${x.entityType})`)
    .join('\n')
  return `📌 ${e.name} (${e.type}) — mentioned ${e.mentions}x${props ? `\n${props}` : ''}${
    rels ? `\nRelationships:\n${rels}` : '\n(no relationships recorded)'
  }`
}

/** Parse a P&ID / engineering drawing image into the graph. */
export const parsePID = async (imagePath: string, graphName?: string): Promise<string> => {
  const geminiKey = await getGeminiKey()
  if (!geminiKey) return '⚠️ Missing Gemini API Key.'
  const r = await window.electron.ipcRenderer.invoke('kg-parse-pid', {
    imagePath,
    graphName: graphName || DEFAULT_GRAPH,
    geminiKey
  })
  if (!r?.success) return `❌ ${r?.error}`
  return `✅ Parsed drawing — ${r.entitiesFound} components, ${r.relationshipsFound} connections. Tags: ${
    (r.tags || []).slice(0, 15).join(', ') || 'none detected'
  }. Graph now has ${r.nodes} entities / ${r.edges} relationships.`
}

/** Export the graph as a Mermaid diagram or JSON (architecture-diagram deliverable). */
export const exportGraph = async (
  format: 'mermaid' | 'json' = 'mermaid',
  graphName?: string
): Promise<string> => {
  const r = await window.electron.ipcRenderer.invoke('kg-export', {
    format,
    graphName: graphName || DEFAULT_GRAPH
  })
  if (!r?.success) return `❌ ${r?.error}`
  window.electron.ipcRenderer.invoke('file:open', r.path).catch(() => {})
  return `✅ Exported ${r.format} to ${r.path}`
}
