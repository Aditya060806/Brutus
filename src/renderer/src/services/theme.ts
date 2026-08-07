/**
 * Runtime theming.
 *
 * A "theme" here is a set of values for the `--brutus-accent-*` custom
 * properties declared in `assets/tokens.css`. Because those are bound into
 * Tailwind through `@theme inline`, writing new values onto `<html>` repaints
 * every `primary-*` utility AND every legacy `red-*` utility in the app — about
 * 650 call sites — without a re-render or a single component edit.
 *
 * ── WHY THE RAMPS ARE WRITTEN OUT ──────────────────────────────────────────
 * It is tempting to store one hex and derive the other ten stops. Generated
 * ramps look plausible and read badly: perceptual lightness does not follow a
 * linear interpolation, so the 300–400 band goes muddy and the 700+ band goes
 * flat. These are hand-designed ramps, which is why each one is eleven lines.
 */

export interface AccentPreset {
  id: string
  label: string
  /** The 500 stop, for swatch rendering. */
  swatch: string
  /** 50 → 950, in order. */
  ramp: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string
  ]
  /** The 500 stop as space-separated RGB channels, for `rgb(… / alpha)`. */
  rgb: string
}

/** `"240 68 56"` → `"240, 68, 56"`, the form `rgba()` takes. */
function commaChannels(rgb: string): string {
  return rgb.split(/\s+/).join(', ')
}

const STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const

export const ACCENT_PRESETS: AccentPreset[] = [
  {
    id: 'crimson',
    label: 'Crimson',
    swatch: '#f04438',
    rgb: '240 68 56',
    ramp: [
      '#fef3f2',
      '#fee4e2',
      '#fecdca',
      '#fda29b',
      '#f97066',
      '#f04438',
      '#d92d20',
      '#b42318',
      '#912018',
      '#7a271a',
      '#55160c'
    ]
  },
  {
    id: 'ember',
    label: 'Ember',
    swatch: '#f79009',
    rgb: '247 144 9',
    ramp: [
      '#fffaeb',
      '#fef0c7',
      '#fedf89',
      '#fec84b',
      '#fdb022',
      '#f79009',
      '#dc6803',
      '#b54708',
      '#93370d',
      '#7a2e0e',
      '#4e1d09'
    ]
  },
  {
    id: 'viridian',
    label: 'Viridian',
    swatch: '#17b26a',
    rgb: '23 178 106',
    ramp: [
      '#ecfdf3',
      '#dcfae6',
      '#abefc6',
      '#75e0a7',
      '#47cd89',
      '#17b26a',
      '#079455',
      '#067647',
      '#085d3a',
      '#074d31',
      '#053321'
    ]
  },
  {
    id: 'azure',
    label: 'Azure',
    swatch: '#2e90fa',
    rgb: '46 144 250',
    ramp: [
      '#eff8ff',
      '#d1e9ff',
      '#b2ddff',
      '#84caff',
      '#53b1fd',
      '#2e90fa',
      '#1570ef',
      '#175cd3',
      '#1849a9',
      '#194185',
      '#102a56'
    ]
  },
  {
    id: 'violet',
    label: 'Violet',
    swatch: '#7a5af8',
    rgb: '122 90 248',
    ramp: [
      '#f4f3ff',
      '#ebe9fe',
      '#d9d6fe',
      '#bdb4fe',
      '#9b8afb',
      '#7a5af8',
      '#6938ef',
      '#5925dc',
      '#4a1fb8',
      '#3e1c96',
      '#27115f'
    ]
  }
]

export const DEFAULT_ACCENT_ID = 'crimson'

export function getAccent(id: string | null | undefined): AccentPreset {
  return (
    ACCENT_PRESETS.find((preset) => preset.id === id) ??
    ACCENT_PRESETS.find((preset) => preset.id === DEFAULT_ACCENT_ID)!
  )
}

/** Paint an accent onto the document. Safe to call repeatedly. */
export function applyAccent(id: string): void {
  const preset = getAccent(id)
  const root = document.documentElement
  STOPS.forEach((stop, index) => {
    root.style.setProperty(`--brutus-accent-${stop}`, preset.ramp[index])
  })
  root.style.setProperty('--brutus-accent-rgb', preset.rgb)
  // The comma form drives every `rgba(var(--brutus-accent-c), …)` glow in the
  // Tailwind arbitrary values across the app. Forgetting it would leave ~60
  // shadows stuck on the previous accent while everything else changed.
  root.style.setProperty('--brutus-accent-c', commaChannels(preset.rgb))
}

/**
 * Damp every animation and transition in the app.
 *
 * Near-zero durations rather than `animation: none`, because some entrance
 * animations start from `opacity: 0` — removing the animation outright would
 * leave those elements permanently invisible instead of simply not moving.
 */
export function applyReducedMotion(enabled: boolean): void {
  document.documentElement.classList.toggle('brutus-reduce-motion', enabled)
}
