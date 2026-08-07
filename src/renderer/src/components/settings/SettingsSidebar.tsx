import { useMemo, useState } from 'react'
import { RiSearchLine } from 'react-icons/ri'
import { Input, cn } from '@renderer/components/ui'
import { searchEntries, sidebarGroups, type SettingsEntry } from './settingsRegistry'
import { settingsIcon } from './settingsIcons'

interface SettingsSidebarProps {
  activeId: string
  onSelect: (id: string) => void
}

interface NavSection {
  key: string
  /** Null renders no heading — used for the flat search-result list. */
  label: string | null
  entries: SettingsEntry[]
}

/**
 * Grouped settings navigation with search.
 *
 * While a query is present the grouped nav is replaced by a flat ranked list
 * over the *whole* registry, including keywords — so typing "groq" finds API
 * Keys even though neither the group nor the panel title contains that word.
 * Ranking that only looked at titles would make search appear broken for the
 * queries people actually type.
 */
const SettingsSidebar = ({ activeId, onSelect }: SettingsSidebarProps): React.JSX.Element => {
  const [query, setQuery] = useState('')
  const searching = query.trim().length > 0

  const sections: NavSection[] = useMemo(() => {
    if (searching) {
      return [{ key: 'results', label: null, entries: searchEntries(query) }]
    }
    return sidebarGroups().map((group) => ({
      key: group.group,
      label: group.label,
      entries: group.entries
    }))
  }, [query, searching])

  const empty = sections.every((section) => section.entries.length === 0)

  return (
    <nav aria-label="Settings" className="flex h-full min-h-0 flex-col border-r border-line">
      <div className="border-b border-line p-3">
        <Input
          type="search"
          value={query}
          placeholder="Search settings…"
          aria-label="Search settings"
          leadingIcon={<RiSearchLine size={14} />}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="scrollbar-small min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {sections.map((section) => (
          <div key={section.key}>
            {section.label && (
              <div className="px-2 pb-1 pt-4">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-content-faint">
                  {section.label}
                </span>
              </div>
            )}
            <ul className={section.label ? undefined : 'pt-3'}>
              {section.entries.map((entry) => {
                const active = entry.id === activeId
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      aria-current={active ? 'page' : undefined}
                      onClick={() => onSelect(entry.id)}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2',
                        'text-left text-[13px] transition-colors duration-150',
                        'focus-visible:outline-none focus-visible:ring-2',
                        'focus-visible:ring-primary-500/40',
                        active
                          ? 'bg-primary-500/12 font-medium text-primary-400'
                          : entry.highlight
                            ? 'font-medium text-primary-400/90 hover:bg-hover'
                            : 'text-content-secondary hover:bg-hover hover:text-content'
                      )}
                    >
                      <span
                        className={cn(
                          'shrink-0',
                          active || entry.highlight ? 'text-primary-500' : 'text-content-faint'
                        )}
                      >
                        {settingsIcon(entry.icon)}
                      </span>
                      <span className="truncate">{entry.title}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}

        {searching && empty && (
          <p className="px-2 pt-6 text-center text-xs leading-relaxed text-content-faint">
            Nothing matches “{query.trim()}”.
          </p>
        )}
      </div>
    </nav>
  )
}

export default SettingsSidebar
