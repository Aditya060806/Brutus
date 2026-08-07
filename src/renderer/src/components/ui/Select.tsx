import { forwardRef, type SelectHTMLAttributes } from 'react'
import { RiArrowDownSLine } from 'react-icons/ri'
import { cn } from './cn'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: SelectOption[]
  /** Rendered as a disabled, selected-by-default first entry. */
  placeholder?: string
  block?: boolean
}

/**
 * A native `<select>`, deliberately.
 *
 * A custom listbox would theme more completely, but this is an Electron app on
 * one platform: the native popup is keyboard-accessible, screen-reader correct
 * and type-ahead searchable for free, and it renders above everything without
 * needing a portal or a z-index. Only the closed state is styled — the option
 * list is drawn by the OS, which is why each `<option>` carries an explicit
 * background: without it, dark-on-dark makes the popup unreadable on Windows.
 */
const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(props, ref) {
  const { options, placeholder, block = true, className, ...rest } = props

  return (
    <div className={cn('relative', block ? 'w-full' : 'inline-block')}>
      <select
        ref={ref}
        className={cn(
          'h-9 w-full cursor-pointer appearance-none rounded-lg border border-line',
          'bg-surface-muted pl-3 pr-9 text-sm text-content',
          'transition-colors duration-150 hover:border-line-strong',
          'focus:border-primary-500/60 focus:outline-none focus:ring-2 focus:ring-primary-500/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled className="bg-elevated text-content-faint">
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className="bg-elevated text-content"
          >
            {option.label}
          </option>
        ))}
      </select>
      <RiArrowDownSLine
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-content-faint"
        size={16}
      />
    </div>
  )
})

export default Select
