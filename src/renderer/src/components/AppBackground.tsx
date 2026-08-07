import { cn } from '@renderer/components/ui'

interface AppBackgroundProps {
  className?: string
}

/**
 * The app's shared background.
 *
 * ── PITCH BLACK, ON PURPOSE ────────────────────────────────────────────────
 * There is no colour in this layer at all. An earlier revision drifted two
 * accent-tinted blooms across it, which looked interesting in isolation and was
 * wrong in practice: it put a permanent red haze behind every screen, so the
 * accent stopped reading as a signal and started reading as the wallpaper. The
 * live-session aura on the dashboard is now the only large red thing in the
 * app, which is exactly what makes it legible as "live".
 *
 * What is left is structure, not colour — a dot grid at 3.5% white and a
 * vignette that is pure black falling to transparent. On a good panel the field
 * between the dots is a true absence of light, and every surface above it reads
 * as genuinely floating.
 *
 * ── PERFORMANCE ────────────────────────────────────────────────────────────
 * This sits underneath the Studio canvas, which pans a graph of live terminals.
 * Both layers are `pointer-events-none` and `contain: strict` via
 * `.studio-layer`, and neither animates, so a repaint here cannot invalidate
 * the graph above it. Nothing here needs a reduced-motion branch because
 * nothing here moves.
 */
const AppBackground = ({ className }: AppBackgroundProps): React.JSX.Element => (
  <div aria-hidden="true" className={cn('absolute inset-0 overflow-hidden bg-canvas', className)}>
    {/* Dot grid. Fixed white at low alpha — never the accent, so it stays
        identical whichever accent is selected. */}
    <div
      className="studio-layer"
      style={{
        backgroundImage:
          'radial-gradient(circle at center, rgb(255 255 255 / 0.035) 1px, transparent 1px)',
        backgroundSize: '24px 24px'
      }}
    />

    {/* Corner falloff so the dot grid does not run flat to the window edge and
        make the whole surface read as a texture swatch. */}
    <div
      className="studio-layer"
      style={{
        background:
          'radial-gradient(ellipse 85% 70% at 50% 40%, transparent 35%, rgb(0 0 0 / 0.85) 100%)'
      }}
    />
  </div>
)

export default AppBackground
