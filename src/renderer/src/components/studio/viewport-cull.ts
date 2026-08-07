/**
 * Which nodes are near enough to the viewport to keep a live terminal.
 *
 * Pure and dependency-free so the arithmetic can be tested directly — getting
 * the zoom conversion wrong is easy and the symptom is subtle: terminals that
 * blank out while still clearly on screen, or every terminal staying mounted
 * and the canvas quietly dropping frames.
 */

export interface CullBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface CullViewport {
  /** React Flow's pan offset, in screen pixels. */
  x: number
  y: number
  zoom: number
  /** Size of the canvas element, in screen pixels. */
  width: number
  height: number
}

/**
 * Headroom around the viewport, in flow units.
 *
 * Deliberately generous. Tearing a terminal down the moment it touches the edge
 * makes a slow pan flicker, and remounting one costs more than leaving it alive
 * a little too long.
 */
export const CULL_MARGIN = 500

export function visibleNodeIds(
  nodes: CullBox[],
  viewport: CullViewport,
  margin = CULL_MARGIN
): Set<string> {
  const zoom = viewport.zoom > 0 ? viewport.zoom : 1
  // Screen origin → flow coordinates, then grow by the margin on every side.
  const left = -viewport.x / zoom - margin
  const top = -viewport.y / zoom - margin
  const right = left + viewport.width / zoom + margin * 2
  const bottom = top + viewport.height / zoom + margin * 2

  const visible = new Set<string>()
  for (const n of nodes) {
    if (n.x + n.width >= left && n.x <= right && n.y + n.height >= top && n.y <= bottom) {
      visible.add(n.id)
    }
  }
  return visible
}

/**
 * Do two sets hold the same ids?
 *
 * Used to avoid publishing a new Set identity when nothing changed — a fresh
 * Set would re-render every node on the canvas, which is exactly the cost this
 * whole mechanism exists to avoid.
 */
export function sameIds(a: Set<string>, b: Set<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}
