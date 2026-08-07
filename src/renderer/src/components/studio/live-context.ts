import { createContext, useContext } from 'react'

/**
 * Which nodes currently deserve a live terminal.
 *
 * An xterm instance is not cheap — it owns a canvas, a parser and a 5000-line
 * buffer — so a canvas of fifteen agents cannot afford one per node whether you
 * are looking at it or not. Only nodes near the viewport keep a renderer; the
 * rest tear it down.
 *
 * Nothing is lost by doing that. The process lives in the main process and
 * keeps running, and `PtyManager` keeps a bounded scrollback ring per session,
 * so a node scrolled back into view replays its history instead of restarting
 * or showing a blank screen.
 *
 * This is a context rather than a field on the node's data because visibility
 * changes on every pan. Writing it into the nodes array would rewrite the whole
 * graph — and re-run React Flow's diff — several times a second.
 */
export const LiveNodesContext = createContext<Set<string> | null>(null)

/**
 * Should this node mount a terminal?
 *
 * Defaults to true when there is no provider, so a node rendered outside the
 * canvas (a test, a future detail view) behaves exactly as it did before
 * virtualisation existed.
 */
export function useIsLive(nodeId: string): boolean {
  const live = useContext(LiveNodesContext)
  return live ? live.has(nodeId) : true
}
