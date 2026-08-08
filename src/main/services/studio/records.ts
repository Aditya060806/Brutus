import fs from 'fs'
import path from 'path'
import {
  estimateComplexity,
  type ComplexityTier,
  type MissionState,
  type MissionStep,
  type StepStatus
} from './mission'
import type { AgentKind } from './types'

/**
 * BRUTUS Studio — agent task records.
 *
 * A mission used to leave no trace: `MissionTracker` lived in a `Map` and died
 * with the process, so once a crew finished there was nothing to search, nothing
 * to review, and nothing to hand to anyone else. This is the record that
 * survives — one per agent task, holding what was asked, what each agent
 * produced, what the task still needs, and whatever the human wrote about it.
 *
 * ── WHAT IS STORED AND WHAT IS DERIVED ─────────────────────────────────────
 * Stored: the facts. The task, the sections, the checklist ticks, the notes.
 * Derived: every judgement about them — is it complete, what is missing, what
 * looks wrong. Deriving those on read means a record written by an older build
 * cannot carry a stale verdict, and there is exactly one definition of
 * "incomplete" rather than one per writer.
 *
 * ── WHY THE PURE HALF IS SEPARATE FROM THE STORE ───────────────────────────
 * Everything above `configureRecords` is pure. Checklist derivation, search,
 * filtering and validation are all decisions with awkward edges, and they are
 * tested exhaustively without a filesystem in `tests/studio/test-studio-records.mjs`.
 */

// ─── Shapes ─────────────────────────────────────────────────────────────────

export interface ChecklistItem {
  id: string
  label: string
  /** Why it is being asked for. Shown under the label. */
  hint?: string
  required: boolean
  done: boolean
  /** Optional free text: a path, a URL, a one-line answer. */
  value?: string
  /** Whether Brutus proposed it or the user added it. */
  origin: 'derived' | 'user'
}

/** One section of an agent task — a mission step, after the fact. */
export interface TaskSection {
  ref: string
  /** Display name of the agent that owned it. */
  title: string
  /** What it was for: Build, Review, Verify. */
  role: string
  /** The owning agent. */
  agentKind: AgentKind
  brief: string
  status: StepStatus
  /** What the agent actually produced. The searchable content. */
  output?: string
  /** Why it failed, or which failure blocked it. */
  note?: string
  startedAt?: number
  finishedAt?: number
}

export type RecordStatus = 'planned' | 'running' | 'done' | 'failed' | 'aborted'

export interface TaskRecord {
  id: string
  workspaceId: string
  /** What the human asked, verbatim. */
  task: string
  /** The planner's restatement. */
  summary: string
  complexity: ComplexityTier
  createdAt: number
  finishedAt?: number
  status: RecordStatus
  checklist: ChecklistItem[]
  sections: TaskSection[]
  /** The user's own notes. Goes into the review packet. */
  notes: string
  /** A seeded demonstration record rather than a real run. */
  sample?: boolean
}

// ─── Deriving the source checklist ──────────────────────────────────────────

/**
 * What each area of work needs before an agent can do it properly.
 *
 * Keyed by the surface names `estimateComplexity` already detects, so this adds
 * no analysis of its own and no second model call — it reuses a decision that
 * has already been made and tested.
 */
const SURFACE_INPUTS: Record<string, { label: string; hint: string; required: boolean }> = {
  frontend: {
    label: 'Design reference or existing styles',
    hint: 'A screenshot, a link, or the stylesheet the new work should match.',
    required: false
  },
  backend: {
    label: 'API contract or endpoint list',
    hint: 'What the endpoints are called and what they return.',
    required: true
  },
  database: {
    label: 'Schema or connection details',
    hint: 'The tables involved, or where the agent can read the schema from.',
    required: true
  },
  auth: {
    label: 'Which auth provider and where its config lives',
    hint: 'Guessing this wrong is expensive to undo.',
    required: true
  },
  tests: {
    label: 'How the tests are run',
    hint: 'The command, and whether anything must be running first.',
    required: true
  },
  deploy: {
    label: 'Target environment',
    hint: 'Where this is meant to end up, and what must never be touched.',
    required: true
  },
  docs: {
    label: 'Which document, and who reads it',
    hint: 'Tone and audience change the answer.',
    required: false
  },
  mobile: {
    label: 'Target platform and minimum version',
    hint: 'iOS, Android, or both.',
    required: true
  },
  data: {
    label: 'Where the data comes from',
    hint: 'A file, an endpoint, or credentials for the source.',
    required: true
  }
}

/** Asked on every task, whatever it touches. */
const ALWAYS: { id: string; label: string; hint: string; required: boolean }[] = [
  {
    id: 'chk.folder',
    label: 'Working folder confirmed',
    hint: 'The agents edit real files here. This is the one worth checking twice.',
    required: true
  },
  {
    id: 'chk.done',
    label: 'What "finished" means',
    hint: 'One sentence the last agent can actually check its work against.',
    required: true
  }
]

/**
 * Build the checklist for a task, before anything runs.
 *
 * Deterministic: the same request produces the same checklist with the same
 * ids, so ticking an item and re-planning does not shuffle the list underneath
 * the user.
 */
export function deriveChecklist(task: string, steps: MissionStep[] = []): ChecklistItem[] {
  const items: ChecklistItem[] = ALWAYS.map((a) => ({
    id: a.id,
    label: a.label,
    hint: a.hint,
    required: a.required,
    done: false,
    origin: 'derived' as const
  }))

  for (const surface of estimateComplexity(task).surfaces) {
    const spec = SURFACE_INPUTS[surface]
    if (!spec) continue
    items.push({
      id: `chk.${surface}`,
      label: spec.label,
      hint: spec.hint,
      required: spec.required,
      done: false,
      origin: 'derived'
    })
  }

  /**
   * A crew with a reviewer needs to know what "good" looks like to that
   * reviewer, which is a different question from what "finished" means.
   */
  if (steps.some((s) => /review|verify|check|test/i.test(s.role))) {
    items.push({
      id: 'chk.review',
      label: 'What the reviewer should be strict about',
      hint: 'Left blank, a reviewing agent tends to approve its own crew’s work.',
      required: false,
      done: false,
      origin: 'derived'
    })
  }

  return items
}

// ─── Judgements, always derived ─────────────────────────────────────────────

/** Every required item ticked. Optional items never block completion. */
export function isComplete(record: Pick<TaskRecord, 'checklist'>): boolean {
  return record.checklist.every((i) => !i.required || i.done)
}

/** How far along the checklist is, for the indicator. */
export function completion(record: Pick<TaskRecord, 'checklist'>): {
  done: number
  required: number
  total: number
} {
  const required = record.checklist.filter((i) => i.required)
  return {
    done: required.filter((i) => i.done).length,
    required: required.length,
    total: record.checklist.length
  }
}

/**
 * What this task is still missing.
 *
 * Two different absences, deliberately in one list: an input the user never
 * supplied, and a section that finished without producing anything. Both mean
 * the same thing to someone reviewing the packet — there is a hole here — and
 * splitting them into two lists would make that harder to see, not easier.
 */
export function missingFields(record: TaskRecord): string[] {
  const missing: string[] = []

  for (const item of record.checklist) {
    if (item.required && !item.done) missing.push(`Input not supplied: ${item.label}`)
  }

  for (const section of record.sections) {
    if (section.status === 'done' && !section.output?.trim()) {
      missing.push(`${section.title} finished without producing any output`)
    }
  }

  return missing
}

/** Does anything about this record need a human to look? Drives the filter. */
export function hasMissingData(record: TaskRecord): boolean {
  return missingFields(record).length > 0
}

/**
 * Everything that looks wrong, in the order someone would want to read it.
 *
 * Distinct from `missingFields`: a warning is about what *happened*, a missing
 * field is about what was never there.
 */
export function validationWarnings(record: TaskRecord): string[] {
  const warnings: string[] = []

  if (record.status === 'failed') warnings.push('The run did not finish successfully.')
  if (record.status === 'aborted') warnings.push('The run was stopped before it finished.')

  for (const section of record.sections) {
    if (section.status === 'failed') {
      warnings.push(
        `${section.title} (${section.role}) failed${section.note ? `: ${section.note}` : '.'}`
      )
    } else if (section.status === 'blocked') {
      warnings.push(`${section.title} never ran${section.note ? `: ${section.note}` : '.'}`)
    }
  }

  if (!isComplete(record)) {
    const { done, required } = completion(record)
    warnings.push(
      `The task ran with an incomplete source checklist (${done} of ${required} required inputs supplied).`
    )
  }

  /**
   * Nobody checked the work.
   *
   * Worth saying out loud on a review packet: a crew where one agent both wrote
   * and approved is a weaker result than the section list alone suggests.
   */
  const owners = new Set(record.sections.map((s) => s.agentKind))
  if (record.sections.length > 1 && owners.size === 1) {
    warnings.push(
      'Every section was produced by the same agent — nothing was independently reviewed.'
    )
  }

  return warnings
}

// ─── Search and filters ─────────────────────────────────────────────────────

export interface RecordQuery {
  /** Free text across the task, summary, notes, checklist and every section. */
  text?: string
  /** A section ref or role. */
  section?: string
  status?: string
  owner?: string
  missingDataOnly?: boolean
  /**
   * Limit to one canvas.
   *
   * Records carry the workspace they came from, and a Dashboard showing another
   * project's runs is the same confusion missions had before they were scoped.
   * Omitted, or with `allWorkspaces`, the list spans everything — which is what
   * you want when reviewing rather than working.
   */
  workspaceId?: string
  allWorkspaces?: boolean
}

/** Where a match landed, so the UI can highlight rather than merely narrow. */
export interface MatchRange {
  /** Which field matched: 'summary', 'task', 'notes', or a section ref. */
  field: string
  /** What the matched text belongs to, for grouping in the UI. */
  label: string
  start: number
  length: number
  /** A window of surrounding text, for a result snippet. */
  excerpt: string
}

export interface RecordHit {
  record: TaskRecord
  /** Section refs that matched the text, if any. */
  sections: string[]
  matches: MatchRange[]
}

/** Characters either side of a match in the excerpt. */
const EXCERPT_PAD = 48

function findAll(haystack: string, needle: string, field: string, label: string): MatchRange[] {
  if (!haystack || !needle) return []
  const hay = haystack.toLowerCase()
  const pin = needle.toLowerCase()
  const out: MatchRange[] = []
  let from = 0

  // Capped: a one-letter query against a long output would otherwise produce
  // thousands of ranges, none of which anyone reads.
  while (out.length < 8) {
    const at = hay.indexOf(pin, from)
    if (at === -1) break
    out.push({
      field,
      label,
      start: at,
      length: needle.length,
      excerpt: haystack
        .slice(Math.max(0, at - EXCERPT_PAD), at + needle.length + EXCERPT_PAD)
        .trim()
    })
    from = at + needle.length
  }
  return out
}

/**
 * Filter and search records in one pass.
 *
 * An empty query returns everything — which is also exactly what Reset does, so
 * there is no second "clear" path that could drift from this one.
 */
export function searchRecords(records: TaskRecord[], query: RecordQuery = {}): RecordHit[] {
  const text = (query.text ?? '').trim()
  const section = (query.section ?? '').trim().toLowerCase()
  const status = (query.status ?? '').trim().toLowerCase()
  const owner = (query.owner ?? '').trim().toLowerCase()
  const any = (v: string): boolean => !v || v === 'any' || v === 'all'

  const hits: RecordHit[] = []

  for (const record of records) {
    // ── Structural filters first: cheaper, and they decide inclusion outright.
    if (!query.allWorkspaces && query.workspaceId && record.workspaceId !== query.workspaceId) {
      continue
    }
    if (query.missingDataOnly && !hasMissingData(record)) continue

    if (!any(owner) && !record.sections.some((s) => s.agentKind.toLowerCase() === owner)) continue

    if (!any(status)) {
      // A status matches either the whole task or any one of its sections, so
      // "failed" finds a task that failed AND a finished task with a failed
      // section — both are what someone filtering for failure is looking for.
      const matchesRecord = record.status.toLowerCase() === status
      const matchesSection = record.sections.some((s) => s.status.toLowerCase() === status)
      if (!matchesRecord && !matchesSection) continue
    }

    if (!any(section)) {
      /**
       * Exact, on both the ref and the role.
       *
       * Substring matching was the first shape and it is quietly wrong: the
       * filter is a select populated from `filterOptions`, so its values are
       * always whole role names — and a substring test meant a ref of `b` also
       * matched every section whose role merely *contained* a b, which is every
       * "Build". A filter that returns more than you asked for is worse than one
       * that returns nothing, because you believe the extra rows.
       */
      const inSection = record.sections.some(
        (s) => s.ref.toLowerCase() === section || s.role.toLowerCase() === section
      )
      if (!inSection) continue
    }

    // ── Then the text search, which produces the highlights.
    if (!text) {
      hits.push({ record, sections: [], matches: [] })
      continue
    }

    const matches: MatchRange[] = [
      ...findAll(record.summary, text, 'summary', 'Summary'),
      ...findAll(record.task, text, 'task', 'Request'),
      ...findAll(record.notes, text, 'notes', 'Notes')
    ]

    /**
     * The checklist is content too.
     *
     * What someone typed into "Schema or connection details" is often the most
     * specific thing in the whole record — a table name, a path — and it was
     * the one place search could not reach.
     */
    for (const item of record.checklist) {
      matches.push(
        ...findAll(item.value ?? '', text, `chk:${item.id}`, `Checklist — ${item.label}`),
        ...findAll(item.label, text, `chk:${item.id}`, 'Checklist')
      )
    }
    const matchedSections: string[] = []

    for (const s of record.sections) {
      const inSection = [
        ...findAll(s.title, text, s.ref, `${s.title} — title`),
        ...findAll(s.role, text, s.ref, `${s.title} — role`),
        ...findAll(s.brief, text, s.ref, `${s.title} — brief`),
        ...findAll(s.output ?? '', text, s.ref, `${s.title} — output`)
      ]
      if (inSection.length) {
        matchedSections.push(s.ref)
        matches.push(...inSection)
      }
    }

    if (!matches.length) continue
    hits.push({ record, sections: matchedSections, matches })
  }

  // Newest first. A review list is read from the top.
  return hits.sort((a, b) => b.record.createdAt - a.record.createdAt)
}

/** The distinct values present, so the filter selects only offer real options. */
export function filterOptions(records: TaskRecord[]): {
  sections: string[]
  statuses: string[]
  owners: string[]
} {
  const sections = new Set<string>()
  const statuses = new Set<string>()
  const owners = new Set<string>()

  for (const r of records) {
    statuses.add(r.status)
    for (const s of r.sections) {
      if (s.role) sections.add(s.role)
      statuses.add(s.status)
      owners.add(s.agentKind)
    }
  }

  return {
    sections: Array.from(sections).sort(),
    statuses: Array.from(statuses).sort(),
    owners: Array.from(owners).sort()
  }
}

/** Turn a live mission into the sections of its record. */
export function sectionsFromMission(mission: MissionState): TaskSection[] {
  return mission.steps.map((s) => ({
    ref: s.ref,
    title: s.title,
    role: s.role,
    agentKind: s.agentKind,
    brief: s.brief,
    status: s.status,
    output: s.output,
    note: s.note,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt
  }))
}

// ─── The store ──────────────────────────────────────────────────────────────

/**
 * Records kept.
 *
 * Bounded because this grows for the life of the install and nothing prunes it
 * otherwise. Two hundred is far more than anyone scrolls and still a small file.
 */
export const MAX_RECORDS = 200

let baseDir: string | null = null

export function configureRecords(dir: string): void {
  baseDir = dir
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.error('[records] could not create the store directory:', err)
  }
}

const file = (): string => path.join(baseDir ?? '', 'records.json')

/**
 * Read every record, degrading to empty on anything unreadable.
 *
 * Called from IPC handlers; a parse error here would take the panel down, and
 * "there is nothing recorded yet" is both recoverable and usually true.
 */
export function allRecords(): TaskRecord[] {
  if (!baseDir) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'))
    return Array.isArray(parsed) ? (parsed as TaskRecord[]) : []
  } catch {
    return []
  }
}

/**
 * Write atomically: temp, fsync, rename.
 *
 * Same reasoning as the Desk store. This file is the only record of what agents
 * produced; a truncated write from a crash or a sleep would lose the lot, and a
 * rename is atomic on both NTFS and POSIX.
 */
function writeAll(records: TaskRecord[]): void {
  if (!baseDir) return
  const target = file()
  const temp = `${target}.${process.pid}.tmp`
  try {
    const handle = fs.openSync(temp, 'w')
    fs.writeSync(handle, JSON.stringify(records.slice(0, MAX_RECORDS), null, 2))
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    fs.renameSync(temp, target)
  } catch (err) {
    console.error('[records] write failed:', err)
    try {
      fs.unlinkSync(temp)
    } catch {
      /* nothing to clean up */
    }
  }
}

export function getRecord(id: string): TaskRecord | null {
  return allRecords().find((r) => r.id === id) ?? null
}

/** Insert or replace, keeping the list newest-first. */
export function upsertRecord(record: TaskRecord): TaskRecord {
  const all = allRecords()
  const at = all.findIndex((r) => r.id === record.id)
  if (at >= 0) all[at] = record
  else all.unshift(record)
  all.sort((a, b) => b.createdAt - a.createdAt)
  writeAll(all)
  return record
}

/** Apply a partial change. Returns the updated record, or null if unknown. */
export function patchRecord(id: string, patch: Partial<TaskRecord>): TaskRecord | null {
  const all = allRecords()
  const at = all.findIndex((r) => r.id === id)
  if (at < 0) return null
  const next = { ...all[at], ...patch, id: all[at].id }
  all[at] = next
  writeAll(all)
  return next
}

/** Tick, untick, or answer one checklist item. */
export function setChecklistItem(
  id: string,
  itemId: string,
  patch: Partial<Pick<ChecklistItem, 'done' | 'value' | 'label' | 'required'>>
): TaskRecord | null {
  const record = getRecord(id)
  if (!record) return null
  return patchRecord(id, {
    checklist: record.checklist.map((i) => (i.id === itemId ? { ...i, ...patch } : i))
  })
}

/**
 * Settle records that a restart stranded.
 *
 * A mission lives in memory and dies with the process, so a record still marked
 * `running` when the app starts is describing a crew that no longer exists —
 * and it would sit there claiming to be in progress forever, skewing every
 * filter and every packet. Called once, at registration.
 *
 * Returns how many were settled.
 */
export function reconcileRunning(): number {
  const all = allRecords()
  let settled = 0

  for (const record of all) {
    if (record.status !== 'running' && record.status !== 'planned') continue
    record.status = 'aborted'
    record.finishedAt = record.finishedAt ?? Date.now()
    // Anything still pending never got the chance to run.
    for (const section of record.sections) {
      if (section.status === 'pending' || section.status === 'running') {
        section.status = 'blocked'
        section.note = section.note ?? 'Brutus closed before this section finished.'
      }
    }
    settled++
  }

  if (settled) writeAll(all)
  return settled
}

export function deleteRecord(id: string): boolean {
  const all = allRecords()
  const next = all.filter((r) => r.id !== id)
  if (next.length === all.length) return false
  writeAll(next)
  return true
}

export function removeSamples(): number {
  const all = allRecords()
  const next = all.filter((r) => !r.sample)
  writeAll(next)
  return all.length - next.length
}
