import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Glyph rendered inside the left edge. Padding adjusts automatically. */
  leadingIcon?: ReactNode
  /** Control rendered inside the right edge — a reveal toggle, a unit, a clear. */
  trailingSlot?: ReactNode
  /** Renders the error state and wires `aria-invalid`. */
  invalid?: boolean
  /** Full-width by default; set false to size to a grid cell. */
  block?: boolean
}

export const INPUT_BASE =
  'h-9 w-full rounded-lg border border-line bg-surface-muted px-3 text-sm text-content ' +
  'placeholder:text-content-faint transition-colors duration-150 ' +
  'hover:border-line-strong ' +
  'focus:border-primary-500/60 focus:outline-none focus:ring-2 focus:ring-primary-500/20 ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

/**
 * A single-line text field.
 *
 * The icon slots are rendered as absolutely-positioned siblings rather than
 * flex children, so the input keeps its own hit area and native text selection
 * across the full width — wrapping it in a flex row makes the padding look
 * right but leaves dead zones where clicking does not focus the field.
 */
const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const { leadingIcon, trailingSlot, invalid, block = true, className, ...rest } = props

  return (
    <div className={cn('relative', block ? 'w-full' : 'inline-block')}>
      {leadingIcon && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-faint"
        >
          {leadingIcon}
        </span>
      )}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          INPUT_BASE,
          leadingIcon && 'pl-9',
          trailingSlot && 'pr-10',
          invalid && 'border-coral-500/60 focus:border-coral-500 focus:ring-coral-500/20',
          className
        )}
        {...rest}
      />
      {trailingSlot && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-content-faint">
          {trailingSlot}
        </span>
      )}
    </div>
  )
})

export default Input
