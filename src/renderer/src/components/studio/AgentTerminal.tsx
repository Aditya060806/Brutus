import { useEffect, useRef, type ReactElement } from 'react'
import { attachTerminal, detachTerminal, fitTerminal, focusTerminal } from './terminal-pool'

/**
 * Where a session's terminal is currently shown.
 *
 * This component owns no xterm state. The Terminal lives in `terminal-pool`
 * for the whole life of the pty session, and mounting simply moves its element
 * into this container; unmounting moves it back out.
 *
 * That indirection exists for a concrete reason: disposing an xterm races with
 * the animation frames it has already queued, and it crashed constantly once
 * virtualisation started unmounting terminals on every pan. See the comment at
 * the top of `terminal-pool.ts`. Not disposing is what makes it correct.
 *
 * The practical win is that culling a node is now free and reversible — scroll
 * position, selection and history are all still there when it comes back.
 */
export default function AgentTerminal({
  sessionId,
  focusKey
}: {
  sessionId: string
  /** Bump to pull keyboard focus into this terminal. */
  focusKey?: number
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = hostRef.current
    if (!container) return

    attachTerminal(sessionId, container)

    // Fit once layout has settled, then whenever the window changes shape.
    const initial = setTimeout(() => fitTerminal(sessionId), 60)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleFit = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => fitTerminal(sessionId), 120)
    }

    const ro = new ResizeObserver(scheduleFit)
    ro.observe(container)

    return () => {
      clearTimeout(initial)
      if (resizeTimer) clearTimeout(resizeTimer)
      ro.disconnect()
      // Leave the terminal alive; only stop showing it here.
      detachTerminal(sessionId)
    }
  }, [sessionId])

  useEffect(() => {
    if (focusKey === undefined) return
    focusTerminal(sessionId)
  }, [focusKey, sessionId])

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />
}
