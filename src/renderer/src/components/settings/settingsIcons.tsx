import { type ReactNode } from 'react'
import {
  RiChat3Line,
  RiCodeBoxLine,
  RiCpuLine,
  RiDownloadCloud2Line,
  RiInboxLine,
  RiInformationLine,
  RiKey2Line,
  RiLayoutMasonryLine,
  RiMicLine,
  RiPaletteLine,
  RiPhoneLine,
  RiShieldKeyholeLine,
  RiPulseLine,
  RiSparkling2Line,
  RiTeamLine,
  RiUserLine
} from 'react-icons/ri'

/**
 * Icon key → glyph.
 *
 * Split out from `settingsRegistry.ts` so that file can stay free of React and
 * remain loadable by the headless test harness. An unknown key renders nothing
 * rather than throwing — a missing icon is a cosmetic problem, and it should
 * not be able to take the settings modal down with it.
 */
const ICONS: Record<string, ReactNode> = {
  user: <RiUserLine size={15} />,
  palette: <RiPaletteLine size={15} />,
  download: <RiDownloadCloud2Line size={15} />,
  info: <RiInformationLine size={15} />,
  sparkles: <RiSparkling2Line size={15} />,
  mic: <RiMicLine size={15} />,
  inbox: <RiInboxLine size={15} />,
  layout: <RiLayoutMasonryLine size={15} />,
  team: <RiTeamLine size={15} />,
  key: <RiKey2Line size={15} />,
  cpu: <RiCpuLine size={15} />,
  chat: <RiChat3Line size={15} />,
  phone: <RiPhoneLine size={15} />,
  code: <RiCodeBoxLine size={15} />,
  shield: <RiShieldKeyholeLine size={15} />,
  activity: <RiPulseLine size={15} />
}

export function settingsIcon(key: string): ReactNode {
  return ICONS[key] ?? null
}
