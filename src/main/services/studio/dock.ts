/**
 * BRUTUS Studio — the canvas dock
 * --------------------------------
 * What you can drop onto a canvas, and in what order it appears.
 *
 * The catalogue is **derived, not declared**: agent entries come from the
 * adapter registry, so adding an adapter file puts it on the dock with no edit
 * here, and an agent that is not installed still appears (greyed) rather than
 * silently missing. Tools are the non-agent node types the canvas can actually
 * render.
 *
 * Nothing here is aspirational. Every entry corresponds to something Studio can
 * really place on the canvas — a list of tools that look clickable and do
 * nothing would be worse than a short list that works.
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { adapterAvailability } from './adapters/registry'

export interface DockItem {
  id: string
  label: string
  /** Which node type this places. */
  node: 'agent' | 'note'
  /** For agent nodes, which adapter. */
  agentKind?: string
  /** Tailwind text colour for the icon. */
  accent: string
  /** Is the underlying binary present? Tools are always true. */
  available: boolean
  /** Install hint when a binary is missing. */
  install?: string
}

/** Non-agent things the canvas can render. Kept honest: these exist. */
const TOOLS: Omit<DockItem, 'available'>[] = [
  { id: 'note', label: 'Note', node: 'note', accent: 'text-amber-300' }
]

const FILE = (): string => path.join(app.getPath('userData'), 'brutus_studio', 'dock.json')

/**
 * Studio's cross-canvas preferences.
 *
 * Everything here applies to every workspace, which is why it lives in one file
 * rather than in each workspace's graph.
 */
export interface StudioConfig {
  /** Item ids on the dock, in order. */
  onDock: string[]
  /** Default scenery for new workspaces. */
  backdrop: string
  /** Agent kind new nodes open with. */
  defaultAgent: string
  /** Chosen model per agent kind. Empty string means "the CLI's own default". */
  models: Record<string, string>
  /** Give each agent its own git worktree and branch. */
  worktrees: boolean
  /** After each turn, commit the agent's work and merge it back. */
  autoMerge: boolean
  /** Include the project journal in handoffs between agents. */
  shareContext: boolean
  /** Launch agents in their CLI's bypass mode. Only honoured with worktrees on. */
  skipPermissions: boolean
}

const DEFAULTS = (): StudioConfig => ({
  // Everything available by default: a new user should see the full lineup and
  // remove what they do not want, rather than wonder where their agents went.
  onDock: [...adapterAvailability().map((a) => a.kind), ...TOOLS.map((t) => t.id)],
  backdrop: 'ember',
  defaultAgent: adapterAvailability().find((a) => a.available)?.kind ?? 'claude',
  models: {},
  worktrees: false,
  autoMerge: false,
  shareContext: true,
  // Off. Skipping permission prompts is never something to inherit by default.
  skipPermissions: false
})

/** Every placeable thing, whether or not it is currently on the dock. */
export function dockCatalogue(): DockItem[] {
  const agents: DockItem[] = adapterAvailability().map((a) => ({
    id: a.kind,
    label: a.label,
    node: 'agent',
    agentKind: a.kind,
    accent: a.accent,
    available: a.available,
    install: a.install || undefined
  }))
  return [...agents, ...TOOLS.map((t) => ({ ...t, available: true }))]
}

/**
 * Parsed config, cached.
 *
 * `read()` sits on the routing path — it is consulted on every turn, every
 * delivery and every spawn — and was doing `existsSync` + `readFileSync` +
 * `JSON.parse` each time. That is synchronous disk I/O in the middle of moving
 * work between agents.
 *
 * Invalidated on our own writes and whenever the file's mtime moves, so editing
 * `dock.json` by hand is still picked up without a restart. `statSync` is one
 * cheap syscall against a parse of the whole file.
 */
let cached: { config: StudioConfig; mtimeMs: number } | null = null

function read(): StudioConfig {
  const base = DEFAULTS()
  try {
    const file = FILE()
    if (!fs.existsSync(file)) {
      cached = null
      return base
    }

    const mtimeMs = fs.statSync(file).mtimeMs
    if (cached && cached.mtimeMs === mtimeMs) return cached.config

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StudioConfig>
    const known = new Set(dockCatalogue().map((c) => c.id))
    const config: StudioConfig = {
      // Drop ids that no longer exist (an adapter was removed) and duplicates.
      onDock: Array.isArray(raw.onDock)
        ? Array.from(new Set(raw.onDock.filter((id) => known.has(id))))
        : base.onDock,
      backdrop: typeof raw.backdrop === 'string' ? raw.backdrop : base.backdrop,
      defaultAgent: typeof raw.defaultAgent === 'string' ? raw.defaultAgent : base.defaultAgent,
      models: raw.models && typeof raw.models === 'object' ? raw.models : {},
      worktrees: raw.worktrees === true,
      autoMerge: raw.autoMerge === true,
      shareContext: raw.shareContext !== false,
      skipPermissions: raw.skipPermissions === true
    }
    cached = { config, mtimeMs }
    return config
  } catch {
    // A malformed file must not be cached, or one bad edit would stick until
    // restart even after the file is fixed.
    cached = null
    return base
  }
}

function write(cfg: StudioConfig): void {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true })
    fs.writeFileSync(FILE(), JSON.stringify(cfg, null, 2), 'utf8')
    // Re-stat rather than trusting the value we just wrote: the filesystem
    // decides the mtime, and guessing it would defeat the check on the next read.
    cached = { config: cfg, mtimeMs: fs.statSync(FILE()).mtimeMs }
  } catch (err) {
    cached = null
    console.error('[Studio] dock save failed:', err)
  }
}

/** Drop the cache. Used by tests and after an external change is suspected. */
export function invalidateConfigCache(): void {
  cached = null
}

export interface DockState extends Omit<StudioConfig, 'onDock'> {
  onDock: DockItem[]
  available: DockItem[]
  /** Everything placeable, for the model + default-agent pickers. */
  catalogue: DockItem[]
}

export function getDock(): DockState {
  const cfg = read()
  const catalogue = dockCatalogue()
  const byId = new Map(catalogue.map((c) => [c.id, c]))

  const onDock = cfg.onDock.map((id) => byId.get(id)).filter((c): c is DockItem => c !== undefined)
  const onIds = new Set(onDock.map((c) => c.id))

  return {
    ...cfg,
    onDock,
    available: catalogue.filter((c) => !onIds.has(c.id)),
    catalogue
  }
}

/** The raw config, for the main-process code that acts on it. */
export function studioConfig(): StudioConfig {
  return read()
}

export function setDock(patch: Partial<StudioConfig>): DockState {
  const cfg = read()
  if (Array.isArray(patch.onDock)) {
    const known = new Set(dockCatalogue().map((c) => c.id))
    cfg.onDock = Array.from(new Set(patch.onDock.filter((id) => known.has(id))))
  }
  if (typeof patch.backdrop === 'string') cfg.backdrop = patch.backdrop
  if (typeof patch.defaultAgent === 'string') cfg.defaultAgent = patch.defaultAgent
  if (patch.models && typeof patch.models === 'object') {
    cfg.models = { ...cfg.models, ...patch.models }
  }
  if (typeof patch.worktrees === 'boolean') cfg.worktrees = patch.worktrees
  if (typeof patch.autoMerge === 'boolean') cfg.autoMerge = patch.autoMerge
  if (typeof patch.shareContext === 'boolean') cfg.shareContext = patch.shareContext
  if (typeof patch.skipPermissions === 'boolean') cfg.skipPermissions = patch.skipPermissions

  // Coupled on purpose: bypassing permission prompts is only defensible while
  // the agent is confined to its own worktree. Turning isolation off must not
  // silently leave an agent running unsupervised in the real working tree.
  if (!cfg.worktrees) {
    cfg.skipPermissions = false
    cfg.autoMerge = false
  }

  write(cfg)
  return getDock()
}

export function resetDock(): DockState {
  write(DEFAULTS())
  return getDock()
}
