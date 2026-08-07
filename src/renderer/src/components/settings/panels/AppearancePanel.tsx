import { RiCheckLine } from 'react-icons/ri'
import { Switch, cn } from '@renderer/components/ui'
import { useProfileStore, AVATAR_COLORS, avatarClass } from '@renderer/store/profile-store'
import { ACCENT_PRESETS } from '@renderer/services/theme'
import { SettingsHeader, SettingsRow, SettingsSection } from '../controls'

/**
 * Accent, motion, and the avatar tint.
 *
 * Changing the accent repaints the entire app instantly and with no re-render:
 * `setAccent` writes the eleven `--brutus-accent-*` custom properties onto
 * `<html>`, and every `primary-*` and legacy `red-*` utility is bound to them
 * through `@theme inline`. See `assets/tokens.css`.
 */
const AppearancePanel = (): React.JSX.Element => {
  const accentId = useProfileStore((s) => s.accentId)
  const setAccent = useProfileStore((s) => s.setAccent)
  const reducedMotion = useProfileStore((s) => s.reducedMotion)
  const setReducedMotion = useProfileStore((s) => s.setReducedMotion)
  const avatarColor = useProfileStore((s) => s.avatarColor)
  const setAvatarColor = useProfileStore((s) => s.setAvatarColor)

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="Appearance"
        description="How Brutus looks. Changes apply immediately."
      />

      <SettingsSection
        title="Accent"
        description="Drives buttons, active states, focus rings and status glows across every view."
      >
        <div className="flex flex-wrap gap-2.5 px-4 py-4">
          {ACCENT_PRESETS.map((preset) => {
            const active = preset.id === accentId
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => setAccent(preset.id)}
                aria-pressed={active}
                className={cn(
                  'group flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2',
                  'transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                  active
                    ? 'border-primary-500/50 bg-primary-500/10'
                    : 'border-line bg-surface-muted hover:border-line-strong hover:bg-hover'
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex h-5 w-5 items-center justify-center rounded-full ring-1 ring-inset ring-white/15"
                  style={{ backgroundColor: preset.swatch }}
                >
                  {active && <RiCheckLine size={12} className="text-white" />}
                </span>
                <span
                  className={cn(
                    'text-[13px] font-medium',
                    active ? 'text-content' : 'text-content-secondary'
                  )}
                >
                  {preset.label}
                </span>
              </button>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Avatar">
        <SettingsRow
          label="Tint"
          description="Shown behind your initial in the top bar and on the account card."
          control={
            <div className="flex gap-2">
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color.id}
                  type="button"
                  onClick={() => setAvatarColor(color.id)}
                  aria-label={`Avatar colour ${color.id}`}
                  aria-pressed={color.id === avatarColor}
                  className={cn(
                    'h-6 w-6 cursor-pointer rounded-full transition-transform duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                    'focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                    avatarClass(color.id),
                    color.id === avatarColor
                      ? 'ring-2 ring-white/60 ring-offset-2 ring-offset-surface'
                      : 'hover:scale-110'
                  )}
                />
              ))}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Motion">
        <SettingsRow
          htmlFor="reduce-motion"
          label="Reduce motion"
          description="Damps animations and transitions everywhere, including the Studio canvas scenery. Your system setting is honoured independently of this."
          control={
            <Switch
              id="reduce-motion"
              checked={reducedMotion}
              onChange={setReducedMotion}
              aria-label="Reduce motion"
            />
          }
        />
      </SettingsSection>
    </div>
  )
}

export default AppearancePanel
