import { useState } from 'react'
import { RiLock2Line, RiLockUnlockLine } from 'react-icons/ri'
import { Button, Input, cn } from '@renderer/components/ui'
import {
  SettingsEmptyState,
  SettingsHeader,
  SettingsRow,
  SettingsSection,
  SettingsStatus
} from '../controls'
import { useStatus } from '../useStatus'

const PIN_LENGTH = 4

/**
 * Master PIN.
 *
 * The panel gates itself: you must enter the current PIN before the change-PIN
 * form appears. Verification happens in the main process (`verify-vault-pin`) —
 * the renderer never sees the stored value, only a boolean.
 *
 * A wrong PIN shakes the field rather than saying "incorrect" in text, matching
 * the lock screen, and is deliberately not rate-limited here: the vault itself
 * is the security boundary, and adding a fake delay in the renderer would
 * suggest a protection that does not exist.
 */
const SecurityPanel = (): React.JSX.Element => {
  const [unlocked, setUnlocked] = useState(false)
  const [pin, setPin] = useState('')
  const [shake, setShake] = useState(false)
  const [newPin, setNewPin] = useState('')
  const [busy, setBusy] = useState(false)
  const { status, setStatus } = useStatus()

  const unlock = async (): Promise<void> => {
    if (!window.electron?.ipcRenderer) return
    setBusy(true)
    try {
      const valid = await window.electron.ipcRenderer.invoke('verify-vault-pin', pin)
      if (valid) {
        setUnlocked(true)
        setPin('')
      } else {
        setShake(true)
        setTimeout(() => setShake(false), 600)
        setPin('')
      }
    } finally {
      setBusy(false)
    }
  }

  const updatePin = async (): Promise<void> => {
    if (newPin.length !== PIN_LENGTH || !window.electron?.ipcRenderer) return
    setBusy(true)
    try {
      await window.electron.ipcRenderer.invoke('setup-vault-pin', newPin)
      setNewPin('')
      setStatus('success', 'Master PIN updated.')
    } catch (error) {
      setStatus('error', `Could not update the PIN: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!unlocked) {
    return (
      <div className="flex flex-col gap-5">
        <SettingsHeader
          title="Security"
          description="Enter your current master PIN to change it."
        />
        <SettingsSection>
          <SettingsEmptyState
            icon={<RiLock2Line size={28} />}
            title="This section is locked"
            description="Security settings stay sealed until the current PIN is verified."
          />
          <div className="flex items-center justify-center gap-2 px-4 pb-6">
            <Input
              type="password"
              inputMode="numeric"
              maxLength={PIN_LENGTH}
              value={pin}
              block={false}
              aria-label="Current PIN"
              placeholder="••••"
              className={cn(
                'w-28 text-center font-mono tracking-[0.5em]',
                shake && 'brutus-shake border-coral-500'
              )}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void unlock()
              }}
            />
            <Button
              size="sm"
              loading={busy}
              disabled={pin.length !== PIN_LENGTH}
              onClick={() => void unlock()}
              leadingIcon={busy ? undefined : <RiLockUnlockLine size={14} />}
            >
              Unlock
            </Button>
          </div>
        </SettingsSection>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsHeader title="Security" description="Master PIN and vault access." />

      <SettingsSection title="Master PIN">
        <SettingsRow
          htmlFor="new-pin"
          label="Change PIN"
          description={`Exactly ${PIN_LENGTH} digits. Takes effect on the next lock.`}
          control={
            <div className="flex items-center gap-2">
              <Input
                id="new-pin"
                type="password"
                inputMode="numeric"
                maxLength={PIN_LENGTH}
                value={newPin}
                block={false}
                placeholder="••••"
                className="w-28 text-center font-mono tracking-[0.5em]"
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
              />
              <Button
                size="sm"
                loading={busy}
                disabled={newPin.length !== PIN_LENGTH}
                onClick={() => void updatePin()}
              >
                Update
              </Button>
            </div>
          }
        />
        {status && (
          <div className="px-4 py-3">
            <SettingsStatus status={status} />
          </div>
        )}
      </SettingsSection>
    </div>
  )
}

export default SecurityPanel
