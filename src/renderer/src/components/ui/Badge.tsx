import { type ReactNode } from 'react'
import { cn } from './cn'

/**
 * A small state label: connected / cooling / 3 keys / v1.0.1.
 *
 * `dot` adds a leading indicator, which is what most of Brutus's status chips
 * actually want — the colour alone is not enough on a dark surface at 10px.
 */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export interface BadgeProps {
  tone?: BadgeTone
  /** Prefix a filled dot in the tone's colour. */
  dot?: boolean
  /** Monospace + tabular figures, for versions and counters that tick. */
  mono?: boolean
  children: ReactNode
  className?: string
}

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-line bg-surface-muted text-content-muted',
  accent: 'border-primary-500/30 bg-primary-500/10 text-primary-400',
  success: 'border-sage-500/30 bg-sage-500/10 text-sage-400',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  danger: 'border-coral-500/30 bg-coral-500/10 text-coral-400',
  info: 'border-zinc-600/40 bg-zinc-800/60 text-zinc-300'
}

const DOTS: Record<BadgeTone, string> = {
  neutral: 'bg-zinc-500',
  accent: 'bg-primary-500',
  success: 'bg-sage-500',
  warning: 'bg-amber-500',
  danger: 'bg-coral-500',
  info: 'bg-zinc-400'
}

const Badge = ({
  tone = 'neutral',
  dot = false,
  mono = false,
  children,
  className
}: BadgeProps): React.JSX.Element => (
  <span
    className={cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium',
      'whitespace-nowrap',
      TONES[tone],
      mono && 'font-mono tabular-nums',
      className
    )}
  >
    {dot && <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', DOTS[tone])} />}
    {children}
  </span>
)

export default Badge
