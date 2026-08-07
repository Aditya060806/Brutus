import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RiLogoutBoxRLine, RiDeleteBin6Line, RiMagicLine, RiShieldCheckLine } from 'react-icons/ri'
import { Badge, Button, Card, cn } from '@renderer/components/ui'
import { useAuthStore } from '@renderer/store/auth-store'
import { avatarClass, useProfileStore } from '@renderer/store/profile-store'
import { clearAllPrefs } from '@renderer/services/preferences'
import { SettingsHeader, SettingsRow, SettingsSection, SettingsStatus } from '../controls'
import { useStatus } from '../useStatus'
import type { PanelProps } from '../types'

type Tab = 'account' | 'privacy'

/**
 * Identity and local data.
 *
 * ── WHERE THE IDENTITY COMES FROM ──────────────────────────────────────────
 * The cloud profile is whatever `/api/v1/auth/me` returned at launch, captured
 * into the auth store by `ProtectedRoute`. Before this panel existed that
 * response was fetched on every start and thrown away — only its status code
 * was read.
 *
 * ── WHY NOTHING HERE EDITS THE CLOUD PROFILE ───────────────────────────────
 * The backend exposes four auth routes — google, login, me, refresh-token — and
 * no way to update a profile. So the display name and avatar are *local*
 * personalisation, and the panel says so rather than implying a sync that has
 * no endpoint behind it.
 */
const AccountPanel = ({ navigate: goToPanel, close }: PanelProps): React.JSX.Element => {
  const [tab, setTab] = useState<Tab>('account')
  const [armed, setArmed] = useState(false)
  const { status, setStatus } = useStatus()
  const routerNavigate = useNavigate()

  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const displayName = useProfileStore((s) => s.displayName)
  const avatarColor = useProfileStore((s) => s.avatarColor)
  const reloadProfile = useProfileStore((s) => s.reload)
  const setOnboarded = useProfileStore((s) => s.setOnboarded)

  const shownName = user?.name || displayName || 'Operator'
  const initial = shownName.trim().charAt(0).toUpperCase() || 'B'

  const signOut = (): void => {
    logout()
    close()
    routerNavigate('/login', { replace: true })
  }

  const clearAppData = (): void => {
    if (!armed) {
      setArmed(true)
      setTimeout(() => setArmed(false), 4000)
      return
    }
    clearAllPrefs()
    reloadProfile()
    logout()
    close()
    routerNavigate('/login', { replace: true })
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader
        title="Account"
        description="Your identity, personalisation, and the data Brutus keeps on this machine."
      />

      {/* Identity card — the visual anchor of the panel. */}
      <Card tone="elevated" className="flex items-center gap-4 p-5">
        <span
          aria-hidden="true"
          className={cn(
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-full',
            'text-lg font-semibold text-white ring-1 ring-inset ring-white/15',
            avatarClass(avatarColor)
          )}
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-content">{shownName}</p>
          <p className="truncate text-xs text-content-muted">
            {user?.email ?? 'Signed in on this device'}
          </p>
        </div>
        {user ? (
          <Badge tone="success" dot>
            Synced
          </Badge>
        ) : (
          <Badge tone="neutral" dot>
            Local only
          </Badge>
        )}
      </Card>

      {/* Sub-tabs, mirroring the reference layout. */}
      <div className="flex gap-1.5">
        {(
          [
            { id: 'account', label: 'Account' },
            { id: 'privacy', label: 'Privacy' }
          ] as const
        ).map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? 'page' : undefined}
            className={cn(
              'cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-medium',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
              tab === entry.id
                ? 'bg-content text-canvas'
                : 'bg-surface-muted text-content-muted hover:bg-hover hover:text-content-secondary'
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'account' && (
        <>
          <SettingsSection title="Personalisation">
            <SettingsRow
              label="Display name and avatar"
              description="Stored on this device. Brutus uses the name when it speaks to you."
              control={
                <Button variant="secondary" size="sm" onClick={() => goToPanel('personality')}>
                  Edit
                </Button>
              }
            />
            <SettingsRow
              label="Run setup again"
              description="Reopens the welcome flow — name, avatar, accent and voice — the next time Brutus starts."
              control={
                <Button
                  variant="tertiary"
                  size="sm"
                  leadingIcon={<RiMagicLine size={14} />}
                  onClick={() => {
                    setOnboarded(false)
                    setStatus('success', 'Setup will run again on the next launch.')
                  }}
                >
                  Reset setup
                </Button>
              }
            />
          </SettingsSection>

          <SettingsSection
            title="Session"
            description="Signing out keeps everything on this machine; clearing removes it."
          >
            <SettingsRow
              label={<span className="text-amber-400">Log out</span>}
              description="Ends the cloud session. Your settings, keys and workspaces stay where they are."
              control={
                <Button
                  variant="secondary"
                  tone="caution"
                  size="sm"
                  leadingIcon={<RiLogoutBoxRLine size={14} />}
                  onClick={signOut}
                >
                  Log out
                </Button>
              }
            />
            <SettingsRow
              label={<span className="text-coral-400">Clear app data</span>}
              description="Signs out and erases every local preference — API keys, voice settings, personalisation. This cannot be undone."
              control={
                <Button
                  variant="secondary"
                  tone="danger"
                  size="sm"
                  leadingIcon={<RiDeleteBin6Line size={14} />}
                  onClick={clearAppData}
                >
                  {armed ? 'Click again to erase' : 'Clear app data'}
                </Button>
              }
            />
          </SettingsSection>
        </>
      )}

      {tab === 'privacy' && (
        <SettingsSection
          title="What leaves this machine"
          description="Brutus is local-first. This is the complete list."
        >
          <SettingsRow
            label="Model providers"
            description="Chat and voice go to whichever provider holds the key you configured — Google, Groq — or to your own Brain Node when routing is on."
            control={
              <Button variant="tertiary" size="sm" onClick={() => goToPanel('keys')}>
                Review keys
              </Button>
            }
          />
          <SettingsRow
            label="Web search"
            description="Only the search query itself is sent to Tavily, and only during a research task."
          />
          <SettingsRow
            label="Agent CLIs"
            description="Studio runs Claude, Codex and Gemini as local processes under your own subscriptions. Brutus brokers no traffic for them."
            control={
              <Button variant="tertiary" size="sm" onClick={() => goToPanel('studio')}>
                Studio
              </Button>
            }
          />
          <SettingsRow
            label="Everything else"
            description="Notes, transcripts, workspaces, robot telemetry and the knowledge graph never leave this device."
            control={
              <Badge tone="success" dot>
                <RiShieldCheckLine size={11} /> Local
              </Badge>
            }
          />
        </SettingsSection>
      )}

      <SettingsStatus status={status} />
    </div>
  )
}

export default AccountPanel
