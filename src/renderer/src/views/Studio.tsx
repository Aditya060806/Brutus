import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import ReactFlow, {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useOnViewportChange,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange
} from 'reactflow'
import 'reactflow/dist/style.css'
import { motion, AnimatePresence } from 'framer-motion'
import {
  RiAddLine,
  RiFlashlightLine,
  RiSendPlane2Fill,
  RiFocus3Line,
  RiGridLine,
  RiLoader4Line,
  RiTerminalBoxLine,
  RiPulseLine,
  RiArrowLeftLine,
  RiAlertLine,
  RiDashboardLine,
  RiStopCircleLine
} from 'react-icons/ri'
import AgentNode, { type AgentNodeData } from '@renderer/components/studio/AgentNode'
import AgentPicker from '@renderer/components/studio/AgentPicker'
import CanvasDock from '@renderer/components/studio/CanvasDock'
import NoteNode, { type NoteNodeData } from '@renderer/components/studio/NoteNode'
import PreviewNode, { type PreviewNodeData } from '@renderer/components/studio/PreviewNode'
import ApprovalCard from '@renderer/components/studio/ApprovalCard'
import EdgeInspector, { type EdgeInspectorValue } from '@renderer/components/studio/EdgeInspector'
import BackdropPicker from '@renderer/components/studio/BackdropPicker'
import StudioLauncher from '@renderer/components/studio/StudioLauncher'
import StudioErrorBoundary from '@renderer/components/studio/StudioErrorBoundary'
import ActivityPanel from '@renderer/components/studio/ActivityPanel'
import MissionDashboard from '@renderer/components/studio/MissionDashboard'
import { DEFAULT_BACKDROP, backdropById } from '@renderer/components/studio/backdrops'
import { LiveNodesContext } from '@renderer/components/studio/live-context'
import { destroyTerminal } from '@renderer/components/studio/terminal-pool'
import { sameIds, visibleNodeIds } from '@renderer/components/studio/viewport-cull'
import {
  studio,
  isLoopbackUrl,
  type AgentInfo,
  type Autonomy,
  type CanvasMutation,
  type DockItem,
  type EdgeKind,
  type MissionEdge,
  type MissionPlan,
  type PreviewEvent,
  type RoutedEvent,
  type SessionStatus,
  type StudioApproval,
  type StudioNode,
  type StudioWorkspace
} from '@renderer/services/studio-client'

/**
 * BRUTUS Studio — the canvas.
 *
 * Real coding-agent CLIs run as live terminals in draggable windows, wired
 * together with visible strings. The processes live in the main process; this
 * view is the workshop around them.
 */

const nodeTypes = { agent: AgentNode, note: NoteNode, preview: PreviewNode }

/**
 * The canvas holds three kinds of node, so reads of `.data` have to narrow
 * first. A cast would compile and then blow up the moment a note is on screen.
 */
type CanvasNodeData = AgentNodeData | NoteNodeData | PreviewNodeData
type CanvasNode = Node<CanvasNodeData>

const isAgent = (n: CanvasNode): n is Node<AgentNodeData> => n.type === 'agent'
const isPreview = (n: CanvasNode): n is Node<PreviewNodeData> => n.type === 'preview'
const isNote = (n: CanvasNode): n is Node<NoteNodeData> => n.type === 'note'
const agentData = (n: CanvasNode | undefined): AgentNodeData | null =>
  n && isAgent(n) ? n.data : null

let nodeSeq = 0
const NAMES = ['Apollo', 'Atlas', 'Orion', 'Vega', 'Lyra', 'Rigel', 'Nova', 'Draco']

/**
 * Window geometry.
 *
 * An agent window holds a real TUI: Claude Code draws a banner, a status line
 * and an input box before any work is visible, and Codex is similar. At the old
 * 400×340 the actual conversation got a handful of rows and every node showed a
 * scrollbar, so the default is the size the content needs rather than the
 * smallest thing that fits on screen.
 */
const AGENT_W = 500
const AGENT_H = 420
/** Collapsed to just the title bar. */
const BAR_H = 38
const PREVIEW_W = 460
const PREVIEW_H = 400
const NOTE_W = 260
const NOTE_H = 180
/** Gap between an agent and the preview window opened beside it. */
const PREVIEW_GAP = 44

/**
 * The string tying a preview window to the agent serving it.
 *
 * Deliberately unlike a routing edge: it carries no data and can never fire, so
 * it reads as a quiet sky-blue tether rather than another red handoff the user
 * might expect work to flow along. `data.preview` marks it so it is kept out of
 * the router's graph and out of the edge inspector.
 */
const previewEdgeStyle = {
  type: 'smoothstep',
  animated: false,
  selectable: false,
  focusable: false,
  className: 'studio-tether',
  data: { preview: true },
  style: {
    stroke: '#38bdf8',
    strokeWidth: 1.25,
    strokeDasharray: '2 5',
    opacity: 0.45
  }
} as const

/** Is this edge the preview tether rather than a routing string? */
const isPreviewEdge = (e: Edge): boolean =>
  (e.data as { preview?: boolean } | undefined)?.preview === true

/**
 * A window's current size.
 *
 * Read from React Flow's measured `width`/`height` first and `style` only as a
 * fallback: dragging a resize handle always updates the former, while the latter
 * is only written when the resizer asks for it. Reading style alone meant a
 * resized window came back at its old size.
 */
function sizeOf(
  n: CanvasNode,
  fallbackW: number,
  fallbackH: number
): {
  width: number
  height: number
} {
  return {
    width: Math.round(Number(n.width ?? n.style?.width ?? fallbackW)),
    height: Math.round(Number(n.height ?? n.style?.height ?? fallbackH))
  }
}

function StudioCanvas({
  workspaceId,
  onLeave
}: {
  workspaceId: string
  onLeave: () => void
}): ReactElement {
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [engine, setEngine] = useState<{ ok: boolean; error?: string } | null>(null)
  const [workspace, setWorkspace] = useState<StudioWorkspace | null>(null)
  const [command, setCommand] = useState('')
  const [autoRoute, setAutoRoute] = useState(true)
  const [snap, setSnap] = useState(false)
  const [approval, setApproval] = useState<StudioApproval | null>(null)
  const [autonomy, setAutonomy] = useState<Autonomy>('guarded')
  const [commandBusy, setCommandBusy] = useState(false)
  const [commandNote, setCommandNote] = useState<string | null>(null)
  /** Edges that carried data in the last couple of seconds. */
  const [activeEdges, setActiveEdges] = useState<Set<string>>(new Set())
  const [lastRouted, setLastRouted] = useState<RoutedEvent | null>(null)
  /** Nodes near enough to the viewport to keep a live terminal. */
  const [liveNodes, setLiveNodes] = useState<Set<string>>(new Set())
  /** The edge whose inspector is open. */
  const [inspected, setInspected] = useState<string | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  /**
   * Note text, kept out of node data so a keystroke does not rewrite the whole
   * graph and re-run React Flow's diff.
   *
   * The debounced save reads it through `notesRef`, which is what makes a note
   * survive reopening the workspace — the text used to be written here and then
   * never read by anything, so every note came back blank.
   */
  const [notes, setNotes] = useState<Map<string, string>>(new Map())
  const notesRef = useRef<Map<string, string>>(notes)
  notesRef.current = notes
  const rf = useReactFlow()
  const wrapRef = useRef<HTMLDivElement>(null)
  /** Current nodes, for reads that must not happen inside a state updater. */
  const nodesRef = useRef<CanvasNode[]>([])
  nodesRef.current = nodes

  // ── Boot: engine check, adapter roster, saved workspace ───────────────────
  useEffect(() => {
    void studio.available().then(setEngine)
    void studio.agents().then(setAgents)
    void studio.autonomy().then(setAutonomy)
    void studio.openWorkspace(workspaceId).then((ws) => {
      if (!ws) return
      setWorkspace(ws)
    })
    // The agent is blocked while an approval is pending, so this subscription
    // is the thing standing between it and the user's machine.
    return studio.onApproval(setApproval)
  }, [workspaceId])

  const rootDir = workspace?.rootDir ?? ''

  // ── Node lifecycle ────────────────────────────────────────────────────────

  const patch = useCallback((id: string, data: Partial<AgentNodeData>) => {
    setNodes((ns) =>
      ns.map((n) => (n.id === id && isAgent(n) ? { ...n, data: { ...n.data, ...data } } : n))
    )
  }, [])

  /**
   * Remove an agent window, its terminal, and anything that only existed because
   * of it.
   *
   * The preview window is the "anything else": its dev server was a child of the
   * terminal being killed, so leaving the frame on the canvas would point a live
   * window at a port that has just stopped answering. Doing this in one place
   * means the close button, the command bar's `remove-node` and Stop-all cannot
   * drift apart on what "remove an agent" means.
   */
  const removeAgent = useCallback((id: string) => {
    /**
     * Everything is read off the ref rather than from inside an updater.
     *
     * React may invoke a state updater twice, and killing a pty twice — or
     * nesting `setEdges` inside `setNodes` — is exactly the kind of double
     * effect that produces a stray keystroke in a terminal that no longer
     * exists. The reads happen once, here, and the updaters stay pure.
     */
    const current = nodesRef.current
    const session = agentData(current.find((n) => n.id === id))?.sessionId
    if (session) {
      studio.kill(session)
      destroyTerminal(session)
    }
    studio.forgetPreview(id)

    const doomed = new Set<string>([id])
    for (const n of current) if (isPreview(n) && n.data.sourceNodeId === id) doomed.add(n.id)

    setNodes((ns) => ns.filter((n) => !doomed.has(n.id)))
    setEdges((es) => es.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)))
  }, [])

  /**
   * Start the real CLI behind a node.
   *
   * Returns the session id, or null if the spawn failed. The node's own setup
   * card ignores the result — it reads the error from node data — but the
   * Dashboard needs to know whether the crew it just placed actually came up.
   */
  const launch = useCallback(
    async (
      id: string,
      kind: string,
      opts: { runMode: string; cwd: string }
    ): Promise<string | null> => {
      patch(id, { error: undefined })
      const res = await studio.spawn({
        kind: kind as AgentInfo['kind'],
        cwd: opts.cwd,
        runMode: opts.runMode,
        cols: 100,
        rows: 28,
        // Binds the terminal to this canvas node, which is how edges find
        // their endpoints when the router delivers a handoff.
        nodeId: id
      })
      if (!res.ok || !res.session) {
        patch(id, { error: res.error ?? 'Could not start this agent.' })
        return null
      }
      const sid = res.session.id
      patch(id, {
        sessionId: sid,
        status: res.session.status,
        runMode: opts.runMode,
        cwd: opts.cwd,
        exitCode: undefined
      })
      // Track this session's status for the node's dot and footer.
      studio.onStatus(sid, (status: SessionStatus, exitCode?: number) =>
        patch(id, { status, exitCode })
      )
      return sid
    },
    [patch]
  )

  /**
   * Build a node's data, handlers included.
   *
   * Shared by "add an agent" and "restore a saved workspace". Saved workspaces
   * store only the serialisable half — the callbacks below cannot survive JSON,
   * so restoring has to rebuild them rather than revive them.
   */
  const makeData = useCallback(
    (
      id: string,
      kind: string,
      info: AgentInfo,
      over: { title?: string; runMode?: string; cwd?: string; autoReply?: boolean }
    ): AgentNodeData => ({
      title: over.title || NAMES[nodeSeq % NAMES.length],
      agentKind: kind,
      agentLabel: info.label,
      accent: info.accent,
      info,
      cwd: over.cwd ?? rootDir,
      runMode: over.runMode || info.defaultRunMode,
      autoReply: over.autoReply ?? true,
      status: 'exited', // no session yet → shows the setup card
      onLaunch: (o) => void launch(id, kind, o),
      onClose: () => removeAgent(id),
      onCollapse: () =>
        setNodes((ns) =>
          ns.map((n) =>
            n.id === id && isAgent(n)
              ? {
                  ...n,
                  data: { ...n.data, collapsed: !n.data.collapsed },
                  style: { ...n.style, height: n.data.collapsed ? AGENT_H : BAR_H }
                }
              : n
          )
        ),
      onMaximize: () => rf.fitView({ nodes: [{ id }], duration: 400, padding: 0.2 }),
      onRestart: () => {
        setNodes((ns) => {
          const session = agentData(ns.find((n) => n.id === id))?.sessionId
          if (session) {
            studio.kill(session)
            destroyTerminal(session)
          }
          return ns
        })
        patch(id, { sessionId: undefined, status: 'exited' })
      },
      onPickFolder: async () => {
        const p = await studio.pickFolder()
        if (p) patch(id, { cwd: p })
      },
      onToggleAutoReply: () =>
        setNodes((ns) =>
          ns.map((n) =>
            n.id === id && isAgent(n)
              ? { ...n, data: { ...n.data, autoReply: !n.data.autoReply } }
              : n
          )
        )
    }),
    [launch, patch, rf, rootDir, removeAgent]
  )

  /**
   * Build a sticky note's data, handlers included.
   *
   * Shared by "add a note" and "restore a saved one", for the same reason
   * `makeData` is: the callbacks cannot survive JSON, so restoring rebuilds them.
   *
   * Pure — the restore effect seeds the notes map itself. Writing state from in
   * here would mean a `setNotes` running inside a `setNodes` updater, which
   * React may invoke twice.
   */
  const makeNoteData = useCallback((id: string, initial: string): NoteNodeData => {
    return {
      text: initial,
      onChange: (text) =>
        setNotes((m) => {
          const next = new Map(m)
          next.set(id, text)
          return next
        }),
      onClose: () => {
        setNodes((ns) => ns.filter((n) => n.id !== id))
        setNotes((m) => {
          if (!m.has(id)) return m
          const next = new Map(m)
          next.delete(id)
          return next
        })
      }
    }
  }, [])

  /**
   * Build a preview window's data, handlers included.
   *
   * Same split as `makeData`: only the serialisable half is persisted, and the
   * callbacks are rebuilt here on restore.
   */
  const makePreviewData = useCallback(
    (
      id: string,
      url: string,
      over: { sourceNodeId?: string; sourceTitle?: string; kind?: 'server' | 'file' }
    ): PreviewNodeData => ({
      url,
      kind: over.kind ?? 'server',
      sourceTitle: over.sourceTitle,
      sourceNodeId: over.sourceNodeId,
      onClose: () => {
        // Forget it in the client too. Without this the remembered detection
        // replays on the next mount and the window the user just closed comes
        // straight back.
        if (over.sourceNodeId) studio.forgetPreview(over.sourceNodeId)
        setNodes((ns) => ns.filter((n) => n.id !== id))
        setEdges((es) => es.filter((e) => e.source !== id && e.target !== id))
      },
      onCollapse: () =>
        setNodes((ns) =>
          ns.map((n) =>
            n.id === id && isPreview(n)
              ? {
                  ...n,
                  data: { ...n.data, collapsed: !n.data.collapsed },
                  style: { ...n.style, height: n.data.collapsed ? PREVIEW_H : BAR_H }
                }
              : n
          )
        )
    }),
    []
  )

  /**
   * Put a detected dev server on the canvas, or move an existing window to it.
   *
   * One preview per agent: an agent that restarts its server — or prints the
   * banner twice, which Vite does on a full reload — must update the window it
   * already has rather than stack another one on top of it.
   *
   * The window is placed to the agent's right and wired with a visible string,
   * so "the frontend belongs to that terminal" is something you can see rather
   * than infer.
   */
  const upsertPreview = useCallback(
    (ev: PreviewEvent) => {
      /**
       * Everything is decided here, off the ref, before any state is touched.
       *
       * The earlier shape nested `setEdges` inside a `setNodes` updater to reach
       * the id it had just generated. React may invoke an updater twice, so that
       * is not a safe place to cause anything; deciding the id up front removes
       * the need to.
       */
      const current = nodesRef.current
      const source = current.find((n) => n.id === ev.nodeId)
      // The agent may have been closed between its server starting and this
      // arriving. A preview with nothing to belong to is just a stray window.
      if (!source) return

      // Match on the relationship, not the id, so a window restored from an
      // older save is adopted rather than duplicated alongside a new one.
      // Filtered before finding so the result is narrowed to a preview node —
      // `find` with a guard inside the predicate does not narrow its return.
      const existing = current.filter(isPreview).find((n) => n.data.sourceNodeId === ev.nodeId)
      /** Derived from the agent, which is what keeps it one-per-agent. */
      const id = existing?.id ?? `pv_${ev.nodeId}`

      if (existing) {
        /**
         * A live server outranks a static file.
         *
         * An agent that starts a dev server and then edits a template fires a
         * file detection straight after the server one. Letting that through
         * would swap a working preview for a `file://` view of a half-written
         * template — the page would look broken while the real one was running
         * a few pixels away.
         */
        if (ev.kind === 'file' && existing.data.kind === 'server') return

        setNodes((ns) =>
          ns.map((n) =>
            n.id === id && isPreview(n)
              ? { ...n, data: { ...n.data, url: ev.url, kind: ev.kind } }
              : n
          )
        )
      } else {
        const sourceW = sizeOf(source, AGENT_W, AGENT_H).width
        const title = agentData(source)?.title
        const node: CanvasNode = {
          id,
          type: 'preview',
          position: { x: source.position.x + sourceW + PREVIEW_GAP, y: source.position.y },
          data: makePreviewData(id, ev.url, {
            sourceNodeId: ev.nodeId,
            sourceTitle: title,
            kind: ev.kind
          }),
          style: { width: PREVIEW_W, height: PREVIEW_H },
          dragHandle: '.studio-drag'
        }
        setNodes((ns) => (ns.some((n) => n.id === id) ? ns : [...ns, node]))
      }

      // `addEdge` de-duplicates on source/target, so a server announced twice
      // cannot accumulate tethers between the same two windows.
      setEdges((es) =>
        addEdge(
          {
            id: `e_${ev.nodeId}_${id}`,
            source: ev.nodeId,
            target: id,
            sourceHandle: 'out-right',
            ...previewEdgeStyle
          },
          es
        )
      )
    },
    [makePreviewData]
  )

  /**
   * Add an agent window. Returns the new node's id so the command bar can
   * connect nodes it created in the same batch.
   */
  const addAgent = useCallback(
    (kind: string, overrides?: { title?: string; runMode?: string }): string | null => {
      const info = agents.find((a) => a.kind === kind)
      if (!info) return null
      const id = `n${++nodeSeq}_${Date.now()}`

      // Drop it at the centre of what the user is currently looking at.
      const rect = wrapRef.current?.getBoundingClientRect()
      const centre = rf.screenToFlowPosition({
        x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2
      })

      setNodes((ns) => [
        ...ns,
        {
          id,
          type: 'agent',
          position: {
            x: centre.x - AGENT_W / 2 + ns.length * 24,
            y: centre.y - AGENT_H / 2 + ns.length * 18
          },
          data: makeData(id, kind, info, overrides ?? {}),
          style: { width: AGENT_W, height: AGENT_H },
          dragHandle: '.studio-drag'
        }
      ])
      setPickerOpen(false)
      return id
    },
    [agents, makeData, rf]
  )

  /**
   * Restore a saved canvas once the adapter roster is known.
   *
   * Waits for `agents` because each node needs its adapter's label, accent and
   * run modes. Terminals are deliberately not restored — every node comes back
   * in its setup state, because silently re-launching agents against a repo
   * before the user has looked at the screen is not a thing to do.
   */
  const restoredRef = useRef<string | null>(null)
  useEffect(() => {
    if (!workspace || !agents.length) return
    if (restoredRef.current === workspace.id) return
    restoredRef.current = workspace.id

    let cancelled = false

    void (async () => {
      /**
       * Re-adopt terminals that are still running.
       *
       * Agents outlive the canvas by design — closing a workspace or switching
       * tab must not stop work that is mid-flight. So before rebuilding a node
       * we ask main what is still alive and, where a session remembers this
       * node, the node comes back live with its terminal replayed from
       * scrollback rather than showing a setup card over a working agent.
       */
      const live = await studio.listSessions().catch(() => [])
      if (cancelled) return

      const adopted = new Map(
        live
          .filter((s) => s.nodeId && s.status !== 'exited' && s.status !== 'failed')
          .map((s) => [s.nodeId as string, s])
      )

      setNodes(
        workspace.nodes.flatMap((n): CanvasNode[] => {
          // ── Preview windows ──
          if (n.kind === 'preview') {
            // Re-validated on the way in: a saved workspace is untrusted input
            // and this URL goes straight into a live frame.
            if (!isLoopbackUrl(n.previewUrl)) return []
            const sourceTitle = workspace.nodes.find((s) => s.id === n.sourceNodeId)?.title
            return [
              {
                id: n.id,
                type: 'preview',
                position: { x: n.x, y: n.y },
                data: makePreviewData(n.id, n.previewUrl as string, {
                  sourceNodeId: n.sourceNodeId,
                  sourceTitle,
                  // A saved file:// URL comes back as a file; anything else was
                  // a server when it was written.
                  kind: n.previewUrl?.startsWith('file:') ? 'file' : 'server'
                }),
                style: { width: n.width || PREVIEW_W, height: n.height || PREVIEW_H },
                dragHandle: '.studio-drag'
              }
            ]
          }

          // ── Sticky notes ──
          if (n.kind === 'note') {
            return [
              {
                id: n.id,
                type: 'note',
                position: { x: n.x, y: n.y },
                data: makeNoteData(n.id, n.text ?? ''),
                style: { width: n.width || NOTE_W, height: n.height || NOTE_H },
                dragHandle: '.studio-drag'
              }
            ]
          }

          // ── Agent windows ──
          const info = agents.find((a) => a.kind === n.agentKind)
          if (!info || !n.agentKind) return []
          const session = adopted.get(n.id)

          const data = makeData(n.id, n.agentKind, info, {
            title: n.title,
            runMode: n.runMode,
            cwd: n.cwd,
            autoReply: n.autoReply
          })

          if (session) {
            data.sessionId = session.id
            data.status = session.status
            data.cwd = session.cwd || data.cwd
            data.runMode = session.runMode || data.runMode
            data.exitCode = undefined
          }

          return [
            {
              id: n.id,
              type: 'agent',
              position: { x: n.x, y: n.y },
              data,
              style: { width: n.width || AGENT_W, height: n.height || AGENT_H },
              dragHandle: '.studio-drag'
            }
          ]
        })
      )

      /**
       * Routing strings come from the file; preview tethers are derived.
       *
       * The tether is not independent state — it is a drawing of
       * `preview.sourceNodeId`, which is already persisted on the node. Deriving
       * it here means a saved workspace can never contain an edge pointing at a
       * preview window that failed URL validation and was dropped above, and it
       * keeps the router's edge vocabulary to the three kinds it can actually
       * fire.
       */
      const tethers = workspace.nodes
        .filter((n) => n.kind === 'preview' && n.sourceNodeId && isLoopbackUrl(n.previewUrl))
        .map((n) => ({
          id: `e_${n.sourceNodeId}_${n.id}`,
          source: n.sourceNodeId as string,
          target: n.id,
          sourceHandle: 'out-right',
          ...previewEdgeStyle
        }))

      setEdges([
        ...workspace.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          data: { kind: e.kind, maxIterations: e.maxIterations }
        })),
        ...tethers
      ])

      /**
       * Seed the notes map from the file.
       *
       * Without this a restored note that is never edited would be written back
       * as empty on the next save, quietly erasing it.
       */
      const savedNotes = workspace.nodes.filter((n) => n.kind === 'note' && n.text)
      if (savedNotes.length) {
        setNotes((m) => {
          const next = new Map(m)
          for (const n of savedNotes) next.set(n.id, n.text as string)
          return next
        })
      }

      /**
       * Re-subscribe status for every adopted session.
       *
       * Done after the nodes are in place and outside the `flatMap` above: that
       * runs inside a state updater, which React may invoke twice, and
       * subscribing twice would double every status update.
       */
      for (const [nodeId, session] of adopted) {
        studio.onStatus(session.id, (status: SessionStatus, exitCode?: number) =>
          patch(nodeId, { status, exitCode })
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [workspace, agents, makeData, makePreviewData, makeNoteData, patch])

  // ── Canvas plumbing ───────────────────────────────────────────────────────

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    []
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    []
  )
  /**
   * Edge styling by kind.
   *
   * Idle strings are deliberately thin and dim: on a busy canvas the point is
   * to see *which one is carrying data right now*, and everything glowing at
   * once tells you nothing. Only an edge that just routed is animated.
   */
  const edgeStyle = useCallback((kind: EdgeKind, active: boolean) => {
    const stroke = kind === 'loop' ? '#f59e0b' : kind === 'branch' ? '#38bdf8' : '#ef4444'
    return {
      type: 'smoothstep',
      animated: active,
      style: {
        stroke,
        strokeWidth: active ? 2.4 : 1.5,
        strokeDasharray: kind === 'loop' ? '6 4' : undefined,
        opacity: active ? 1 : 0.55,
        transition: 'stroke-width 200ms ease, opacity 200ms ease'
      },
      /**
       * An opaque plate behind the label.
       *
       * The midpoint of a curve between two adjacent windows often lands in the
       * gap between them, where bare label text overlapped a window edge and
       * read as cut off. The plate, the padding and the matching border make it
       * legible wherever the curve happens to put it.
       */
      labelShowBg: true,
      labelBgPadding: [7, 4] as [number, number],
      labelBgBorderRadius: 6,
      labelBgStyle: { fill: 'rgba(9,9,11,0.92)', stroke, strokeOpacity: 0.35 },
      labelStyle: { fill: '#d4d4d8', fontSize: 10, fontWeight: 600 }
    }
  }, [])

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) =>
        addEdge({ ...c, ...edgeStyle('handoff', false), data: { kind: 'handoff' } }, es)
      ),
    [edgeStyle]
  )

  // ── Routing ───────────────────────────────────────────────────────────────

  /**
   * Push the wiring to main whenever it actually changes.
   *
   * Positions are deliberately absent from the payload. The router does not
   * care where a window sits, and including them would fire an IPC message on
   * every animation frame of a drag.
   */
  const lastGraphRef = useRef('')
  useEffect(() => {
    const agentNodes = nodes.filter(isAgent)
    /**
     * Only strings between two agents are wiring.
     *
     * Checked against the node set rather than by trusting the tether's own
     * flag, because the consequence of getting this wrong is the router typing
     * one agent's output into a preview window — a delivery that silently goes
     * nowhere and looks like the handoff simply failed.
     */
    const agentIds = new Set(agentNodes.map((n) => n.id))

    const payload = {
      nodes: agentNodes.map((n) => ({
        id: n.id,
        kind: 'agent' as const,
        agentKind: n.data.agentKind as StudioNode['agentKind'],
        title: n.data.title,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        cwd: n.data.cwd,
        runMode: n.data.runMode,
        autoReply: n.data.autoReply
      })),
      edges: edges
        .filter((e) => !isPreviewEdge(e) && agentIds.has(e.source) && agentIds.has(e.target))
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          kind: ((e.data as { kind?: EdgeKind })?.kind ?? 'handoff') as EdgeKind,
          label: typeof e.label === 'string' ? e.label : undefined,
          maxIterations: (e.data as { maxIterations?: number })?.maxIterations
        })),
      autoRoute
    }
    const signature = JSON.stringify(payload)
    if (signature === lastGraphRef.current) return
    lastGraphRef.current = signature
    studio.syncGraph(payload)
  }, [nodes, edges, autoRoute])

  // ── Dock ──────────────────────────────────────────────────────────────────

  const [dockItems, setDockItems] = useState<DockItem[]>([])
  /** Agent kind the picker pre-selects, from Settings → Studio. */
  const [defaultAgent, setDefaultAgent] = useState<string>('')
  useEffect(() => {
    let cancelled = false
    void studio.getDock().then((d) => {
      if (!cancelled) {
        setDockItems(d.onDock)
        setDefaultAgent(d.defaultAgent)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** Drop a sticky note at the middle of the view. */
  const addNote = useCallback(() => {
    const id = `note${++nodeSeq}_${Date.now()}`
    const rect = wrapRef.current?.getBoundingClientRect()
    const centre = rf.screenToFlowPosition({
      x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2,
      y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2
    })
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: 'note',
        position: { x: centre.x - NOTE_W / 2, y: centre.y - NOTE_H / 2 },
        data: makeNoteData(id, ''),
        style: { width: NOTE_W, height: NOTE_H },
        dragHandle: '.studio-drag'
      }
    ])
  }, [rf, makeNoteData])

  /** The default agent leads the picker, so the common case is the first click. */
  const orderedAgents = useMemo(() => {
    if (!defaultAgent) return agents
    return [...agents].sort(
      (a, b) => Number(b.kind === defaultAgent) - Number(a.kind === defaultAgent)
    )
  }, [agents, defaultAgent])

  const pickFromDock = useCallback(
    (item: DockItem) => {
      if (item.node === 'note') addNote()
      else if (item.agentKind) addAgent(item.agentKind)
    },
    [addAgent, addNote]
  )

  // ── Terminal virtualisation ───────────────────────────────────────────────

  /**
   * Recompute which nodes are near enough to the viewport to deserve a live
   * terminal.
   *
   * The margin is generous on purpose: tearing a terminal down the instant it
   * touches the edge of the screen makes a slow pan flicker, and remounting is
   * more expensive than keeping one alive slightly too long.
   */
  const recomputeLive = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const { x, y, zoom } = rf.getViewport()

    const next = visibleNodeIds(
      nodesRef.current.map((n) => ({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        ...sizeOf(n, AGENT_W, AGENT_H)
      })),
      { x, y, zoom, width: wrap.clientWidth, height: wrap.clientHeight }
    )

    // Only publish a genuinely different set: a new Set identity would remount
    // every terminal on the canvas.
    setLiveNodes((prev) => (sameIds(prev, next) ? prev : next))
  }, [rf])

  /**
   * Debounced, because this runs on every frame of a pan. During the gesture
   * nothing re-renders; the set is recomputed once the view settles.
   */
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleLiveCheck = useCallback(() => {
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
    liveTimerRef.current = setTimeout(recomputeLive, 140)
  }, [recomputeLive])

  useOnViewportChange({ onChange: scheduleLiveCheck })

  useEffect(() => {
    scheduleLiveCheck()
    window.addEventListener('resize', scheduleLiveCheck)
    return () => {
      window.removeEventListener('resize', scheduleLiveCheck)
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
    }
  }, [scheduleLiveCheck, nodes.length])

  /**
   * Persist the canvas.
   *
   * Debounced, because dragging a node fires a change per frame and this writes
   * a file. Only the serialisable half is stored — the handlers in node data
   * cannot survive JSON, and are rebuilt by `makeData` on restore.
   */
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The latest snapshot, so unmount can flush what the timer had not written. */
  const pendingSaveRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    // Nothing to save until the workspace has actually loaded, or we would
    // overwrite a real saved canvas with the empty initial state.
    if (!workspace || restoredRef.current !== workspace.id) return

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const write = (): void => {
      pendingSaveRef.current = null
      const agentNodes: StudioNode[] = nodesRef.current.filter(isAgent).map((n) => ({
        id: n.id,
        kind: 'agent' as const,
        agentKind: n.data.agentKind as StudioNode['agentKind'],
        title: n.data.title,
        x: n.position.x,
        y: n.position.y,
        ...sizeOf(n, AGENT_W, AGENT_H),
        cwd: n.data.cwd,
        runMode: n.data.runMode,
        autoReply: n.data.autoReply,
        collapsed: n.data.collapsed
      }))

      /**
       * Preview windows are saved too, so reopening a workspace still shows the
       * frontend beside the agent that built it. What is stored is just the URL
       * and which agent it belongs to — the tether edge is redrawn from that.
       */
      const previewNodes: StudioNode[] = nodesRef.current.filter(isPreview).map((n) => ({
        id: n.id,
        kind: 'preview' as const,
        title: 'Preview',
        x: n.position.x,
        y: n.position.y,
        ...sizeOf(n, PREVIEW_W, PREVIEW_H),
        previewUrl: n.data.url,
        sourceNodeId: n.data.sourceNodeId,
        collapsed: n.data.collapsed
      }))

      /** Sticky notes, with whatever has been typed into them. */
      const noteNodes: StudioNode[] = nodesRef.current.filter(isNote).map((n) => ({
        id: n.id,
        kind: 'note' as const,
        title: 'Note',
        x: n.position.x,
        y: n.position.y,
        ...sizeOf(n, NOTE_W, NOTE_H),
        text: notesRef.current.get(n.id) ?? n.data.text ?? ''
      }))

      void studio.saveWorkspace({
        id: workspace.id,
        nodes: [...agentNodes, ...previewNodes, ...noteNodes],
        // Tethers are excluded: they are a drawing of `sourceNodeId`, not state,
        // and persisting them would let the file disagree with the nodes.
        edges: edges
          .filter((e) => !isPreviewEdge(e))
          .map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            kind: ((e.data as { kind?: EdgeKind })?.kind ?? 'handoff') as EdgeKind,
            label: typeof e.label === 'string' ? e.label : undefined,
            maxIterations: (e.data as { maxIterations?: number })?.maxIterations
          })),
        viewport: rf.getViewport()
      })
    }
    pendingSaveRef.current = write
    saveTimerRef.current = setTimeout(write, 700)

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
    // `notes` is in here so typing into a sticky note schedules a save. The
    // 700ms debounce already absorbs the keystrokes, and text that is never
    // written is worse than a write that happens slightly more often.
  }, [nodes, edges, notes, workspace, rf])

  /**
   * Flush on the way out.
   *
   * The debounce dropped work: closing a workspace, or leaving Studio, within
   * 700ms of the last edit cancelled the timer and the change was simply lost.
   * Running the pending write once, on unmount only, keeps the debounce cheap
   * while making it impossible to lose the final edit.
   */
  useEffect(() => {
    return () => {
      pendingSaveRef.current?.()
    }
  }, [])

  /**
   * Open a window on whatever the agents just started serving.
   *
   * Detection happens in main against every stream, so this fires whether or not
   * the agent's window was on screen at the time. Anything detected before this
   * subscription is replayed by the client on subscribe, which is what makes a
   * server started during boot — or before the workspace was reopened — still
   * show up here.
   */
  useEffect(() => {
    return studio.onPreview((ev) => {
      if (!isLoopbackUrl(ev.url)) return
      upsertPreview(ev)
    })
  }, [upsertPreview])

  /** Light up an edge for a moment when it carries something. */
  useEffect(() => {
    return studio.onRouted((ev) => {
      setActiveEdges((s) => new Set(s).add(ev.edgeId))
      setLastRouted(ev)
      window.setTimeout(() => {
        setActiveEdges((s) => {
          const next = new Set(s)
          next.delete(ev.edgeId)
          return next
        })
      }, 2200)
    })
  }, [])

  const styledEdges = useMemo(
    () =>
      edges.map((e) => {
        // Tethers keep their own quiet styling — they carry nothing, so they must
        // never animate or thicken as though they had.
        if (isPreviewEdge(e)) return e
        const kind = ((e.data as { kind?: EdgeKind })?.kind ?? 'handoff') as EdgeKind
        const styled = { ...e, ...edgeStyle(kind, activeEdges.has(e.id)) }
        if (e.id === inspected) {
          styled.style = { ...styled.style, strokeWidth: 3, opacity: 1 }
        }
        return styled
      }),
    [edges, activeEdges, edgeStyle, inspected]
  )

  // ── Edge inspector ────────────────────────────────────────────────────────

  const inspectedEdge = useMemo(
    () => edges.find((e) => e.id === inspected) ?? null,
    [edges, inspected]
  )

  const patchEdge = useCallback((id: string, patch: Partial<EdgeInspectorValue>) => {
    setEdges((es) =>
      es.map((e) => {
        if (e.id !== id) return e
        const data = (e.data ?? {}) as { kind?: EdgeKind; maxIterations?: number }
        return {
          ...e,
          label: patch.label !== undefined ? patch.label : e.label,
          data: {
            ...data,
            kind: patch.kind ?? data.kind ?? 'handoff',
            maxIterations: patch.maxIterations ?? data.maxIterations
          }
        }
      })
    )
  }, [])

  const titleOf = useCallback(
    (nodeId: string) => agentData(nodes.find((n) => n.id === nodeId))?.title ?? nodeId,
    [nodes]
  )

  // ── Command bar ───────────────────────────────────────────────────────────

  /**
   * Apply what the command bar proposed.
   *
   * Main has already dropped anything it could not resolve, so everything here
   * refers to a real node or to a `ref` created earlier in this same batch.
   */
  const applyMutations = useCallback(
    (mutations: CanvasMutation[]) => {
      const refs = new Map<string, string>()
      const resolve = (name: string): string => refs.get(name) ?? name

      for (const m of mutations) {
        if (m.op === 'add-node') {
          const created = addAgent(m.agentKind, { title: m.title, runMode: m.runMode })
          if (created) refs.set(m.ref, created)
        } else if (m.op === 'connect') {
          const source = resolve(m.from)
          const target = resolve(m.to)
          setEdges((es) =>
            addEdge(
              {
                id: `e_${source}_${target}_${Date.now()}`,
                source,
                target,
                label: m.label,
                ...edgeStyle(m.kind, false),
                data: { kind: m.kind, maxIterations: m.maxIterations }
              },
              es
            )
          )
        } else if (m.op === 'prompt') {
          // Read through the ref, never inside a state updater: React may
          // invoke an updater twice, and typing the same prompt into a live
          // agent twice would run the work twice.
          const target = resolve(m.target)
          const session = agentData(nodesRef.current.find((x) => x.id === target))?.sessionId
          if (session) studio.write(session, `${m.text}\r`)
        } else if (m.op === 'remove-node') {
          // Same path as the window's own close button, so a removal by command
          // also takes the preview window with it.
          removeAgent(resolve(m.target))
        }
      }
    },
    [addAgent, edgeStyle, removeAgent]
  )

  // ── Dashboard ─────────────────────────────────────────────────────────────

  const [dashboardOpen, setDashboardOpen] = useState(false)

  /**
   * Put a mission's crew on the canvas and start them.
   *
   * Everything here is layout and lifecycle — the canvas is the only place that
   * knows about node positions, node data and spawning. What it hands back is
   * the ref→nodeId map, which is how main relates a terminal to the step it is
   * meant to be running.
   *
   * Deliberately does NOT type the briefs in. `studio-mission-start` does that,
   * through `enqueue`, which waits for each CLI to report idle — writing into an
   * agent that is still booting drops the prompt on the floor.
   */
  const runMission = useCallback(
    async (
      plan: MissionPlan,
      wires: MissionEdge[]
    ): Promise<{ ok: boolean; bindings?: { ref: string; nodeId: string }[]; error?: string }> => {
      const missing = plan.steps.find((s) => !agents.some((a) => a.kind === s.agentKind))
      if (missing) return { ok: false, error: `${missing.agentKind} is not installed.` }

      /**
       * Column per step, so the canvas reads left to right in the order the
       * work actually happens.
       *
       * A single pass is enough because a dependency can only ever name a step
       * defined earlier — the validator in main guarantees it, which is also
       * what makes cycles unrepresentable.
       */
      const depth = new Map<string, number>()
      for (const s of plan.steps) {
        depth.set(s.ref, s.dependsOn ? (depth.get(s.dependsOn) ?? 0) + 1 : 0)
      }

      const rect = wrapRef.current?.getBoundingClientRect()
      const origin = rf.screenToFlowPosition({
        x: (rect?.left ?? 0) + 90,
        y: (rect?.top ?? 0) + 110
      })

      const perColumn = new Map<number, number>()
      const refToNode = new Map<string, string>()
      const fresh: CanvasNode[] = []
      const toLaunch: { id: string; kind: string; runMode: string }[] = []

      for (const step of plan.steps) {
        const info = agents.find((a) => a.kind === step.agentKind)!
        const id = `n${++nodeSeq}_${Date.now()}_${step.ref}`
        const column = depth.get(step.ref) ?? 0
        const row = perColumn.get(column) ?? 0
        perColumn.set(column, row + 1)
        refToNode.set(step.ref, id)

        fresh.push({
          id,
          type: 'agent',
          position: {
            // Column pitch leaves room for a preview window to open beside the
            // rightmost agent without landing on top of the next column.
            x: origin.x + column * (AGENT_W + PREVIEW_GAP + 120),
            y: origin.y + row * (AGENT_H + 60)
          },
          data: makeData(id, step.agentKind, info, { title: step.title }),
          style: { width: AGENT_W, height: AGENT_H },
          dragHandle: '.studio-drag'
        })
        toLaunch.push({ id, kind: step.agentKind, runMode: info.defaultRunMode })
      }

      setNodes((ns) => [...ns, ...fresh])
      setEdges((es) => {
        let next = es
        for (const wire of wires) {
          const source = refToNode.get(wire.from)
          const target = refToNode.get(wire.to)
          if (!source || !target) continue
          next = addEdge(
            {
              id: `e_${source}_${target}_${Date.now()}`,
              source,
              target,
              label: wire.label,
              ...edgeStyle('handoff', false),
              data: { kind: 'handoff' }
            },
            next
          )
        }
        return next
      })

      // Frame the crew, so a mission of five agents is visible rather than
      // scattered off-screen.
      window.setTimeout(() => rf.fitView({ duration: 500, padding: 0.25 }), 120)

      /**
       * Started in parallel, because each spawn waits on a worktree and a hook
       * install; five agents started one after another would take most of a
       * minute before the first brief could go out.
       */
      const sessions = await Promise.all(
        toLaunch.map((t) => launch(t.id, t.kind, { runMode: t.runMode, cwd: rootDir }))
      )
      if (sessions.every((s) => s === null)) {
        return { ok: false, error: 'None of the agents could start. Check the setup cards.' }
      }

      // A step whose spawn failed is bound anyway: main marks it failed the
      // moment its terminal reports exit, which is more honest on the board
      // than the step silently never appearing.
      return {
        ok: true,
        bindings: plan.steps.map((s) => ({ ref: s.ref, nodeId: refToNode.get(s.ref)! }))
      }
    },
    [agents, edgeStyle, launch, makeData, rf, rootDir]
  )

  const runCommand = useCallback(async () => {
    const text = command.trim()
    if (!text || commandBusy) return
    setCommandBusy(true)
    setCommandNote(null)
    try {
      const res = await studio.command(text)
      if (!res.ok) {
        setCommandNote(res.error ?? 'That did not work.')
        return
      }
      const mutations = res.mutations ?? []
      if (!mutations.length) {
        setCommandNote(res.skipped?.[0] ?? 'Nothing on the canvas matched that.')
        return
      }
      applyMutations(mutations)
      setCommand('')
      setCommandNote(
        res.skipped?.length
          ? `${mutations.length} change(s) · ${res.skipped.length} skipped`
          : `${mutations.length} change(s)`
      )
    } catch (err) {
      setCommandNote(String((err as { message?: string })?.message || err))
    } finally {
      setCommandBusy(false)
    }
  }, [applyMutations, command, commandBusy])

  // WASD panning, matching the reference's hint.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const step = e.shiftKey ? 240 : 90
      const vp = rf.getViewport()
      const k = e.key.toLowerCase()
      if (k === 'w') rf.setViewport({ ...vp, y: vp.y + step }, { duration: 140 })
      else if (k === 's') rf.setViewport({ ...vp, y: vp.y - step }, { duration: 140 })
      else if (k === 'a') rf.setViewport({ ...vp, x: vp.x + step }, { duration: 140 })
      else if (k === 'd') rf.setViewport({ ...vp, x: vp.x - step }, { duration: 140 })
      else if (k === '0' && (e.ctrlKey || e.metaKey)) rf.fitView({ duration: 400, padding: 0.2 })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rf])

  /**
   * Leaving the canvas deliberately does NOT stop the agents.
   *
   * An agent mid-build is doing minutes of real work against a real repository.
   * Killing it because the user went to look at another tab, or backed out to
   * the workspace list, throws that away and leaves the repo half-edited — so
   * unmounting now tears down nothing at all:
   *
   *   • the ptys keep running in main, which is what `studio-sessions` exists to
   *     report and what the restore effect above re-adopts them through;
   *   • routing keeps running, because a cascade in flight is delivering into
   *     terminals that are still very much alive;
   *   • the xterm pool is left intact, so the terminals stay subscribed while
   *     detached and coming back is instant with full scroll history rather
   *     than a scrollback replay.
   *
   * Ending a run is an explicit act instead: the Stop-all control in the status
   * rail, or closing an individual window. `app.on('before-quit')` in main still
   * kills every session, so nothing outlives Brutus itself.
   */

  const [backdropId, setBackdropId] = useState(DEFAULT_BACKDROP)
  const backdrop = useMemo(() => backdropById(backdropId), [backdropId])

  // Adopt the saved backdrop once the workspace loads.
  useEffect(() => {
    if (workspace?.backdrop) setBackdropId(workspace.backdrop)
  }, [workspace?.backdrop])

  const pickBackdrop = useCallback(
    (id: string) => {
      setBackdropId(id)
      void studio.saveWorkspace({ id: workspaceId, backdrop: id })
    },
    [workspaceId]
  )

  const engineBroken = engine && !engine.ok

  const agentCount = useMemo(() => nodes.filter(isAgent).length, [nodes])
  /** Agents with a terminal actually attached — what "Stop all" would act on. */
  const runningCount = useMemo(
    () =>
      nodes.filter(
        (n) =>
          isAgent(n) &&
          Boolean(n.data.sessionId) &&
          n.data.status !== 'exited' &&
          n.data.status !== 'failed'
      ).length,
    [nodes]
  )

  /**
   * Stop every agent, and put their windows back into setup state.
   *
   * Main kills the ptys; the nodes have to be told, because a window still
   * showing a dead terminal is worse than one offering to start again.
   */
  const stopEverything = useCallback(async () => {
    // Read and tear down off the ref, so the updater below stays pure.
    const current = nodesRef.current

    /**
     * Scoped to this canvas's own nodes.
     *
     * Another workspace can have a crew running right now — that is the point of
     * agents outliving the view — and the button says "in this workspace". Main
     * cannot work out the scope itself, because a session knows its node and not
     * its workspace, so the canvas is what supplies it.
     */
    await studio.stopAll(
      workspaceId,
      current.filter(isAgent).map((n) => n.id)
    )
    for (const n of current) {
      if (isAgent(n) && n.data.sessionId) destroyTerminal(n.data.sessionId)
      if (isAgent(n)) studio.forgetPreview(n.id)
    }
    // Every dev server was a child of a terminal that just died, so the preview
    // windows go too rather than sitting there failing to connect.
    const previews = new Set(current.filter(isPreview).map((n) => n.id))

    setNodes((ns) =>
      ns
        .filter((n) => !previews.has(n.id))
        .map((n) =>
          isAgent(n) && n.data.sessionId
            ? { ...n, data: { ...n.data, sessionId: undefined, status: 'exited' as const } }
            : n
        )
    )
    setEdges((es) => es.filter((e) => !previews.has(e.source) && !previews.has(e.target)))
  }, [workspaceId])

  return (
    <LiveNodesContext.Provider value={liveNodes}>
      <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
        {/* ── Scenery ──
            Four layers, each isolated onto its own compositor layer: a base
            gradient, slowly drifting colour blooms, fine grain so it reads as a
            surface rather than flat CSS, and a vignette so the floating windows
            have something to sit against. None of it repaints while you pan. */}
        <div className="studio-layer" style={{ background: backdrop.base }} />
        <div className="studio-layer studio-bloom" style={{ background: backdrop.bloom }} />
        <div className="studio-layer studio-grain" />
        <div className="studio-layer studio-vignette" />

        <ReactFlow
          nodes={nodes}
          edges={styledEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          /* Tethers have nothing to configure — opening the routing inspector on
             one would offer to change a handoff that does not exist. */
          onEdgeClick={(_e, edge) => {
            if (!isPreviewEdge(edge)) setInspected(edge.id)
          }}
          onPaneClick={() => setInspected(null)}
          nodeTypes={nodeTypes}
          minZoom={0.2}
          maxZoom={2}
          panOnScroll
          selectionOnDrag
          snapToGrid={snap}
          snapGrid={[16, 16]}
          proOptions={{ hideAttribution: true }}
          defaultViewport={workspace?.viewport ?? { x: 0, y: 0, zoom: 0.9 }}
          className="!bg-transparent"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color={backdrop.grid} />
          <MiniMap
            pannable
            zoomable
            className="!bottom-16 !right-4 !h-28 !w-44 !overflow-hidden !rounded-xl !border !border-white/10 !bg-black/50 !backdrop-blur-2xl"
            maskColor="rgba(0,0,0,0.55)"
            /* Mounted terminals read red; culled ones stay grey, so the minimap
               doubles as a view of what is actually live. */
            nodeColor={(n) => (liveNodes.has(n.id) ? '#ef4444' : '#3f3f46')}
            nodeStrokeColor={(n) => (liveNodes.has(n.id) ? '#fca5a5' : 'transparent')}
            nodeBorderRadius={6}
          />
        </ReactFlow>

        {/* ── Top-left status rail ──
            One glass bar rather than three floating pills: the three controls
            belong together, and a single surface stops them competing with the
            agent windows for attention. */}
        <div className="studio-glass pointer-events-auto absolute left-4 top-4 z-20 flex items-center gap-1 rounded-2xl px-1.5 py-1.5">
          {/* Which workspace this is, and the way back to the rest of them. */}
          <button
            onClick={onLeave}
            title="Back to workspaces"
            className="flex cursor-pointer items-center gap-1.5 rounded-xl px-2 py-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
          >
            <RiArrowLeftLine size={13} />
            <span className="max-w-[160px] truncate text-[11px] font-semibold text-zinc-200">
              {workspace?.name ?? 'Workspace'}
            </span>
          </button>

          <span className="h-4 w-px bg-white/10" />

          {/* The way in to a whole crew: one request, several agents, tracked. */}
          <button
            data-tour="studio.dashboard"
            onClick={() => setDashboardOpen((v) => !v)}
            title="Dashboard — describe a job and Brutus assembles the crew"
            className={`flex cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[10px] font-semibold transition-colors ${
              dashboardOpen
                ? 'bg-red-500/15 text-red-400'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
            }`}
          >
            <RiDashboardLine size={11} />
            Dashboard
          </button>

          <span className="h-4 w-px bg-white/10" />

          <button
            data-tour="studio.autoroute"
            onClick={() => setAutoRoute((v) => !v)}
            title="Whether finished work flows along the strings automatically"
            className={`flex cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[10px] font-semibold transition-colors ${
              autoRoute
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
            }`}
          >
            <RiFlashlightLine size={11} />
            Auto-route {autoRoute ? 'on' : 'off'}
          </button>

          <span className="h-4 w-px bg-white/10" />

          <span
            data-tour="studio.count"
            className="px-2 text-[10px] font-mono tabular-nums text-zinc-400"
          >
            {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
            {runningCount > 0 && (
              <span className="text-emerald-400/90"> · {runningCount} running</span>
            )}
          </span>

          {/* Ending a run is now an explicit act, because leaving the canvas no
              longer stops anything. Only offered when there is something to
              stop, so it cannot be mistaken for a general reset. */}
          {runningCount > 0 && (
            <>
              <span className="h-4 w-px bg-white/10" />
              <button
                onClick={() => void stopEverything()}
                title="Stop every running agent in this workspace"
                className="flex cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[10px] font-semibold text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-400"
              >
                <RiStopCircleLine size={11} />
                Stop all
              </button>
            </>
          )}

          <span className="h-4 w-px bg-white/10" />

          {/* How much Brutus decides on its own. Cycles guarded → strict →
            autonomous; the catastrophic list is blocked in all three. */}
          <button
            data-tour="studio.autonomy"
            onClick={() => {
              const next: Autonomy =
                autonomy === 'guarded' ? 'strict' : autonomy === 'strict' ? 'autonomous' : 'guarded'
              setAutonomy(next)
              void studio.autonomy(next)
            }}
            title="What Brutus decides without asking you"
            className={`flex cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[10px] font-semibold capitalize transition-colors ${
              autonomy === 'autonomous'
                ? 'bg-red-500/15 text-red-400'
                : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                autonomy === 'autonomous'
                  ? 'bg-red-500'
                  : autonomy === 'strict'
                    ? 'bg-emerald-500'
                    : 'bg-amber-400'
              }`}
            />
            {autonomy}
          </button>
        </div>

        {/* ── Activity ──
            Right-hand slide-over. Sits above the canvas rather than inside it,
            so panning and zooming never move it. */}
        <div className="pointer-events-none absolute bottom-24 right-4 top-16 z-30 flex">
          <AnimatePresence>
            {activityOpen && <ActivityPanel onClose={() => setActivityOpen(false)} />}
          </AnimatePresence>
        </div>

        {/* ── Dashboard ──
            Centred over the canvas rather than docked to a side: while a
            mission is being described it is the only thing that matters, and
            while one is running it is the summary of everything else on
            screen. */}
        <div className="pointer-events-none absolute inset-x-0 top-16 z-40 flex justify-center px-4">
          <AnimatePresence>
            {dashboardOpen && (
              <MissionDashboard
                onRun={runMission}
                workspaceId={workspaceId}
                onClose={() => setDashboardOpen(false)}
              />
            )}
          </AnimatePresence>
        </div>

        {/* ── Edge inspector ── */}
        <div className="absolute right-4 top-16 z-30">
          <AnimatePresence>
            {inspectedEdge && (
              <EdgeInspector
                key={inspectedEdge.id}
                fromTitle={titleOf(inspectedEdge.source)}
                toTitle={titleOf(inspectedEdge.target)}
                value={{
                  kind: ((inspectedEdge.data as { kind?: EdgeKind })?.kind ??
                    'handoff') as EdgeKind,
                  label: typeof inspectedEdge.label === 'string' ? inspectedEdge.label : '',
                  maxIterations:
                    (inspectedEdge.data as { maxIterations?: number })?.maxIterations ?? 3
                }}
                onChange={(patch) => patchEdge(inspectedEdge.id, patch)}
                onDelete={() => {
                  setEdges((es) => es.filter((e) => e.id !== inspectedEdge.id))
                  setInspected(null)
                }}
                onClose={() => setInspected(null)}
              />
            )}
          </AnimatePresence>
        </div>

        {/* ── What Brutus just passed along ── */}
        <AnimatePresence>
          {lastRouted && activeEdges.has(lastRouted.edgeId) && (
            <motion.div
              key={lastRouted.edgeId + lastRouted.preview}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="pointer-events-none absolute bottom-24 left-1/2 z-30 w-[min(560px,calc(100%-2rem))] -translate-x-1/2 rounded-xl border border-white/10 bg-zinc-950/90 px-3 py-2 backdrop-blur-xl"
            >
              <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-red-400/90">
                <RiFlashlightLine size={10} /> Routed
              </div>
              <p className="mt-1 truncate text-[11px] text-zinc-300">{lastRouted.preview}</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Permission request ── */}
        <div className="pointer-events-none absolute left-1/2 top-16 z-40 -translate-x-1/2">
          <AnimatePresence>
            {approval && (
              <div className="pointer-events-auto">
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  onAnswer={(granted) => void studio.approve(approval.id, granted)}
                />
              </div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Engine unavailable ── */}
        {engineBroken && (
          <div className="absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 backdrop-blur-xl">
            <RiAlertLine className="text-red-400" size={13} />
            <span className="text-[11px] text-red-300">
              Terminal engine unavailable: {engine?.error}
            </span>
          </div>
        )}

        {/* ── Empty state ──
            The first thing anyone sees, so it says what this room is for
            rather than just noting that it is empty. */}
        {!nodes.length && !engineBroken && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 pb-24"
          >
            <div className="relative flex h-16 w-16 items-center justify-center">
              <span className="absolute inset-0 rounded-2xl bg-red-500/10 blur-xl" />
              <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl">
                <RiTerminalBoxLine size={24} className="text-red-400/80" />
              </div>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <p className="text-[15px] font-semibold tracking-tight text-zinc-200">
                Add an agent, or just ask.
              </p>
              <p className="max-w-[400px] text-center text-[11.5px] leading-relaxed text-zinc-500">
                Your real Claude Code, Codex and Gemini CLIs run here as live terminals. Connect
                them and Brutus routes the work between them.
              </p>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-600">
              <kbd className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono">
                WASD
              </kbd>
              <span>to pan</span>
              <span className="text-zinc-700">·</span>
              <kbd className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono">
                Ctrl+0
              </kbd>
              <span>to fit</span>
            </div>
          </motion.div>
        )}

        {/* ── Dock ── */}
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-20 -translate-x-1/2">
          <CanvasDock items={dockItems} onPick={pickFromDock} />
        </div>

        {/* ── Command bar ── */}
        <div className="absolute bottom-6 left-1/2 z-20 w-[min(680px,calc(100%-2rem))] -translate-x-1/2">
          <div className="studio-glass flex items-center gap-2 rounded-2xl px-3 py-2.5 transition-shadow focus-within:shadow-[0_0_0_1px_rgba(var(--brutus-accent-c),0.25),0_18px_50px_rgba(0,0,0,0.6)]">
            <button
              onClick={() => setPickerOpen((v) => !v)}
              title="Add an agent"
              className="cursor-pointer rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-red-400"
            >
              <RiAddLine size={16} />
            </button>
            <input
              data-tour="studio.command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void runCommand()
                }
              }}
              disabled={commandBusy}
              placeholder="Try “add a Claude Code agent and a Codex agent, then connect them”"
              className="flex-1 bg-transparent text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 disabled:opacity-50"
            />
            <button
              onClick={() => void runCommand()}
              disabled={!command.trim() || commandBusy}
              title="Edit the canvas in plain English"
              className="cursor-pointer rounded-lg bg-red-500/15 p-1.5 text-red-400 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {commandBusy ? (
                <RiLoader4Line size={14} className="animate-spin" />
              ) : (
                <RiSendPlane2Fill size={14} />
              )}
            </button>
          </div>

          {commandNote && <p className="mt-1.5 px-2 text-[10px] text-zinc-500">{commandNote}</p>}

          {pickerOpen && (
            <AgentPicker
              agents={orderedAgents}
              onPick={addAgent}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>

        {/* ── Bottom-right cluster ── */}
        <div className="absolute bottom-6 right-4 z-20 flex items-center gap-1.5">
          <button
            data-tour="studio.activity"
            onClick={() => setActivityOpen((v) => !v)}
            title="Activity — what Studio is doing"
            className={`cursor-pointer rounded-lg border p-1.5 backdrop-blur-xl transition-colors ${
              activityOpen
                ? 'border-red-500/40 bg-red-500/10 text-red-400'
                : 'border-white/10 bg-zinc-950/80 text-zinc-500 hover:text-zinc-200'
            }`}
          >
            <RiPulseLine size={12} />
          </button>
          <BackdropPicker value={backdropId} onPick={pickBackdrop} />
          <button
            onClick={() => setSnap((v) => !v)}
            title="Snap to grid"
            className={`cursor-pointer rounded-lg border p-1.5 backdrop-blur-xl transition-colors ${
              snap
                ? 'border-red-500/30 bg-red-500/10 text-red-400'
                : 'border-white/10 bg-zinc-950/80 text-zinc-500 hover:text-zinc-200'
            }`}
          >
            <RiGridLine size={12} />
          </button>
          <button
            onClick={() => rf.fitView({ duration: 400, padding: 0.2 })}
            title="Fit view (Ctrl+0)"
            className="cursor-pointer rounded-lg border border-white/10 bg-zinc-950/80 p-1.5 text-zinc-500 backdrop-blur-xl transition-colors hover:text-zinc-200"
          >
            <RiFocus3Line size={12} />
          </button>
          <ZoomReadout />
        </div>
      </div>
    </LiveNodesContext.Provider>
  )
}

/** Live zoom percentage, matching the reference's corner readout. */
function ZoomReadout(): ReactElement {
  const rf = useReactFlow()
  const [zoom, setZoom] = useState(90)

  useEffect(() => {
    const id = setInterval(() => setZoom(Math.round(rf.getViewport().zoom * 100)), 200)
    return () => clearInterval(id)
  }, [rf])

  return (
    <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-950/80 px-1 backdrop-blur-xl">
      <button
        onClick={() => rf.zoomOut({ duration: 160 })}
        className="cursor-pointer px-1.5 py-1 text-zinc-500 transition-colors hover:text-zinc-200"
      >
        −
      </button>
      <span className="w-9 text-center text-[10px] font-mono tabular-nums text-zinc-400">
        {zoom}%
      </span>
      <button
        onClick={() => rf.zoomIn({ duration: 160 })}
        className="cursor-pointer px-1.5 py-1 text-zinc-500 transition-colors hover:text-zinc-200"
      >
        +
      </button>
    </div>
  )
}

/**
 * Studio is two screens: the launcher, and one open workspace.
 *
 * The canvas is keyed by workspace id so switching workspaces remounts it
 * cleanly — no chance of one workspace's nodes bleeding into another's, and the
 * pty pool is torn down on unmount as it already was.
 */
export default function StudioView(): ReactElement {
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="h-full w-full"
    >
      {/* Scoped so a canvas crash cannot reach the rest of Brutus. Resetting
          returns to the launcher, which is a state we know is good. */}
      <StudioErrorBoundary label="The canvas" onReset={() => setOpenId(null)}>
        {openId ? (
          <ReactFlowProvider key={openId}>
            <StudioCanvas workspaceId={openId} onLeave={() => setOpenId(null)} />
          </ReactFlowProvider>
        ) : (
          <StudioLauncher onOpen={setOpenId} />
        )}
      </StudioErrorBoundary>
    </motion.div>
  )
}
