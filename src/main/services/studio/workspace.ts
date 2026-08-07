/**
 * BRUTUS Studio — workspaces
 * ---------------------------
 * A workspace is one canvas: its agents, its wiring, its scenery, and the
 * project it belongs to. Studio holds many of them and opens one at a time,
 * which is why this is a small store rather than a single file.
 *
 * What is deliberately NOT restored: running terminals. The pty processes die
 * with the app, and silently re-launching agents on startup would mean an agent
 * begins working on your repo before you have looked at the screen. Restored
 * nodes come back in their setup state.
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { StudioWorkspace } from './types'

/** Summary shown on the launcher, without loading every graph. */
export interface WorkspaceSummary {
  id: string
  name: string
  rootDir: string
  backdrop: string
  nodeCount: number
  edgeCount: number
  /** Agent kinds present, for the card's badges. */
  kinds: string[]
  createdAt: number
  updatedAt: number
}

const ROOT = (): string => path.join(app.getPath('userData'), 'brutus_studio', 'workspaces')
/** The single-workspace file this store replaced. Migrated once, then left alone. */
const LEGACY = (): string => path.join(app.getPath('userData'), 'brutus_studio_workspace.json')

/**
 * Ids are used as filenames, so they are generated here and validated on the
 * way back in. An imported workspace carrying `../../.ssh/id_rsa` as its id
 * would otherwise be a path-traversal write.
 */
const ID_RE = /^ws_[A-Za-z0-9_-]{1,48}$/

function newId(): string {
  return `ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function safeId(id: unknown): string | null {
  return typeof id === 'string' && ID_RE.test(id) ? id : null
}

function fileFor(id: string): string {
  return path.join(ROOT(), `${id}.json`)
}

function ensureRoot(): void {
  fs.mkdirSync(ROOT(), { recursive: true })
}

function blank(over: Partial<StudioWorkspace> = {}): StudioWorkspace {
  const now = Date.now()
  return {
    id: newId(),
    name: 'Untitled workspace',
    rootDir: '',
    nodes: [],
    edges: [],
    backdrop: 'ember',
    viewport: { x: 0, y: 0, zoom: 0.9 },
    createdAt: now,
    updatedAt: now,
    ...over
  }
}

/** Coerce whatever is on disk into a usable workspace. */
function normalise(raw: Partial<StudioWorkspace>, id: string): StudioWorkspace {
  const base = blank({ id })
  return {
    ...base,
    ...raw,
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.slice(0, 80) : base.name,
    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
    viewport: raw.viewport ?? base.viewport,
    // A folder that has since been deleted or moved must not strand the canvas.
    rootDir: raw.rootDir && fs.existsSync(raw.rootDir) ? raw.rootDir : '',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : base.updatedAt
  }
}

/** Bring the old single-workspace file across, once. */
function migrateLegacy(): void {
  try {
    const legacy = LEGACY()
    if (!fs.existsSync(legacy)) return
    ensureRoot()
    if (fs.readdirSync(ROOT()).some((f) => f.endsWith('.json'))) return

    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Partial<StudioWorkspace>
    const ws = normalise(raw, newId())
    fs.writeFileSync(fileFor(ws.id), JSON.stringify(ws, null, 2), 'utf8')
    // Renamed rather than deleted: if the migration was wrong, the original is
    // still there to look at.
    fs.renameSync(legacy, `${legacy}.migrated`)
  } catch (err) {
    console.warn('[Studio] legacy workspace migration skipped:', err)
  }
}

export function listWorkspaces(): WorkspaceSummary[] {
  const out: WorkspaceSummary[] = []
  try {
    migrateLegacy()
    ensureRoot()

    for (const entry of fs.readdirSync(ROOT())) {
      if (!entry.endsWith('.json')) continue
      const id = safeId(entry.replace(/\.json$/, ''))
      if (!id) continue
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(ROOT(), entry), 'utf8')
        ) as Partial<StudioWorkspace>
        const ws = normalise(parsed, id)
        const kinds: string[] = []
        for (const n of ws.nodes)
          if (n.agentKind && !kinds.includes(n.agentKind)) kinds.push(n.agentKind)

        out.push({
          id: ws.id,
          name: ws.name,
          rootDir: ws.rootDir,
          backdrop: ws.backdrop,
          nodeCount: ws.nodes.length,
          edgeCount: ws.edges.length,
          kinds,
          createdAt: ws.createdAt ?? 0,
          updatedAt: ws.updatedAt
        })
      } catch {
        // One unreadable file must not hide every other workspace.
      }
    }
  } catch (err) {
    console.warn('[Studio] workspace list failed:', err)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function readWorkspace(id: string): StudioWorkspace | null {
  const safe = safeId(id)
  if (!safe) return null
  try {
    const file = fileFor(safe)
    if (!fs.existsSync(file)) return null
    return normalise(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StudioWorkspace>, safe)
  } catch (err) {
    console.warn('[Studio] workspace read failed:', err)
    return null
  }
}

export function createWorkspace(over: Partial<StudioWorkspace> = {}): StudioWorkspace {
  const ws = blank({
    ...over,
    id: newId(),
    // A workspace opened on a folder is named after it unless told otherwise.
    name:
      over.name?.trim() || (over.rootDir ? path.basename(over.rootDir) : '') || 'Untitled workspace'
  })
  ensureRoot()
  fs.writeFileSync(fileFor(ws.id), JSON.stringify(ws, null, 2), 'utf8')
  return ws
}

/**
 * Merge a partial update into an existing workspace.
 *
 * Merging rather than replacing is what lets the canvas save just `{backdrop}`
 * or just `{viewport}` without dropping the graph.
 */
export function saveWorkspace(ws: Partial<StudioWorkspace>): StudioWorkspace | null {
  const safe = safeId(ws.id)
  if (!safe) return null
  const existing = readWorkspace(safe) ?? blank({ id: safe })
  const merged: StudioWorkspace = { ...existing, ...ws, id: safe, updatedAt: Date.now() }
  try {
    ensureRoot()
    fs.writeFileSync(fileFor(safe), JSON.stringify(merged, null, 2), 'utf8')
  } catch (err) {
    console.error('[Studio] workspace save failed:', err)
  }
  return merged
}

export function deleteWorkspace(id: string): boolean {
  const safe = safeId(id)
  if (!safe) return false
  try {
    const file = fileFor(safe)
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return true
  } catch (err) {
    console.error('[Studio] workspace delete failed:', err)
    return false
  }
}

export function exportWorkspace(id: string): string | null {
  const ws = readWorkspace(id)
  if (!ws) return null
  // The id is dropped: importing must mint a new one rather than overwrite the
  // sender's workspace on the recipient's machine.
  const { id: _drop, ...rest } = ws
  void _drop
  return JSON.stringify({ brutusStudioWorkspace: 1, ...rest }, null, 2)
}

/**
 * Recreate a shared workspace.
 *
 * Everything about the payload is untrusted: it arrived as text a human pasted
 * in. The id is regenerated, the root folder is only kept if it happens to
 * exist on this machine, and the graph goes through the same normalisation as
 * anything read off disk.
 */
export function importWorkspace(payload: string): StudioWorkspace | null {
  try {
    const raw = JSON.parse(payload) as Partial<StudioWorkspace> & { brutusStudioWorkspace?: number }
    if (!raw || typeof raw !== 'object') return null
    if (!Array.isArray(raw.nodes) && !raw.name) return null

    const ws = normalise({ ...raw, id: undefined }, newId())
    ensureRoot()
    fs.writeFileSync(fileFor(ws.id), JSON.stringify(ws, null, 2), 'utf8')
    return ws
  } catch (err) {
    console.warn('[Studio] workspace import failed:', err)
    return null
  }
}
