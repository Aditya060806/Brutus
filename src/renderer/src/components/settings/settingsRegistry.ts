/**
 * BRUTUS settings — the route registry
 * ------------------------------------
 * Every settings destination is declared here, once. The sidebar renders from
 * it, search ranks over it, and the modal resolves the active panel through it.
 *
 * ── WHY THIS FILE HAS NO REACT IN IT ───────────────────────────────────────
 * Deliberately pure TypeScript — no JSX, no `react-icons`, no `electron`. That
 * keeps it loadable by the existing headless test harness (`tests/build.mjs`
 * esbuilds main-process modules for plain node), so the navigation contract can
 * be asserted without a DOM. Icons are declared as string keys and resolved to
 * components in `settingsIcons.tsx`; panels are wired in `panels/index.tsx`.
 *
 * The panel wiring is a `Record<SettingsEntryId, …>`, so TypeScript — not a
 * runtime check — guarantees every entry declared here actually has a panel.
 * Adding an entry without its panel fails the build rather than rendering an
 * empty pane.
 */

export type SettingsGroup = 'general' | 'assistant' | 'data' | 'connections' | 'security'

export interface SettingsEntry {
  id: string
  /** Sidebar label. */
  title: string
  /** One line under the panel heading. */
  description: string
  group: SettingsGroup
  /** Icon key, resolved by `settingsIcons.tsx`. */
  icon: string
  /**
   * Extra search terms.
   *
   * These matter more than the titles do: nobody searching for their Groq key
   * types "Data" or "API Keys" — they type "groq". Ranking over titles alone
   * makes search look broken for exactly the queries people actually make.
   */
  keywords: string[]
  /** Tint the row even when inactive — used for anything account-critical. */
  highlight?: boolean
}

/** Heading text per group, in the order the sidebar renders them. */
export const GROUP_LABELS: Record<SettingsGroup, string> = {
  general: 'General',
  assistant: 'Assistant',
  data: 'Data',
  connections: 'Connections',
  security: 'Security'
}

export const GROUP_ORDER: SettingsGroup[] = [
  'general',
  'assistant',
  'data',
  'connections',
  'security'
]

export const SETTINGS_ENTRIES = [
  {
    id: 'account',
    title: 'Account',
    description: 'Your identity, personalisation, and local app data.',
    group: 'general',
    icon: 'user',
    highlight: true,
    keywords: [
      'profile',
      'sign in',
      'sign out',
      'log out',
      'logout',
      'avatar',
      'display name',
      'clear data',
      'google',
      'identity'
    ]
  },
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Accent colour, motion, and interface density.',
    group: 'general',
    icon: 'palette',
    keywords: ['theme', 'colour', 'color', 'accent', 'animation', 'motion', 'dark', 'density']
  },
  {
    id: 'updates',
    title: 'Updates',
    description: 'Check for, download, and install new builds.',
    group: 'general',
    icon: 'download',
    keywords: ['version', 'update', 'upgrade', 'release', 'patch notes', 'install']
  },
  {
    id: 'about',
    title: 'About',
    description: 'Build information and system status.',
    group: 'general',
    icon: 'info',
    keywords: ['version', 'build', 'credits', 'licence', 'license', 'system']
  },
  {
    id: 'personality',
    title: 'Personality & Voice',
    description: 'How Brutus speaks, and who it thinks it is.',
    group: 'assistant',
    icon: 'sparkles',
    keywords: [
      'persona',
      'personality',
      'matrix',
      'prompt',
      'voice',
      'tts',
      'male',
      'female',
      'engine',
      'operator',
      'user name',
      'designation'
    ]
  },
  {
    id: 'voice',
    title: 'Voice',
    description: 'How Brutus hears you and how it answers.',
    group: 'assistant',
    icon: 'mic',
    keywords: [
      'speech',
      'microphone',
      'mic',
      'whisper',
      'on device',
      'on-device',
      'offline',
      'local',
      'stt',
      'tts',
      'transcription',
      'gemini live',
      'engine',
      'private'
    ]
  },
  {
    id: 'studio',
    title: 'Studio',
    description: 'Agent canvas defaults, models, and worktree isolation.',
    group: 'assistant',
    icon: 'layout',
    keywords: [
      'canvas',
      'claude',
      'codex',
      'gemini',
      'worktree',
      'terminal',
      'agent',
      'parallel',
      'reclaim'
    ]
  },
  {
    id: 'agents',
    title: 'Agents',
    description: 'Multi-agent orchestration, key pool, and autonomy.',
    group: 'assistant',
    icon: 'team',
    keywords: [
      'orchestrator',
      'groq',
      'tavily',
      'concurrency',
      'autonomy',
      'key pool',
      'planner',
      'agent command'
    ]
  },
  {
    id: 'desk',
    title: 'Desk',
    description: 'Autonomous inbox handling, and the rails that keep it safe.',
    group: 'assistant',
    icon: 'inbox',
    keywords: [
      'email',
      'inbox',
      'autonomous',
      'auto reply',
      'autoreply',
      'triage',
      'follow up',
      'followup',
      'commitments',
      'gmail',
      'coo',
      'assistant',
      'allowlist',
      'quiet hours'
    ]
  },
  {
    id: 'keys',
    title: 'API Keys',
    description: 'Credentials for the external services Brutus can reach.',
    group: 'data',
    icon: 'key',
    keywords: [
      'gemini',
      'groq',
      'huggingface',
      'hugging face',
      'tavily',
      'token',
      'secret',
      'vault',
      'credential'
    ]
  },
  {
    id: 'brain',
    title: 'Brain Node',
    description: 'Route inference to the edge device instead of the cloud.',
    group: 'data',
    icon: 'cpu',
    keywords: [
      'edge',
      'inference',
      'snapdragon',
      'qwen',
      'npu',
      'llm',
      'routing',
      'base url',
      'local'
    ]
  },
  {
    id: 'history',
    title: 'Chat History',
    description: 'Stored conversation transcripts.',
    group: 'data',
    icon: 'chat',
    keywords: ['clear', 'wipe', 'delete', 'transcript', 'conversation', 'messages']
  },
  {
    id: 'bridge',
    title: 'Phone Bridge',
    description: 'Pair the desktop with the Brutus phone app over the LAN.',
    group: 'connections',
    icon: 'phone',
    keywords: ['lan', 'pair', 'pairing', 'udp', 'websocket', 'phone', 'duet', 'discovery']
  },
  {
    id: 'diagnostics',
    title: 'Diagnostics',
    description: 'Check every device, provider and permission in one pass.',
    group: 'connections',
    icon: 'activity',
    keywords: [
      'diagnostic',
      'diagnostics',
      'test',
      'check',
      'health',
      'microphone',
      'mic',
      'speaker',
      'camera',
      'webcam',
      'permission',
      'internet',
      'offline',
      'gpu',
      'ram',
      'memory',
      'logs',
      'log',
      'bug',
      'report',
      'crash',
      'troubleshoot',
      'not working',
      'broken'
    ]
  },
  {
    id: 'devtools',
    title: 'Developer Tools',
    description: 'External binaries Brutus can drive on your behalf.',
    group: 'connections',
    icon: 'code',
    keywords: [
      'vscode',
      'vs code',
      'libreoffice',
      'soffice',
      'git',
      'extensions',
      'document',
      'conversion'
    ]
  },
  {
    id: 'security',
    title: 'Security',
    description: 'Master PIN and vault access.',
    group: 'security',
    icon: 'shield',
    keywords: ['pin', 'lock', 'vault', 'password', 'unlock', 'passcode']
  }
] as const satisfies readonly SettingsEntry[]

/** Union of every declared id — what makes the panel map exhaustive. */
export type SettingsEntryId = (typeof SETTINGS_ENTRIES)[number]['id']

/** The panel opened when none is chosen, and the fallback for an unknown id. */
export const DEFAULT_ENTRY_ID: SettingsEntryId = 'account'

export function getEntry(id: string): SettingsEntry | undefined {
  return SETTINGS_ENTRIES.find((entry) => entry.id === id)
}

/**
 * Resolve an arbitrary id to one that definitely exists.
 *
 * A stale id — from a persisted "last open panel", or a link that outlived a
 * rename — must land somewhere real. Returning the default beats rendering a
 * blank pane with a highlighted sidebar row pointing at nothing.
 */
export function resolveEntryId(id: string | null | undefined): SettingsEntryId {
  return getEntry(id ?? '') ? (id as SettingsEntryId) : DEFAULT_ENTRY_ID
}

export interface SettingsGroupView {
  group: SettingsGroup
  label: string
  entries: SettingsEntry[]
}

/** The sidebar's grouped structure. Groups with no entries are omitted. */
export function sidebarGroups(): SettingsGroupView[] {
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    entries: SETTINGS_ENTRIES.filter((entry) => entry.group === group)
  })).filter((view) => view.entries.length > 0)
}

/**
 * Rank entries against a free-text query.
 *
 * Scoring, highest first:
 *   4  title starts with the query        ("app" → Appearance)
 *   3  title contains it
 *   2  a keyword starts with it           ("groq" → API Keys)
 *   1  a keyword or the description contains it
 *
 * Ties keep registry order, so the result list stays stable between keystrokes
 * rather than reshuffling equal-scoring rows.
 */
export function searchEntries(query: string): SettingsEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const scored: { entry: SettingsEntry; score: number; index: number }[] = []

  SETTINGS_ENTRIES.forEach((entry, index) => {
    const title = entry.title.toLowerCase()
    let score = 0

    if (title.startsWith(needle)) score = 4
    else if (title.includes(needle)) score = 3
    else if (entry.keywords.some((word) => word.toLowerCase().startsWith(needle))) score = 2
    else if (
      entry.keywords.some((word) => word.toLowerCase().includes(needle)) ||
      entry.description.toLowerCase().includes(needle)
    )
      score = 1

    if (score > 0) scored.push({ entry, score, index })
  })

  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((result) => result.entry)
}
