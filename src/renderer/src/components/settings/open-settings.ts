/**
 * The global "open settings" signal.
 *
 * Lives in its own module rather than beside `SettingsModal` so that file
 * exports only its component — React Fast Refresh cannot preserve state across
 * edits in a module that mixes component and non-component exports, and eslint
 * flags it for exactly that reason.
 *
 * A window event rather than a prop or a context: the settings modal is mounted
 * once at the shell level, and callers are scattered (the top-bar gear, the
 * account chip, a keyboard shortcut, and error states that suggest checking a
 * key). Threading a callback to all of them would mean touching every view in
 * between. This is the same mechanism the shell already uses for its other
 * global launchers — `open-deck-studio`, `open-knowledge-graph`.
 */
export const OPEN_SETTINGS_EVENT = 'brutus-open-settings'

/** Open the settings modal from anywhere in the renderer. */
export function openSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT))
}
