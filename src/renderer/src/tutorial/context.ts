import { createContext, useContext } from 'react'
import type { Tour } from './types'

/**
 * The tutorial context, split out from the provider that fills it.
 *
 * Not a stylistic split: a file that exports both a component and a hook breaks
 * React Fast Refresh, so editing a tour during development would do a full
 * reload instead of a hot swap. Keeping the non-component exports here is what
 * makes the provider file refreshable.
 */
export interface TutorialApi {
  /** Start a specific tour by id. */
  start: (tourId: string) => void
  /** The nav tab on screen. Set by the app shell. */
  setFeature: (feature: string) => void
  /**
   * A deeper screen within that feature, or null at its top level.
   *
   * Set by the view itself — Studio reports `canvas` once a workspace is open.
   * Kept separate from the feature rather than folded into one string because
   * React runs a child's effects BEFORE its parent's: a single setter would have
   * the shell's `STUDIO` overwrite the canvas's `STUDIO/canvas` on every render,
   * and the deep tour would never be found.
   */
  setSubScope: (sub: string | null) => void
  /** The tour for whatever is on screen now. Drives the `?` button. */
  current: Tour | null
  running: boolean
}

export const TutorialContext = createContext<TutorialApi>({
  start: () => {},
  setFeature: () => {},
  setSubScope: () => {},
  current: null,
  running: false
})

export function useTutorial(): TutorialApi {
  return useContext(TutorialContext)
}
