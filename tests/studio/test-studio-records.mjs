/**
 * Agent task records: the checklist, the search, and the review packet.
 *
 * All three features are decisions with awkward edges — what counts as
 * "missing", what a search should match, what a packet must never omit — and all
 * three are pure, so every edge is a test here rather than something a reviewer
 * finds in an exported document.
 *
 * The store half (atomic writes to disk) is exercised through the registration
 * suite; what this file pins is the logic that decides what the store contains.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const {
  MAX_RECORDS,
  completion,
  deriveChecklist,
  filterOptions,
  hasMissingData,
  isComplete,
  missingFields,
  searchRecords,
  sectionsFromMission,
  validationWarnings
} = require('./records.test.cjs')
const { buildPacket, packetFilename } = require('./packet.test.cjs')
const { sampleRecords } = require('./record-seeds.test.cjs')

// ═══ 1. Deriving the source checklist ═════════════════════════════════════

const ids = (list) => list.map((i) => i.id)

{
  const base = deriveChecklist('tidy up the readme')
  ok('every task is asked for its working folder', ids(base).includes('chk.folder'))
  ok('and what finished means', ids(base).includes('chk.done'))
  ok('both of those are required', base.filter((i) => i.required).length >= 2)
  ok('every item starts unticked', base.every((i) => !i.done))
  ok('and is marked as derived', base.every((i) => i.origin === 'derived'))
}

{
  const db = deriveChecklist('add a users table and a migration for signup')
  ok('a database task asks for the schema', ids(db).includes('chk.database'))
  ok('an auth task asks for the provider', ids(db).includes('chk.auth'))
  ok('the schema is required, not optional', db.find((i) => i.id === 'chk.database').required === true)
}

{
  const fe = deriveChecklist('restyle the landing page')
  ok('a frontend task asks for a design reference', ids(fe).includes('chk.frontend'))
  ok(
    'but does not require it — the agent can read the existing styles',
    fe.find((i) => i.id === 'chk.frontend').required === false
  )
}

{
  const deploy = deriveChecklist('set up the ci pipeline and deploy to production')
  ok('a deploy task asks for the target environment', ids(deploy).includes('chk.deploy'))
}

{
  const trivial = deriveChecklist('fix a typo in index.html')
  ok('a one-file task is not buried in questions', trivial.length <= 4, `${trivial.length} items`)
}

{
  const withReviewer = deriveChecklist('build the thing', [
    { ref: 'a', role: 'Build', agentKind: 'claude', title: 'A', brief: '', dependsOn: null },
    { ref: 'b', role: 'Review', agentKind: 'codex', title: 'B', brief: '', dependsOn: 'a' }
  ])
  ok('a crew with a reviewer is asked what to be strict about', ids(withReviewer).includes('chk.review'))

  const noReviewer = deriveChecklist('build the thing', [
    { ref: 'a', role: 'Build', agentKind: 'claude', title: 'A', brief: '', dependsOn: null }
  ])
  ok('a crew without one is not', !ids(noReviewer).includes('chk.review'))
}

{
  const a = deriveChecklist('add login with a postgres table')
  const b = deriveChecklist('add login with a postgres table')
  ok('derivation is deterministic', JSON.stringify(a) === JSON.stringify(b))
  ok('and ids are unique within a checklist', new Set(ids(a)).size === a.length)
}

ok('an empty task still produces the always-asked items', deriveChecklist('').length >= 2)
ok('a null task does not throw', deriveChecklist(null).length >= 2)

// ═══ 2. Completion ════════════════════════════════════════════════════════

const list = (spec) =>
  spec.map(([id, required, done]) => ({ id, label: id, required, done, origin: 'derived' }))

{
  const none = { checklist: list([['a', true, false], ['b', true, false]]) }
  ok('nothing ticked is not complete', !isComplete(none))
  ok('and the count reflects it', completion(none).done === 0)
  ok('the required total is right', completion(none).required === 2)
}

{
  const partial = { checklist: list([['a', true, true], ['b', true, false]]) }
  ok('half ticked is still not complete', !isComplete(partial))
  ok('and counts one done', completion(partial).done === 1)
}

{
  const done = { checklist: list([['a', true, true], ['b', true, true]]) }
  ok('ticking the last required item completes it', isComplete(done))
}

{
  const optionalLeft = { checklist: list([['a', true, true], ['b', false, false]]) }
  ok('an unticked OPTIONAL item does not block completion', isComplete(optionalLeft))
  ok('and is excluded from the required count', completion(optionalLeft).required === 1)
  ok('but is still counted in the total', completion(optionalLeft).total === 2)
}

ok('an empty checklist is vacuously complete', isComplete({ checklist: [] }))

// ═══ 3. Missing fields and warnings ═══════════════════════════════════════

const rec = (over = {}) => ({
  id: 'r1',
  workspaceId: 'w',
  task: 'do the thing',
  summary: 'Do the thing',
  complexity: 'simple',
  createdAt: 1000,
  status: 'done',
  checklist: [],
  sections: [],
  notes: '',
  ...over
})

const sec = (over = {}) => ({
  ref: 'a',
  title: 'Apollo',
  role: 'Build',
  agentKind: 'claude',
  brief: 'build it',
  status: 'done',
  output: 'built it',
  ...over
})

{
  const r = rec({ checklist: list([['chk.folder', true, false]]) })
  const missing = missingFields(r)
  ok('an unticked required input is missing data', missing.length === 1)
  ok('and names the item', missing[0].includes('chk.folder'))
  ok('the flag agrees', hasMissingData(r))
}

{
  const r = rec({ checklist: list([['opt', false, false]]) })
  ok('an unticked OPTIONAL input is not missing data', !hasMissingData(r))
}

{
  const r = rec({ sections: [sec({ output: '' })] })
  ok('a finished section with no output is missing data', hasMissingData(r))
  ok('and says which section', missingFields(r)[0].includes('Apollo'))
}

{
  const r = rec({ sections: [sec({ status: 'failed', output: '' })] })
  ok(
    'a FAILED section with no output is a warning, not missing data',
    !hasMissingData(r) && validationWarnings(r).some((w) => w.includes('Apollo'))
  )
}

{
  const r = rec({ status: 'failed', sections: [sec({ status: 'failed', note: 'exited 1' })] })
  const w = validationWarnings(r)
  ok('a failed run is warned about', w.some((x) => /did not finish/i.test(x)))
  ok('a failed section is warned about', w.some((x) => x.includes('Apollo')))
  ok('and carries its reason', w.some((x) => x.includes('exited 1')))
}

{
  const r = rec({ sections: [sec({ ref: 'b', title: 'Atlas', status: 'blocked', note: 'upstream died' })] })
  ok('a blocked section is warned about', validationWarnings(r).some((x) => /never ran/i.test(x)))
}

{
  const r = rec({ status: 'aborted' })
  ok('a stopped run is warned about', validationWarnings(r).some((x) => /stopped/i.test(x)))
}

{
  const r = rec({ checklist: list([['a', true, false], ['b', true, true]]) })
  ok(
    'running with an incomplete checklist is warned about',
    validationWarnings(r).some((x) => /incomplete source checklist/i.test(x))
  )
  ok('and reports how far it got', validationWarnings(r).some((x) => x.includes('1 of 2')))
}

{
  const r = rec({
    sections: [sec({ ref: 'a' }), sec({ ref: 'b', title: 'Atlas', role: 'Review' })]
  })
  ok(
    'a crew where one agent did everything is called out',
    validationWarnings(r).some((x) => /independently reviewed/i.test(x))
  )

  const mixed = rec({
    sections: [sec({ ref: 'a' }), sec({ ref: 'b', title: 'Atlas', agentKind: 'codex' })]
  })
  ok(
    'a genuinely mixed crew is not',
    !validationWarnings(mixed).some((x) => /independently reviewed/i.test(x))
  )
}

ok('a clean record has no warnings', validationWarnings(rec({ sections: [sec()] })).length === 0)

// ═══ 4. Search ════════════════════════════════════════════════════════════

const corpus = [
  rec({
    id: 'r-alpha',
    createdAt: 3000,
    task: 'build the dark mode toggle',
    summary: 'Dark mode for settings',
    notes: 'looks good on mobile',
    sections: [
      sec({ ref: 'a', title: 'Apollo', role: 'Build', output: 'Added ThemeToggle to Settings.tsx' }),
      sec({ ref: 'b', title: 'Atlas', role: 'Review', agentKind: 'codex', output: 'contrast checked' })
    ]
  }),
  rec({
    id: 'r-beta',
    createdAt: 2000,
    task: 'migrate the database',
    summary: 'Postgres migration',
    status: 'failed',
    sections: [sec({ ref: 'a', title: 'Vega', role: 'Build', agentKind: 'gemini', status: 'failed', output: '' })]
  }),
  rec({
    id: 'r-gamma',
    createdAt: 1000,
    task: 'write the readme',
    summary: 'Docs pass',
    checklist: list([['chk.done', true, false]]),
    sections: [sec({ ref: 'a', title: 'Orion', role: 'Verify', agentKind: 'codex' })]
  })
]

const hitIds = (hits) => hits.map((h) => h.record.id)

{
  const all = searchRecords(corpus, {})
  ok('an empty query returns everything', all.length === 3)
  ok('newest first', hitIds(all)[0] === 'r-alpha' && hitIds(all)[2] === 'r-gamma')
  ok('and is exactly what Reset does', JSON.stringify(hitIds(searchRecords(corpus))) === JSON.stringify(hitIds(all)))
}

{
  // The headline case: text that exists ONLY inside a section's generated output.
  const hits = searchRecords(corpus, { text: 'ThemeToggle' })
  ok('search finds text inside generated output', hitIds(hits).join() === 'r-alpha')
  ok('and reports which section matched', hits[0].sections.includes('a'))
  ok('with a highlight range', hits[0].matches.length > 0 && hits[0].matches[0].length === 'ThemeToggle'.length)
  ok('pointing at the right offset', (() => {
    const m = hits[0].matches[0]
    const src = corpus[0].sections[0].output
    return src.slice(m.start, m.start + m.length) === 'ThemeToggle'
  })())
  ok('and an excerpt for the result row', hits[0].matches[0].excerpt.includes('ThemeToggle'))
}

ok('search is case-insensitive', searchRecords(corpus, { text: 'themetoggle' }).length === 1)
ok('search matches the summary', hitIds(searchRecords(corpus, { text: 'Postgres' })).join() === 'r-beta')
ok('search matches the request', hitIds(searchRecords(corpus, { text: 'readme' })).join() === 'r-gamma')
ok('search matches the notes', hitIds(searchRecords(corpus, { text: 'looks good' })).join() === 'r-alpha')
ok('search matches a section title', hitIds(searchRecords(corpus, { text: 'Vega' })).join() === 'r-beta')
ok('a query matching nothing returns nothing', searchRecords(corpus, { text: 'zzzznope' }).length === 0)
ok('whitespace-only text is treated as no query', searchRecords(corpus, { text: '   ' }).length === 3)

// ═══ 5. Filters ═══════════════════════════════════════════════════════════

ok('filter by owner', hitIds(searchRecords(corpus, { owner: 'gemini' })).join() === 'r-beta')
ok(
  'owner matches any section, not just the first',
  hitIds(searchRecords(corpus, { owner: 'codex' })).sort().join() === 'r-alpha,r-gamma'
)
ok('filter by section role', hitIds(searchRecords(corpus, { section: 'Review' })).join() === 'r-alpha')
ok('section filter matches a ref too', searchRecords(corpus, { section: 'b' }).length === 1)
ok('filter by record status', hitIds(searchRecords(corpus, { status: 'failed' })).join() === 'r-beta')
/**
 * Only r-gamma. r-beta's empty section FAILED, and a failure is a warning rather
 * than missing data — the same distinction asserted above. Getting this wrong in
 * the first draft of this suite is exactly why it is spelled out here.
 */
ok(
  'filter by missing data',
  hitIds(searchRecords(corpus, { missingDataOnly: true })).join() === 'r-gamma',
  hitIds(searchRecords(corpus, { missingDataOnly: true })).join()
)

ok('"any" is not a filter', searchRecords(corpus, { owner: 'any', status: 'any', section: 'any' }).length === 3)
ok('an empty string is not a filter', searchRecords(corpus, { owner: '', status: '' }).length === 3)

{
  const combined = searchRecords(corpus, { owner: 'codex', section: 'Review' })
  ok('filters combine', hitIds(combined).join() === 'r-alpha')

  const impossible = searchRecords(corpus, { owner: 'gemini', section: 'Review' })
  ok('and an impossible combination returns nothing', impossible.length === 0)

  const textPlusFilter = searchRecords(corpus, { text: 'contrast', owner: 'codex' })
  ok('text and filters combine', hitIds(textPlusFilter).join() === 'r-alpha')
}

{
  const opts = filterOptions(corpus)
  ok('filter options list the real owners', opts.owners.sort().join() === 'claude,codex,gemini')
  ok('and the real sections', opts.sections.includes('Build') && opts.sections.includes('Review'))
  ok('and the real statuses', opts.statuses.includes('failed'))
  ok('an empty corpus offers no options', filterOptions([]).owners.length === 0)
}

// ═══ 6. Sections from a live mission ══════════════════════════════════════

{
  const mission = {
    steps: [
      {
        ref: 'a',
        title: 'Apollo',
        role: 'Build',
        agentKind: 'claude',
        brief: 'go',
        dependsOn: null,
        status: 'done',
        output: 'did it',
        startedAt: 1,
        finishedAt: 2
      }
    ]
  }
  const sections = sectionsFromMission(mission)
  ok('a mission step becomes a section', sections.length === 1)
  ok('carrying its owner', sections[0].agentKind === 'claude')
  ok('its output', sections[0].output === 'did it')
  ok('and its timings', sections[0].startedAt === 1 && sections[0].finishedAt === 2)
}

// ═══ 7. The review packet ═════════════════════════════════════════════════

{
  const full = rec({
    task: 'add dark mode',
    summary: 'Dark mode',
    notes: 'checked at both widths',
    checklist: [
      { id: 'chk.folder', label: 'Working folder confirmed', required: true, done: true, value: 'D:/w', origin: 'derived' },
      { id: 'chk.done', label: 'What "finished" means', required: true, done: false, hint: 'one sentence', origin: 'derived' }
    ],
    sections: [
      sec({ ref: 'a', title: 'Apollo', role: 'Build', output: 'ADDED_THE_TOGGLE' }),
      sec({ ref: 'b', title: 'Atlas', role: 'Review', agentKind: 'codex', status: 'failed', note: 'crashed', output: '' })
    ]
  })
  const packet = buildPacket(full, new Date('2026-08-08T10:00:00Z'))
  const md = packet.markdown

  ok('the packet names the task', md.includes('add dark mode'))
  ok('and includes every section output', md.includes('ADDED_THE_TOGGLE'))
  ok('and each section owner', md.includes('claude') && md.includes('codex'))
  ok('and the briefs', md.includes('build it'))
  ok('the checklist is included with its state', md.includes('[x]') && md.includes('[ ]'))
  ok('a supplied value is shown', md.includes('D:/w'))
  ok('missing fields are included', md.includes('Missing data') && md.includes('Input not supplied'))
  ok('validation warnings are included', md.includes('Validation warnings') && md.includes('Atlas'))
  ok('the reviewer notes are included', md.includes('checked at both widths'))
  ok(
    'warnings come BEFORE the sections they qualify',
    md.indexOf('Validation warnings') < md.indexOf('## Sections')
  )

  const parsed = JSON.parse(packet.json)
  ok('the json parses', !!parsed)
  ok('and carries the sections', parsed.sections.length === 2)
  ok('and the checklist', parsed.checklist.length === 2)
  ok('and the derived verdicts', parsed.checklistComplete === false && parsed.missingFields.length > 0)
  ok('and the warnings', parsed.validationWarnings.length > 0)
  ok('and the notes', parsed.record.notes === 'checked at both widths')
}

{
  const empty = rec({ sections: [], checklist: [], notes: '' })
  const packet = buildPacket(empty)
  ok('a record with no sections still builds a packet', packet.markdown.length > 0)
  ok('and says so rather than rendering a gap', packet.markdown.includes('no sections'))
  ok('and its json still parses', !!JSON.parse(packet.json))
}

{
  const clean = rec({ sections: [sec()] })
  const md = buildPacket(clean).markdown
  ok('a clean record says there is nothing missing', md.includes('Nothing missing'))
  ok('and no warnings', md.includes('None.'))
}

{
  // A pipe in the task would otherwise break the header table.
  const nasty = rec({ task: 'fix a | b and c | d' })
  ok('a pipe in the task does not break the table', buildPacket(nasty).markdown.includes('a \\| b'))
}

{
  const name = packetFilename(rec({ task: 'Add Dark Mode!! to the settings page' }), new Date('2026-08-08T00:00:00'))
  ok('the filename is filesystem-safe', /^[a-z0-9-]+$/.test(name), name)
  ok('and carries the date', name.includes('2026-08-08'))
  ok('an empty task still names the file', packetFilename(rec({ task: '' })).length > 0)
}

// ═══ 8. The seeded demonstration records ══════════════════════════════════

{
  const seeds = sampleRecords(5_000_000)
  ok('there are three samples', seeds.length === 3)
  ok('every one is flagged as a sample', seeds.every((r) => r.sample === true))
  ok('ids are unique', new Set(seeds.map((r) => r.id)).size === 3)
  ok('ids are stable across calls', sampleRecords(1).map((r) => r.id).join() === seeds.map((r) => r.id).join())

  const complete = seeds.filter((r) => isComplete(r) && !hasMissingData(r))
  ok('exactly one is complete with nothing missing', complete.length === 1, `${complete.length}`)
  ok('the complete one has real output in every section', complete[0].sections.every((s) => s.output?.trim()))
  ok('and has reviewer notes, so the packet has something in every part', complete[0].notes.length > 0)
  ok('and no warnings', validationWarnings(complete[0]).length === 0)

  const missing = seeds.filter((r) => hasMissingData(r))
  ok('at least one has missing data', missing.length >= 1)

  const failed = seeds.filter((r) => r.sections.some((s) => s.status === 'failed'))
  ok('exactly one has a failed section', failed.length === 1)
  ok('and that produces a visible warning', validationWarnings(failed[0]).length > 0)

  // Every sample must survive the whole pipeline, since they are what a judge sees.
  for (const s of seeds) {
    ok(`sample ${s.id} exports a packet`, buildPacket(s).markdown.length > 200)
    ok(`sample ${s.id} exports valid json`, !!JSON.parse(buildPacket(s).json))
  }
  ok('the samples are searchable', searchRecords(seeds, { text: 'dark mode' }).length >= 1)
  ok('and filterable by missing data', searchRecords(seeds, { missingDataOnly: true }).length >= 1)
}

ok('the store is bounded', MAX_RECORDS > 0 && MAX_RECORDS <= 1000)

// ═══ 9. Loose ends found in review ════════════════════════════════════════

/**
 * Each of these was a real gap: something stored but never used, or a state the
 * system could enter and never leave.
 */

{
  // Workspace scoping. Records carry the canvas they came from; the list used
  // to ignore it, so one project's Dashboard showed another project's runs.
  const mixed = [
    rec({ id: 'w1-a', workspaceId: 'ws-one', createdAt: 3 }),
    rec({ id: 'w1-b', workspaceId: 'ws-one', createdAt: 2 }),
    rec({ id: 'w2-a', workspaceId: 'ws-two', createdAt: 1 })
  ]

  ok(
    'a workspace sees only its own records',
    hitIds(searchRecords(mixed, { workspaceId: 'ws-one' })).sort().join() === 'w1-a,w1-b'
  )
  ok(
    'allWorkspaces overrides the scope',
    searchRecords(mixed, { workspaceId: 'ws-one', allWorkspaces: true }).length === 3
  )
  ok('no workspace given means no scoping', searchRecords(mixed, {}).length === 3)
  ok(
    'an unknown workspace sees nothing',
    searchRecords(mixed, { workspaceId: 'ws-nope' }).length === 0
  )
  ok(
    'scope combines with the other filters',
    searchRecords(mixed, { workspaceId: 'ws-one', status: 'done' }).length === 2
  )
}

{
  // Search reaches the checklist. What someone typed into "Schema or connection
  // details" is often the most specific text in the record, and it was the one
  // place search could not see.
  const withValues = [
    rec({
      id: 'r-chk',
      checklist: [
        {
          id: 'chk.database',
          label: 'Schema or connection details',
          required: true,
          done: true,
          value: 'the ACME_ORDERS table on staging',
          origin: 'derived'
        }
      ]
    }),
    rec({ id: 'r-other', summary: 'unrelated' })
  ]

  const hits = searchRecords(withValues, { text: 'ACME_ORDERS' })
  ok('search finds a checklist ANSWER', hitIds(hits).join() === 'r-chk')
  ok('and reports where it matched', hits[0].matches[0].label.includes('Schema'))
  ok(
    'search finds a checklist LABEL too',
    hitIds(searchRecords(withValues, { text: 'connection details' })).join() === 'r-chk'
  )
  ok('a checklist with no value is not a false match', searchRecords(withValues, { text: 'zzz' }).length === 0)
}

{
  // The section filter must stay exact. This is the regression that shipped
  // once already: 'build'.includes('b') matched every Build section.
  const two = [
    rec({ id: 'r-b', sections: [sec({ ref: 'b', role: 'Review' })] }),
    rec({ id: 'r-a', sections: [sec({ ref: 'a', role: 'Build' })] })
  ]
  ok('a ref filter does not match a role that merely contains it', searchRecords(two, { section: 'b' }).length === 1)
  ok('and it matches the right one', hitIds(searchRecords(two, { section: 'b' })).join() === 'r-b')
}

// ═══ Report ═══════════════════════════════════════════════════════════════


for (const p of PASS) console.log(`  ✓ ${p}`)
for (const f of FAIL) console.error(`  ✗ ${f}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exit(FAIL.length ? 1 : 0)
