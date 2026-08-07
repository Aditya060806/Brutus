import { type ReactNode, useState } from 'react'
import { cn } from './cn'

export interface TooltipProps {
  label: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: ReactNode
  className?: string
}

const SIDES: Record<NonNullable<TooltipProps['side']>, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2'
}

/**
 * A hover/focus label.
 *
 * Shown on focus as well as hover, so it is reachable by keyboard — and the
 * trigger is wrapped in a `<span tabIndex={-1}>`-free plain span, because the
 * child is expected to be focusable in its own right (a button or a link). The
 * tooltip is `aria-hidden` and the child keeps its own accessible name: a
 * tooltip that is the *only* name for a control is a bug, not a feature.
 */
const Tooltip = ({ label, side = 'top', children, className }: TooltipProps): React.JSX.Element => {
  const [open, setOpen] = useState(false)

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          aria-hidden="true"
          className={cn(
            // Above the modal layer (9800): a tooltip on a control inside a
            // dialog must not render behind the dialog that contains it.
            'pointer-events-none absolute z-9900 whitespace-nowrap rounded-md',
            'border border-line bg-elevated px-2 py-1 text-[11px] text-content-secondary',
            'shadow-lg animate-in fade-in',
            SIDES[side]
          )}
        >
          {label}
        </span>
      )}
    </span>
  )
}

export default Tooltip
