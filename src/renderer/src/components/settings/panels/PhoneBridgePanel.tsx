import BridgePanel from '@renderer/components/BridgePanel'
import { SettingsHeader } from '../controls'

/**
 * Hosts the LAN bridge panel.
 *
 * The bridge protocol is duplicated in the Flutter phone app and the two must
 * stay in lockstep, so the panel that drives it is mounted unchanged rather
 * than reimplemented here.
 */
const PhoneBridgePanel = (): React.JSX.Element => (
  <div className="flex flex-col gap-5">
    <SettingsHeader
      title="Phone Bridge"
      description="Discover and pair the Brutus phone app over the local network."
    />
    <BridgePanel />
  </div>
)

export default PhoneBridgePanel
