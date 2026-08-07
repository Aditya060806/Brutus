import type { ComponentType } from 'react'
import type { SettingsEntryId } from '../settingsRegistry'
import type { PanelProps } from '../types'

import AboutPanel from './AboutPanel'
import AccountPanel from './AccountPanel'
import AgentsPanel from './AgentsPanel'
import ApiKeysPanel from './ApiKeysPanel'
import AppearancePanel from './AppearancePanel'
import BrainNodePanel from './BrainNodePanel'
import DeskPanel from './DeskPanel'
import DevToolsPanel from './DevToolsPanel'
import HistoryPanel from './HistoryPanel'
import PersonalityPanel from './PersonalityPanel'
import PhoneBridgePanel from './PhoneBridgePanel'
import SecurityPanel from './SecurityPanel'
import StudioPanel from './StudioPanel'
import UpdatesPanel from './UpdatesPanel'
import VoicePanel from './VoicePanel'

/**
 * Entry id → panel.
 *
 * Typed as a `Record` over the id union rather than a plain object, so adding
 * an entry to `settingsRegistry.ts` without writing its panel is a compile
 * error. The alternative — a lookup that returns `undefined` — fails at
 * runtime as a blank pane with a highlighted sidebar row, which is exactly the
 * kind of bug nobody notices until a user reports an empty screen.
 */
export const SETTINGS_PANELS: Record<SettingsEntryId, ComponentType<PanelProps>> = {
  account: AccountPanel,
  appearance: AppearancePanel,
  updates: UpdatesPanel,
  about: AboutPanel,
  personality: PersonalityPanel,
  voice: VoicePanel,
  desk: DeskPanel,
  studio: StudioPanel,
  agents: AgentsPanel,
  keys: ApiKeysPanel,
  brain: BrainNodePanel,
  history: HistoryPanel,
  bridge: PhoneBridgePanel,
  devtools: DevToolsPanel,
  security: SecurityPanel
}
