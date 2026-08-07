/**
 * Settings registry tests: the navigation contract.
 *
 * The settings surface is driven entirely by one data table. Two failure modes
 * matter, and neither of them throws — both render as a plausible-looking UI
 * that is quietly wrong:
 *
 *   1. **A destination you cannot reach.** A group heading with no entries
 *      under it, a duplicate id shadowing another panel, or a stale id that
 *      resolves to nothing and leaves a blank pane with a highlighted sidebar
 *      row pointing at it.
 *   2. **Search that only matches titles.** Nobody looking for their Groq key
 *      types "Data" or "API Keys" — they type "groq". Ranking over titles alone
 *      makes search look broken for exactly the queries people actually make,
 *      while still appearing to work when you test it with the word you already
 *      know is the heading.
 *
 * Assertions are written against the exported contract, not the shape of the
 * data, so adding a panel does not break them.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const {
  SETTINGS_ENTRIES,
  GROUP_LABELS,
  GROUP_ORDER,
  DEFAULT_ENTRY_ID,
  getEntry,
  resolveEntryId,
  sidebarGroups,
  searchEntries
} = require('./settings-registry.test.cjs')

// ═══ 1. Structural integrity ══════════════════════════════════════════════

ok('the registry is not empty', SETTINGS_ENTRIES.length > 0)

{
  const ids = SETTINGS_ENTRIES.map((e) => e.id)
  const unique = new Set(ids)
  ok(
    'every entry id is unique',
    unique.size === ids.length,
    `${ids.length} entries, ${unique.size} distinct ids`
  )
}

ok(
  'every entry declares a title, description, icon and group',
  SETTINGS_ENTRIES.every((e) => e.title && e.description && e.icon && e.group)
)

ok(
  'every entry belongs to a group that has a label',
  SETTINGS_ENTRIES.every((e) => typeof GROUP_LABELS[e.group] === 'string')
)

ok(
  'every group in the render order is labelled',
  GROUP_ORDER.every((g) => typeof GROUP_LABELS[g] === 'string')
)

// A group heading with nothing under it renders as a dead label — a heading the
// user reads, looks below, and finds empty.
ok(
  'no rendered group is empty',
  sidebarGroups().every((g) => g.entries.length > 0),
  sidebarGroups()
    .filter((g) => !g.entries.length)
    .map((g) => g.group)
    .join(', ')
)

{
  const grouped = sidebarGroups().reduce((n, g) => n + g.entries.length, 0)
  ok(
    'every entry is reachable from the sidebar',
    grouped === SETTINGS_ENTRIES.length,
    `${grouped} of ${SETTINGS_ENTRIES.length} reachable`
  )
}

ok(
  'groups render in the declared order',
  sidebarGroups()
    .map((g) => g.group)
    .every((g, i, list) => GROUP_ORDER.indexOf(g) >= (i ? GROUP_ORDER.indexOf(list[i - 1]) : 0))
)

// ═══ 2. Resolution ════════════════════════════════════════════════════════

ok('the default entry exists', !!getEntry(DEFAULT_ENTRY_ID))

// This is the one that keeps a renamed panel, or a persisted "last open panel"
// from an older build, from opening onto nothing.
ok('an unknown id falls back to the default', resolveEntryId('does-not-exist') === DEFAULT_ENTRY_ID)
ok('a null id falls back to the default', resolveEntryId(null) === DEFAULT_ENTRY_ID)
ok('an undefined id falls back to the default', resolveEntryId(undefined) === DEFAULT_ENTRY_ID)
ok('an empty id falls back to the default', resolveEntryId('') === DEFAULT_ENTRY_ID)
ok(
  'a known id resolves to itself',
  SETTINGS_ENTRIES.every((e) => resolveEntryId(e.id) === e.id)
)

// ═══ 3. Search ════════════════════════════════════════════════════════════

ok('an empty query returns nothing', searchEntries('').length === 0)
ok('a whitespace query returns nothing', searchEntries('   ').length === 0)

ok(
  'every entry is findable by its own title',
  SETTINGS_ENTRIES.every((e) => searchEntries(e.title).some((r) => r.id === e.id))
)

// The point of keywords. If this regresses, search still passes a naive
// title-only test while being useless in practice.
ok(
  'every entry is findable by each of its keywords',
  SETTINGS_ENTRIES.every((e) =>
    e.keywords.every((word) => searchEntries(word).some((r) => r.id === e.id))
  ),
  SETTINGS_ENTRIES.flatMap((e) =>
    e.keywords.filter((w) => !searchEntries(w).some((r) => r.id === e.id)).map((w) => `${e.id}:${w}`)
  ).join(', ')
)

ok('search is case-insensitive', searchEntries('ACCOUNT').some((r) => r.id === 'account'))

ok('a nonsense query returns nothing', searchEntries('zzzzqqq').length === 0)

{
  // A title prefix must outrank a mere keyword mention, or the thing you were
  // obviously looking for is not the first result.
  const results = searchEntries('account')
  ok('a title match ranks first', results.length > 0 && results[0].id === 'account')
}

{
  // Ranking must be stable between keystrokes: equal-scoring rows keep registry
  // order rather than reshuffling as you type.
  const a = searchEntries('e').map((r) => r.id)
  const b = searchEntries('e').map((r) => r.id)
  ok('ranking is deterministic', a.join() === b.join())
}

// ═══ Report ═══════════════════════════════════════════════════════════════

for (const name of PASS) console.log(`  ✓ ${name}`)
for (const name of FAIL) console.error(`  ✗ ${name}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exit(FAIL.length ? 1 : 0)
