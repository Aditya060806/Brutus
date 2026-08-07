import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react'
import { cn } from './cn'

/**
 * The one button in Brutus. Hierarchy and intent are separate axes:
 *
 * - **variant** — visual weight:
 *   - `primary`   the main action on a surface (Save, Connect, Create)
 *   - `secondary` an equal alternative (Cancel, Back, Import)
 *   - `tertiary`  low emphasis / text-style (Skip, inline actions)
 * - **tone** — semantic intent, layered onto any variant:
 *   - `default`   the accent palette
 *   - `caution`   amber — reversible but consequential (Log out, Clear cache)
 *   - `danger`    coral — genuinely destructive (Delete, Reset, Wipe)
 *
 * ── WHY DESTRUCTIVE ACTIONS SHOULD NOT BE `primary` ────────────────────────
 * Brutus's accent IS red, so a solid red "danger" button is nearly
 * indistinguishable from a solid red "confirm" button — the two most important
 * things to tell apart in the app. Use `variant="secondary" tone="danger"`
 * (outlined red on transparent) for destructive actions; it reads clearly
 * against a solid accent primary and matches how the settings rows are drawn.
 * `caution` exists for the middle ground, which is what the account panel's
 * Log out / Clear App Data rows use.
 *
 * `iconOnly` squares the footprint for a single centred glyph — always pass an
 * `aria-label` with it, since there is no text to name the control.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'tertiary'
export type ButtonTone = 'default' | 'caution' | 'danger'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  tone?: ButtonTone
  size?: ButtonSize
  /** Square the button for one centred icon. Requires an `aria-label`. */
  iconOnly?: boolean
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
  /** Swaps the label for a spinner and blocks interaction. */
  loading?: boolean
}

const BASE =
  'relative inline-flex cursor-pointer items-center justify-center gap-2 font-medium ' +
  'select-none whitespace-nowrap ' +
  // Only the properties that actually change — animating `all` on a button that
  // sits inside a panning canvas costs real frames.
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-canvas ' +
  'disabled:pointer-events-none disabled:opacity-40'

/** variant × tone. Hovers go *lighter* here — this UI is dark, so the usual
 *  "darken on hover" reads as the button switching off. */
const VARIANTS: Record<ButtonVariant, Record<ButtonTone, string>> = {
  primary: {
    default:
      'bg-primary-500 text-white shadow-sm hover:bg-primary-400 active:bg-primary-600 ' +
      'focus-visible:ring-primary-500/50',
    caution:
      'bg-amber-500 text-black shadow-sm hover:bg-amber-400 active:bg-amber-600 ' +
      'focus-visible:ring-amber-500/50',
    danger:
      'bg-coral-500 text-white shadow-sm hover:bg-coral-400 active:bg-coral-600 ' +
      'focus-visible:ring-coral-500/50'
  },
  secondary: {
    default:
      'border border-line-strong bg-surface text-content hover:bg-hover hover:border-zinc-600 ' +
      'focus-visible:ring-primary-500/40',
    caution:
      'border border-amber-500/40 bg-amber-500/5 text-amber-400 hover:bg-amber-500/15 ' +
      'hover:border-amber-500/60 focus-visible:ring-amber-500/40',
    danger:
      'border border-coral-500/40 bg-coral-500/5 text-coral-400 hover:bg-coral-500/15 ' +
      'hover:border-coral-500/60 focus-visible:ring-coral-500/40'
  },
  tertiary: {
    default:
      'bg-transparent text-content-secondary hover:bg-hover hover:text-content ' +
      'focus-visible:ring-primary-500/40',
    caution: 'bg-transparent text-amber-400 hover:bg-amber-500/10 focus-visible:ring-amber-500/40',
    danger: 'bg-transparent text-coral-400 hover:bg-coral-500/10 focus-visible:ring-coral-500/40'
  }
}

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 rounded px-2 text-[11px]',
  sm: 'h-8 rounded-md px-3 text-xs',
  md: 'h-9 rounded-lg px-4 text-sm',
  lg: 'h-11 rounded-lg px-5 text-sm',
  xl: 'h-13 rounded-xl px-7 text-base'
}

/** Square footprints — same heights, no horizontal padding. */
const ICON_SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 w-6 rounded text-[11px]',
  sm: 'h-8 w-8 rounded-md text-xs',
  md: 'h-9 w-9 rounded-lg text-sm',
  lg: 'h-11 w-11 rounded-lg text-sm',
  xl: 'h-13 w-13 rounded-xl text-base'
}

const Spinner = (): React.JSX.Element => (
  <span
    aria-hidden="true"
    className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
  />
)

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  const {
    variant = 'primary',
    tone = 'default',
    size = 'md',
    iconOnly = false,
    leadingIcon,
    trailingIcon,
    loading = false,
    className,
    type,
    disabled,
    children,
    ...rest
  } = props

  return (
    <button
      ref={ref}
      // Defaulting to `button` matters: an unset `type` inside a <form> is
      // `submit`, so a stray toolbar button would submit the form.
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        BASE,
        VARIANTS[variant][tone],
        (iconOnly ? ICON_SIZES : SIZES)[size],
        className
      )}
      {...rest}
    >
      {loading ? <Spinner /> : leadingIcon}
      {!iconOnly && children}
      {iconOnly && !loading && children}
      {!loading && trailingIcon}
    </button>
  )
})

export default Button
