/**
 * BRUTUS Studio — the command bar
 * --------------------------------
 * Turns the line at the bottom of the canvas into canvas mutations:
 *
 *   "add a Claude Code agent and a Codex agent, then connect them"
 *   "wire the reviewer back into the builder, revise until the tests pass"
 *
 * This is the integration only Brutus can offer — the canvas is scriptable in
 * English because the orchestrator's planner is already here.
 *
 * ── WHY THE MODEL NEVER TOUCHES THE CANVAS DIRECTLY ────────────────────────
 * The model proposes; `validateMutations` disposes. Everything it returns is
 * treated as untrusted: unknown agent kinds are dropped, agents that are not
 * installed are dropped (planning a node that cannot spawn just produces a
 * broken window), references that resolve to nothing are dropped, self-links
 * are dropped, and the batch is capped. A hallucinated node id therefore costs
 * one skipped operation rather than a corrupted workspace.
 *
 * Node references are deliberately loose — an id, a title, or a `ref` handle
 * for a node created earlier in the same batch — because a model asked to
 * "connect them" reaches for the name it just used, not a generated id.
 */
import type { AgentKind, EdgeKind, StudioEdge, StudioNode } from './types'

/** How many operations one command may produce. */
export const MAX_MUTATIONS = 12
export const MAX_LABEL_CHARS = 60
export const MAX_PROMPT_CHARS = 2000

export type CanvasMutation =
  | { op: 'add-node'; ref: string; agentKind: AgentKind; title: string; runMode?: string }
  | {
      op: 'connect'
      from: string
      to: string
      kind: EdgeKind
      label?: string
      maxIterations?: number
    }
  | { op: 'prompt'; target: string; text: string }
  | { op: 'remove-node'; target: string }

const EDGE_KINDS: EdgeKind[] = ['handoff', 'branch', 'loop']

export const COMMAND_SYSTEM = [
  'You edit an agent canvas. Reply with JSON only — no prose, no code fences.',
  '',
  'Shape: {"ops":[...]} where each op is one of:',
  '  {"op":"add-node","ref":"a","agentKind":"claude|codex|gemini|shell","title":"Apollo","runMode":"default"}',
  '  {"op":"connect","from":"a","to":"b","kind":"handoff|branch|loop","label":"...","maxIterations":3}',
  '  {"op":"prompt","target":"a","text":"..."}',
  '  {"op":"remove-node","target":"a"}',
  '',
  'Rules:',
  '- "from", "to" and "target" accept an existing node id, an existing node title,',
  '  or the "ref" of a node added earlier in the same batch.',
  '- Only use agentKind values listed as AVAILABLE. Never invent one.',
  '- Give each new node a short human name (Apollo, Atlas, Orion, Vega).',
  '- Use "loop" only when the user wants work sent back for revision, and always',
  '  set maxIterations.',
  '- Add a node only when the user asked for a new one; otherwise reuse existing nodes.',
  '- If the request cannot be expressed as canvas edits, reply {"ops":[]}.'
].join('\n')

export function commandPrompt(
  instruction: string,
  nodes: StudioNode[],
  edges: StudioEdge[],
  availableKinds: AgentKind[]
): string {
  const roster = nodes.length
    ? nodes.map((n) => `  ${n.id} — "${n.title}" (${n.agentKind ?? n.kind})`).join('\n')
    : '  (canvas is empty)'

  const wiring = edges.length
    ? edges.map((e) => `  ${e.source} -[${e.kind}]-> ${e.target}`).join('\n')
    : '  (nothing connected)'

  return [
    `AVAILABLE agentKind values: ${availableKinds.join(', ') || 'none'}`,
    '',
    'NODES:',
    roster,
    '',
    'CONNECTIONS:',
    wiring,
    '',
    `REQUEST: ${instruction}`
  ].join('\n')
}

interface ValidateOpts {
  nodes: StudioNode[]
  availableKinds: AgentKind[]
}

export interface ValidationResult {
  mutations: CanvasMutation[]
  /** Human-readable notes on what was dropped and why. */
  skipped: string[]
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : ''

/**
 * Validate and resolve a model-proposed batch.
 *
 * Pure and synchronous so it can be tested exhaustively without a model —
 * which matters, because this is the only thing standing between a
 * hallucination and the user's canvas.
 */
export function validateMutations(raw: unknown, opts: ValidateOpts): ValidationResult {
  const skipped: string[] = []
  const mutations: CanvasMutation[] = []

  const ops = Array.isArray((raw as { ops?: unknown })?.ops)
    ? ((raw as { ops: unknown[] }).ops as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : []

  if (!ops.length) return { mutations, skipped }

  // Resolvable names: existing ids, existing titles, and refs added in-batch.
  const byId = new Set(opts.nodes.map((n) => n.id))
  const byTitle = new Map(opts.nodes.map((n) => [n.title.toLowerCase(), n.id]))
  const newRefs = new Set<string>()

  const resolve = (name: unknown): string | null => {
    const key = str(name, 120)
    if (!key) return null
    if (byId.has(key) || newRefs.has(key)) return key
    const byName = byTitle.get(key.toLowerCase())
    return byName ?? null
  }

  for (const entry of ops) {
    if (mutations.length >= MAX_MUTATIONS) {
      skipped.push(`Stopped at ${MAX_MUTATIONS} operations.`)
      break
    }
    const op = str((entry as { op?: unknown })?.op, 20)

    if (op === 'add-node') {
      const e = entry as { ref?: unknown; agentKind?: unknown; title?: unknown; runMode?: unknown }
      const agentKind = str(e.agentKind, 20) as AgentKind
      if (!opts.availableKinds.includes(agentKind)) {
        skipped.push(`"${agentKind || 'unknown'}" is not an available agent.`)
        continue
      }
      const ref = str(e.ref, 60) || `new_${mutations.length}`
      if (byId.has(ref)) {
        skipped.push(`Ref "${ref}" collides with an existing node.`)
        continue
      }
      newRefs.add(ref)
      mutations.push({
        op: 'add-node',
        ref,
        agentKind,
        title: str(e.title, 40) || agentKind,
        runMode: str(e.runMode, 40) || undefined
      })
      continue
    }

    if (op === 'connect') {
      const e = entry as {
        from?: unknown
        to?: unknown
        kind?: unknown
        label?: unknown
        maxIterations?: unknown
      }
      const from = resolve(e.from)
      const to = resolve(e.to)
      if (!from || !to) {
        skipped.push(`Could not connect ${str(e.from, 40) || '?'} → ${str(e.to, 40) || '?'}.`)
        continue
      }
      if (from === to) {
        skipped.push('Skipped a node connected to itself.')
        continue
      }
      const kind = str(e.kind, 20) as EdgeKind
      const iterations = Number(e.maxIterations)
      mutations.push({
        op: 'connect',
        from,
        to,
        kind: EDGE_KINDS.includes(kind) ? kind : 'handoff',
        label: str(e.label, MAX_LABEL_CHARS) || undefined,
        maxIterations: Number.isFinite(iterations)
          ? Math.min(10, Math.max(1, Math.floor(iterations)))
          : undefined
      })
      continue
    }

    if (op === 'prompt') {
      const e = entry as { target?: unknown; text?: unknown }
      const target = resolve(e.target)
      const text = str(e.text, MAX_PROMPT_CHARS)
      if (!target || !text) {
        skipped.push(`Could not prompt ${str(e.target, 40) || '?'}.`)
        continue
      }
      mutations.push({ op: 'prompt', target, text })
      continue
    }

    if (op === 'remove-node') {
      const target = resolve((entry as { target?: unknown })?.target)
      if (!target) {
        skipped.push('Could not find the node to remove.')
        continue
      }
      mutations.push({ op: 'remove-node', target })
      continue
    }

    skipped.push(`Unknown operation "${op}".`)
  }

  return { mutations, skipped }
}
