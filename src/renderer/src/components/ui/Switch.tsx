import { cn } from './cn'

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Names the control when there is no visible <label> bound to it. */
  'aria-label'?: string
  /** Id of the text that labels this switch — preferred over aria-label. */
  'aria-labelledby'?: string
  id?: string
  className?: string
}

/**
 * A boolean toggle.
 *
 * Built on a real `<button role="switch">` rather than a styled checkbox: the
 * switch role is what tells a screen reader this takes effect immediately,
 * where a checkbox implies a pending change that some later Save will commit.
 * Everything in Brutus's settings applies on the spot, so `switch` is the
 * honest role.
 */
const Switch = ({
  checked,
  onChange,
  disabled = false,
  id,
  className,
  ...aria
}: SwitchProps): React.JSX.Element => (
  <button
    id={id}
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cn(
      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full',
      'border transition-colors duration-200',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
      'focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
      'disabled:cursor-not-allowed disabled:opacity-40',
      checked ? 'border-primary-500 bg-primary-500' : 'border-line-strong bg-surface-muted',
      className
    )}
    {...aria}
  >
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full',
        'shadow-sm transition-[left,background-color] duration-200',
        // `left` rather than translateX so the knob keeps a fixed inset from
        // each end regardless of the track width.
        checked ? 'left-[1.125rem] bg-white' : 'left-0.5 bg-zinc-500'
      )}
    />
  </button>
)

export default Switch
