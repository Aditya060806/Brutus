import { type ReactNode, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { RiCloseLine } from 'react-icons/ri'
import Button from './Button'
import { cn } from './cn'

export interface ModalShellProps {
  /** Fired by the X, Esc, and a click on the backdrop. */
  onClose: () => void
  children: ReactNode
  /** Id of the element that names the dialog. Falls back to `label`. */
  labelledBy?: string
  /** Accessible name when no visible heading exists to point at. */
  label?: string
  /** Sizing for the card. `full` is the settings-style near-fullscreen sheet. */
  size?: 'sm' | 'md' | 'lg' | 'full'
  /** Float the close button just outside the top-right corner (settings style). */
  closeOutside?: boolean
  /** Hide the built-in close button when the content draws its own. */
  hideClose?: boolean
  className?: string
}

const SIZES: Record<NonNullable<ModalShellProps['size']>, string> = {
  sm: 'w-full max-w-md',
  md: 'w-full max-w-2xl',
  lg: 'w-full max-w-4xl',
  full: 'h-[82vh] w-full max-w-6xl'
}

/**
 * Every dialog in Brutus goes through here.
 *
 * ── WHAT THIS OWNS, SO NOTHING ELSE HAS TO ─────────────────────────────────
 * Esc to close, backdrop-click to close, focus moved into the dialog on open
 * and returned to the trigger on close, a Tab focus trap, and body scroll lock.
 * Before this existed each overlay reimplemented some subset of that list —
 * usually the backdrop click and nothing else, which is why Esc did nothing and
 * focus escaped behind the scrim.
 *
 * ── WHY IT PORTALS INTO `#root` AND NOT `document.body` ────────────────────
 * `SystemErrorBoundary` wraps `#root`. A dialog portalled to `body` renders
 * outside it, so a render error inside a modal would escape the boundary and
 * blank the whole app instead of being caught. Falls back to `body` only if
 * `#root` is somehow absent.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

const ModalShell = ({
  onClose,
  children,
  labelledBy,
  label,
  size = 'md',
  closeOutside = false,
  hideClose = false,
  className
}: ModalShellProps): React.JSX.Element | null => {
  const dialogRef = useRef<HTMLDivElement>(null)
  // Held in a ref so the cleanup restores the element focused at OPEN time,
  // not whatever happened to be focused when the effect re-ran.
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()

    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = overflow
      // Guard the call: the trigger may have unmounted while the modal was open
      // (closing a workspace from inside its own settings dialog, say).
      previousFocus.current?.focus?.()
    }
  }, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (!nodes || nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement

      // Wrap at both ends so Tab can never land on the app behind the scrim.
      if (event.shiftKey && (active === first || active === dialogRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [onClose]
  )

  const target = document.getElementById('root') ?? document.body

  return createPortal(
    <div
      className={cn(
        // ── z-9800, chosen rather than guessed ──
        // This app's overlays run from z-9050 to z-9999 with no shared scale.
        // A dialog has to clear the PERSISTENT chrome — the floating launchers
        // (9065), the chat panel (9070) and the widget lightboxes (9650) — or
        // they punch through the scrim and stay clickable behind it. It stays
        // below the 9999 tier (terminal overlay, gallery lightbox), which are
        // full-screen takeover modes rather than chrome.
        'fixed inset-0 z-9800 flex items-center justify-center',
        'bg-black/70 backdrop-blur-sm',
        'animate-in fade-in'
      )}
      onMouseDown={(event) => {
        // mousedown, not click: a click fires on the element the button is
        // RELEASED over, so selecting text inside the dialog and releasing on
        // the backdrop would close it mid-selection.
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={cn('relative mx-4', SIZES[size])} onMouseDown={(e) => e.stopPropagation()}>
        {!hideClose && closeOutside && (
          <Button
            variant="secondary"
            tone="default"
            size="sm"
            iconOnly
            aria-label="Close"
            onClick={onClose}
            className="brutus-close absolute bottom-full right-0 mb-2 rounded-full"
          >
            <RiCloseLine size={16} />
          </Button>
        )}
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : (label ?? 'Dialog')}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={cn(
            'flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl',
            'border border-line bg-elevated shadow-xl',
            'animate-in fade-in zoom-in focus:outline-none',
            size === 'full' && 'h-full',
            className
          )}
        >
          {!hideClose && !closeOutside && (
            <Button
              variant="tertiary"
              size="sm"
              iconOnly
              aria-label="Close"
              onClick={onClose}
              className="brutus-close absolute right-3 top-3 z-10 rounded-full"
            >
              <RiCloseLine size={16} />
            </Button>
          )}
          {children}
        </div>
      </div>
    </div>,
    target
  )
}

export default ModalShell
