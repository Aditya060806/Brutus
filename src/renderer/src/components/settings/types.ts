/**
 * Shared types for the settings surface. Pure TypeScript — see the note in
 * `settingsRegistry.ts` about why that matters.
 */

export interface PanelProps {
  /** True while the voice link is live. Several controls lock while it is. */
  isSystemActive: boolean
  /** Jump to another panel — used by cross-references between panels. */
  navigate: (id: string) => void
  /** Close the settings surface entirely (sign-out, "take me to the canvas"). */
  close: () => void
}

/** Inline feedback shown in place of the `alert()` calls this replaced. */
export type StatusTone = 'success' | 'error' | 'info'

export interface StatusMessage {
  tone: StatusTone
  text: string
}
