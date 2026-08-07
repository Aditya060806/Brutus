import { type HTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'

/**
 * A bounded surface: panel, tile, or section container.
 *
 * `tone` picks the material rather than the colour — `glass` reuses the same
 * `.studio-glass` definition the Studio dock and inspector use, so a floating
 * surface looks identical wherever it appears instead of each view inventing
 * its own blur and border.
 */
export type CardTone = 'surface' | 'elevated' | 'glass' | 'muted'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone
  /** Lift and glow on hover. Only for cards that are actually clickable. */
  interactive?: boolean
  children?: ReactNode
}

const TONES: Record<CardTone, string> = {
  surface: 'bg-surface border border-line',
  elevated: 'bg-elevated border border-line shadow-lg',
  muted: 'bg-surface-muted border border-line-subtle',
  // `.studio-glass` brings its own background, border and shadow.
  glass: 'studio-glass'
}

const Card = ({
  tone = 'surface',
  interactive = false,
  className,
  children,
  ...rest
}: CardProps): React.JSX.Element => (
  <div
    className={cn(
      'rounded-xl',
      TONES[tone],
      interactive && 'brutus-lift cursor-pointer hover:border-primary-500/30',
      className
    )}
    {...rest}
  >
    {children}
  </div>
)

export default Card
