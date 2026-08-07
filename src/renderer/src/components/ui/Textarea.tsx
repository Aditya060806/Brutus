import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from './cn'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(props, ref) {
  const { invalid, className, ...rest } = props

  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'scrollbar-small w-full rounded-lg border border-line bg-surface-muted px-3 py-2',
        'text-sm leading-relaxed text-content placeholder:text-content-faint',
        'transition-colors duration-150 hover:border-line-strong',
        'focus:border-primary-500/60 focus:outline-none focus:ring-2 focus:ring-primary-500/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        // Vertical only: a horizontally resizable textarea can be dragged wider
        // than its settings row and overlap the control beside it.
        'resize-y',
        invalid && 'border-coral-500/60 focus:border-coral-500 focus:ring-coral-500/20',
        className
      )}
      {...rest}
    />
  )
})

export default Textarea
