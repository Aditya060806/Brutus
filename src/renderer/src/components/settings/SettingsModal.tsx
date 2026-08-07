import { useEffect, useId, useState } from 'react'
import { ModalShell } from '@renderer/components/ui'
import SettingsSurface from './SettingsSurface'
import { OPEN_SETTINGS_EVENT } from './open-settings'

interface SettingsModalProps {
  isSystemActive: boolean
}

/**
 * The desktop settings host.
 *
 * Mounted once, near the root, and self-opening: it listens for the
 * `brutus-open-settings` window event and for `Ctrl+,`. That means nothing has
 * to thread an `onOpenSettings` prop down through the shell — the top bar, the
 * dashboard and any future surface all call `openSettings()` and are done.
 *
 * The window event is the same pattern the app already uses for its other
 * global launchers (`open-deck-studio`, `open-knowledge-graph`), so this is
 * consistent with the existing shell rather than a second mechanism.
 */
const SettingsModal = ({ isSystemActive }: SettingsModalProps): React.JSX.Element | null => {
  const [open, setOpen] = useState(false)
  const headingId = useId()

  useEffect(() => {
    const onOpen = (): void => setOpen(true)
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen)

    const onKey = (event: KeyboardEvent): void => {
      // Ctrl+, is the platform convention for preferences. Esc is handled by
      // ModalShell, which owns focus while the dialog is up.
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  if (!open) return null

  return (
    <ModalShell
      size="full"
      closeOutside
      labelledBy={headingId}
      onClose={() => setOpen(false)}
      className="p-0"
    >
      <SettingsSurface
        isSystemActive={isSystemActive}
        headingId={headingId}
        onClose={() => setOpen(false)}
      />
    </ModalShell>
  )
}

export default SettingsModal
