import { useCallback, useEffect, useState } from 'react'
import { PREF_KEYS, readPref, writePref } from '@renderer/services/preferences'
import StudioErrorBoundary from '@renderer/components/studio/StudioErrorBoundary'
import SettingsSidebar from './SettingsSidebar'
import { SETTINGS_PANELS } from './panels'
import { getEntry, resolveEntryId } from './settingsRegistry'

export interface SettingsSurfaceProps {
  isSystemActive: boolean
  /** Close the host (modal or page). */
  onClose: () => void
  /** Id for the panel heading, so the dialog can be `aria-labelledby` it. */
  headingId?: string
}

/**
 * The two-pane settings body: sidebar on the left, active panel on the right.
 *
 * Hosted by both the desktop modal and the full-page route, which is why it
 * owns no chrome of its own — no backdrop, no close button, no title bar. Both
 * hosts render the same registry, so a panel can never exist in one and not the
 * other.
 *
 * ── WHY EACH PANEL IS WRAPPED IN AN ERROR BOUNDARY ─────────────────────────
 * Panels talk to thirteen different IPC surfaces, several of which probe
 * external binaries and network endpoints. A throw in one of them would
 * otherwise unmount the whole settings tree — and, since Settings can be opened
 * over any view, take that view with it. The boundary is keyed on the entry id,
 * so navigating away from a panel that crashed gives a clean remount rather
 * than a permanently broken pane.
 */
const SettingsSurface = ({
  isSystemActive,
  onClose,
  headingId
}: SettingsSurfaceProps): React.JSX.Element => {
  // Restoring the last panel makes the modal feel like a place you return to
  // rather than one that resets every time. A stale or renamed id resolves to
  // the default instead of rendering nothing.
  const [activeId, setActiveId] = useState(() =>
    resolveEntryId(readPref(PREF_KEYS.lastSettingsPanel))
  )

  useEffect(() => {
    writePref(PREF_KEYS.lastSettingsPanel, activeId)
  }, [activeId])

  const navigate = useCallback((id: string): void => {
    setActiveId(resolveEntryId(id))
  }, [])

  const entry = getEntry(activeId)
  const Panel = SETTINGS_PANELS[resolveEntryId(activeId)]

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Always present, never hidden at a breakpoint: this window can be
          resized small, and a hidden sidebar would leave every other panel
          unreachable with no other way in. It narrows instead. */}
      <aside className="w-44 shrink-0 md:w-56">
        <SettingsSidebar activeId={activeId} onSelect={navigate} />
      </aside>

      <div className="scrollbar-small min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-7 sm:px-8">
          {/* A hidden heading gives the dialog its accessible name without
              duplicating the visible title each panel already draws. */}
          {headingId && (
            <span id={headingId} className="sr-only">
              {entry ? `Settings — ${entry.title}` : 'Settings'}
            </span>
          )}
          <StudioErrorBoundary
            key={activeId}
            label={entry?.title ?? 'Settings'}
            note="The rest of Brutus is unaffected. Pick another section in the sidebar, or try again."
          >
            <Panel isSystemActive={isSystemActive} navigate={navigate} close={onClose} />
          </StudioErrorBoundary>
        </div>
      </div>
    </div>
  )
}

export default SettingsSurface
