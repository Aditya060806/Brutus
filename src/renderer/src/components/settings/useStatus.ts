import { useCallback, useEffect, useRef, useState } from 'react'
import type { StatusMessage, StatusTone } from './types'

/**
 * Transient inline feedback for a panel.
 *
 * Replaces the `alert()` calls the old settings view used. Each panel gets one
 * of these rather than sharing a global toast, because the message belongs next
 * to the control that produced it — "Saved" under the Save button says which
 * save, where a corner toast does not.
 *
 * The timer is cleared on unmount as well as on the next message. Without that,
 * closing the settings modal inside the 4s window fires a `setState` on an
 * unmounted component — which React 19 tolerates silently but which leaks the
 * timer, and there are thirteen panels able to do it.
 */
export function useStatus(clearAfterMs = 4000): {
  status: StatusMessage | null
  setStatus: (tone: StatusTone, text: string) => void
  clearStatus: () => void
} {
  const [status, setStatusState] = useState<StatusMessage | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = (): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => clearTimer, [])

  const setStatus = useCallback(
    (tone: StatusTone, text: string): void => {
      clearTimer()
      setStatusState({ tone, text })
      // Errors stay until the next action: they usually name something the user
      // has to go and fix, and a message that vanishes mid-read is worse than
      // no message.
      if (tone !== 'error') {
        timer.current = setTimeout(() => setStatusState(null), clearAfterMs)
      }
    },
    [clearAfterMs]
  )

  const clearStatus = useCallback((): void => {
    clearTimer()
    setStatusState(null)
  }, [])

  return { status, setStatus, clearStatus }
}
