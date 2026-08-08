import {
  completion,
  isComplete,
  missingFields,
  validationWarnings,
  type TaskRecord
} from './records'

/**
 * BRUTUS Studio — the review packet.
 *
 * One file that answers "what did the agents actually do, and what should I not
 * trust?" without the reader having to open Brutus.
 *
 * ── WHY BOTH MARKDOWN AND JSON ─────────────────────────────────────────────
 * They are for different readers and neither substitutes for the other.
 * Markdown is what a person reviews — it opens anywhere, prints, and pastes into
 * a ticket. JSON is what a script checks. Producing both from one function means
 * they cannot disagree about what happened, which is the failure mode of
 * generating a report and an export separately.
 *
 * ── WHY THE WARNINGS COME BEFORE THE CONTENT ───────────────────────────────
 * A reader who scrolls to the sections first has already started believing them.
 * What is missing and what went wrong belong above the output they qualify, so
 * the caveats are read before the thing being caveated — not discovered in an
 * appendix afterwards.
 *
 * Pure: takes a record, returns strings. Tested without a filesystem.
 */

export interface Packet {
  /** Human-readable review document. */
  markdown: string
  /** The same content, structured. */
  json: string
  /** Suggested file name, without an extension. */
  filename: string
}

const STATUS_WORD: Record<string, string> = {
  planned: 'Planned',
  running: 'Still running',
  done: 'Completed',
  failed: 'Failed',
  aborted: 'Stopped',
  pending: 'Waiting',
  blocked: 'Blocked'
}

const when = (ms?: number): string => (ms ? new Date(ms).toLocaleString() : '—')

const duration = (from?: number, to?: number): string => {
  if (!from || !to || to < from) return '—'
  const secs = Math.round((to - from) / 1000)
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

/** A filesystem-safe stem from the task text. */
export function packetFilename(record: TaskRecord, now = new Date()): string {
  const slug =
    record.task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'agent-task'
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-')
  return `brutus-review-${slug}-${stamp}`
}

/**
 * Build the packet for one agent task.
 *
 * Everything judgemental — missing fields, warnings, completeness — is recomputed
 * here from the record rather than read off it, so a packet exported today
 * cannot report a verdict that was true last week.
 */
export function buildPacket(record: TaskRecord, now = new Date()): Packet {
  const missing = missingFields(record)
  const warnings = validationWarnings(record)
  const progress = completion(record)

  const L: string[] = []

  // ── Header ───────────────────────────────────────────────────────────────
  L.push(`# Agent task review`)
  L.push('')
  L.push(`**${record.summary || record.task}**`)
  L.push('')
  L.push(`| | |`)
  L.push(`| --- | --- |`)
  L.push(`| Request | ${escapeCell(record.task)} |`)
  L.push(`| Status | ${STATUS_WORD[record.status] ?? record.status} |`)
  L.push(`| Complexity | ${record.complexity} |`)
  L.push(`| Sections | ${record.sections.length} |`)
  L.push(`| Started | ${when(record.createdAt)} |`)
  L.push(`| Finished | ${when(record.finishedAt)} |`)
  L.push(`| Duration | ${duration(record.createdAt, record.finishedAt)} |`)
  L.push(`| Source checklist | ${progress.done} of ${progress.required} required inputs supplied |`)
  if (record.sample) L.push(`| Note | This is a seeded sample record, not a real run. |`)
  L.push('')

  // ── The caveats, before the content they qualify ─────────────────────────
  L.push(`## Validation warnings`)
  L.push('')
  if (warnings.length) {
    for (const w of warnings) L.push(`- ⚠️ ${w}`)
  } else {
    L.push('_None. Every section completed and the checklist was fully supplied._')
  }
  L.push('')

  L.push(`## Missing data`)
  L.push('')
  if (missing.length) {
    for (const m of missing) L.push(`- ❌ ${m}`)
  } else {
    L.push('_Nothing missing._')
  }
  L.push('')

  // ── Source checklist ─────────────────────────────────────────────────────
  L.push(`## Source checklist`)
  L.push('')
  if (record.checklist.length) {
    for (const item of record.checklist) {
      const box = item.done ? '[x]' : '[ ]'
      const flag = item.required ? '' : ' _(optional)_'
      L.push(`- ${box} **${item.label}**${flag}`)
      if (item.value?.trim()) L.push(`      ${item.value.trim()}`)
      else if (!item.done && item.hint) L.push(`      _${item.hint}_`)
    }
  } else {
    L.push('_No checklist was recorded for this task._')
  }
  L.push('')

  // ── The generated content ────────────────────────────────────────────────
  L.push(`## Sections`)
  L.push('')
  if (!record.sections.length) {
    L.push('_This task produced no sections._')
    L.push('')
  }
  for (const [i, s] of record.sections.entries()) {
    L.push(`### ${i + 1}. ${s.title} — ${s.role}`)
    L.push('')
    L.push(
      `\`${s.agentKind}\` · ${STATUS_WORD[s.status] ?? s.status} · ${duration(s.startedAt, s.finishedAt)}`
    )
    L.push('')
    if (s.brief?.trim()) {
      L.push(`**Brief**`)
      L.push('')
      L.push(`> ${s.brief.trim().replace(/\n/g, '\n> ')}`)
      L.push('')
    }
    L.push(`**Output**`)
    L.push('')
    if (s.output?.trim()) {
      L.push(s.output.trim())
    } else {
      L.push('_This section produced no output._')
    }
    L.push('')
    if (s.note?.trim()) {
      L.push(`**Note:** ${s.note.trim()}`)
      L.push('')
    }
  }

  // ── The human's own words, last ──────────────────────────────────────────
  L.push(`## Reviewer notes`)
  L.push('')
  L.push(record.notes?.trim() ? record.notes.trim() : '_No notes were added._')
  L.push('')

  L.push('---')
  L.push('')
  L.push(`Generated by BRUTUS Studio on ${now.toLocaleString()}.`)
  L.push('')

  const json = JSON.stringify(
    {
      generatedAt: now.toISOString(),
      record: {
        id: record.id,
        workspaceId: record.workspaceId,
        task: record.task,
        summary: record.summary,
        complexity: record.complexity,
        status: record.status,
        createdAt: record.createdAt,
        finishedAt: record.finishedAt,
        sample: Boolean(record.sample),
        notes: record.notes ?? ''
      },
      checklist: record.checklist,
      checklistComplete: isComplete(record),
      checklistProgress: progress,
      missingFields: missing,
      validationWarnings: warnings,
      sections: record.sections
    },
    null,
    2
  )

  return { markdown: L.join('\n'), json, filename: packetFilename(record, now) }
}

/** Pipes would break the header table. */
function escapeCell(text: string): string {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
}
