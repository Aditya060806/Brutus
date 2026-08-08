import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import {
  completion,
  missingFields,
  validationWarnings,
  type TaskRecord,
  type TaskSection
} from './records'

/**
 * BRUTUS Studio — the review packet as a PDF.
 *
 * The Markdown packet is for someone who already has a Markdown viewer and a
 * reason to trust it. The PDF is for everyone else: a reviewer, an assessor, a
 * judge — a reader who wants one file that opens identically everywhere, paginates,
 * prints, and looks like it was meant to be read rather than dumped.
 *
 * ── WHY IT IS BUILT, NOT CONVERTED ─────────────────────────────────────────
 * Rendering the Markdown through a converter would mean shipping a browser
 * engine or a CLI, and inheriting whatever that toolchain decides about page
 * breaks. Drawing it directly with `pdf-lib` — already a dependency — means the
 * layout is ours: a section never splits across a page mid-heading, the caveats
 * keep their colour, and long agent output wraps at a measured width instead of
 * running off the sheet.
 *
 * ── WHY THE FACTS ARE RECOMPUTED HERE ──────────────────────────────────────
 * Exactly as in `packet.ts`: missing fields, warnings and completeness are
 * derived from the record at render time, never read off it. A PDF handed to a
 * reviewer must not assert a verdict that stopped being true.
 *
 * ── ONE SOURCE OF TRUTH ────────────────────────────────────────────────────
 * This reads the same record and calls the same derivation helpers as the
 * Markdown and JSON builders, so the three cannot disagree about what happened.
 * The order of the document matches the Markdown deliberately: caveats above the
 * content they qualify.
 */

// ─── Brand ──────────────────────────────────────────────────────────────────

/** Brutus red. The one accent; everything else is greyscale so it stays classy. */
const ACCENT = rgb(0.769, 0.118, 0.227)
const INK = rgb(0.09, 0.09, 0.11)
const BODY = rgb(0.22, 0.22, 0.25)
const MUTED = rgb(0.45, 0.45, 0.5)
const HAIRLINE = rgb(0.87, 0.87, 0.89)
const PANEL = rgb(0.972, 0.972, 0.978)
const WARN = rgb(0.72, 0.45, 0.02)
const BAD = rgb(0.7, 0.13, 0.13)
const GOOD = rgb(0.05, 0.5, 0.32)

const PAGE_W = 595.28 // A4 portrait, points
const PAGE_H = 841.89
const MARGIN = 52
const CONTENT_W = PAGE_W - MARGIN * 2
/** Room kept at the foot of every page for the footer rule and page number. */
const FOOTER_SPACE = 54

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

/**
 * `pdf-lib`'s standard fonts are WinAnsi-encoded and throw on anything outside
 * it — so an em dash from a model, a curly quote, or an emoji in a task title
 * would abort the whole export. Everything drawn goes through here first.
 */
function ascii(text: string): string {
  return (
    String(text ?? '')
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
      .replace(/[\u2013\u2014\u2015]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u2022\u25CF\u25AA]/g, '-')
      .replace(/\t/g, '    ')
      // Anything still outside printable Latin-1 becomes a dot rather than a crash.
      .replace(/[^\x20-\x7E\xA1-\xFF\n]/g, '.')
  )
}

interface Ctx {
  doc: PDFDocument
  page: PDFPage
  /** Baseline cursor, measured from the top of the page downwards. */
  y: number
  regular: PDFFont
  bold: PDFFont
  mono: PDFFont
  pages: PDFPage[]
}

/** Split text to fit `width`, breaking long unbroken tokens rather than overflowing. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []
  for (const rawLine of ascii(text).split('\n')) {
    if (!rawLine.trim()) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of rawLine.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      // A single token wider than the column (a path, a URL, a hash).
      if (font.widthOfTextAtSize(word, size) > width) {
        let chunk = ''
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > width) {
            out.push(chunk)
            chunk = ch
          } else chunk += ch
        }
        line = chunk
      } else line = word
    }
    if (line) out.push(line)
  }
  return out
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H])
  ctx.pages.push(ctx.page)
  ctx.y = MARGIN
}

/** Reserve `height`; start a new page if it would not fit above the footer. */
function need(ctx: Ctx, height: number): void {
  if (ctx.y + height > PAGE_H - FOOTER_SPACE) newPage(ctx)
}

function text(
  ctx: Ctx,
  content: string,
  opts: {
    font?: PDFFont
    size?: number
    color?: ReturnType<typeof rgb>
    indent?: number
    lineGap?: number
    width?: number
  } = {}
): void {
  const font = opts.font ?? ctx.regular
  const size = opts.size ?? 10
  const indent = opts.indent ?? 0
  const gap = opts.lineGap ?? 4
  const width = opts.width ?? CONTENT_W - indent
  const lineHeight = size + gap

  for (const line of wrap(content, font, size, width)) {
    need(ctx, lineHeight)
    if (line) {
      ctx.page.drawText(line, {
        x: MARGIN + indent,
        y: PAGE_H - ctx.y - size,
        size,
        font,
        color: opts.color ?? BODY
      })
    }
    ctx.y += lineHeight
  }
}

function gap(ctx: Ctx, amount = 10): void {
  ctx.y += amount
}

function rule(ctx: Ctx, color = HAIRLINE): void {
  need(ctx, 8)
  ctx.page.drawRectangle({
    x: MARGIN,
    y: PAGE_H - ctx.y,
    width: CONTENT_W,
    height: 0.75,
    color
  })
  ctx.y += 8
}

/** Section heading: a red tick, the title, and a hairline under it. */
function heading(ctx: Ctx, label: string): void {
  // Kept with what follows, so a heading is never the last thing on a page.
  need(ctx, 62)
  gap(ctx, 6)
  ctx.page.drawRectangle({
    x: MARGIN,
    y: PAGE_H - ctx.y - 11,
    width: 3,
    height: 13,
    color: ACCENT
  })
  ctx.page.drawText(ascii(label).toUpperCase(), {
    x: MARGIN + 11,
    y: PAGE_H - ctx.y - 10,
    size: 10.5,
    font: ctx.bold,
    color: INK
  })
  ctx.y += 18
  rule(ctx)
}

/** A key/value row with the label in a fixed left column. */
function row(ctx: Ctx, label: string, value: string, valueColor = BODY): void {
  const labelW = 118
  const lines = wrap(value, ctx.regular, 9.5, CONTENT_W - labelW)
  need(ctx, Math.max(14, lines.length * 13))
  ctx.page.drawText(ascii(label), {
    x: MARGIN,
    y: PAGE_H - ctx.y - 9.5,
    size: 9.5,
    font: ctx.bold,
    color: MUTED
  })
  let first = true
  for (const line of lines) {
    if (!first) need(ctx, 13)
    ctx.page.drawText(line, {
      x: MARGIN + labelW,
      y: PAGE_H - ctx.y - 9.5,
      size: 9.5,
      font: ctx.regular,
      color: valueColor
    })
    ctx.y += 13
    first = false
  }
}

/** A bullet whose marker carries the meaning: warning, missing, or fine. */
function bullet(ctx: Ctx, content: string, tone: 'warn' | 'bad' | 'good' | 'plain'): void {
  const color = tone === 'warn' ? WARN : tone === 'bad' ? BAD : tone === 'good' ? GOOD : BODY
  const marker = tone === 'warn' ? '!' : tone === 'bad' ? 'x' : tone === 'good' ? 'ok' : '-'
  const indent = 18
  const lines = wrap(content, ctx.regular, 9.5, CONTENT_W - indent)
  need(ctx, Math.max(14, lines.length * 13.5))
  ctx.page.drawText(marker, {
    x: MARGIN + 2,
    y: PAGE_H - ctx.y - 9.5,
    size: 8.5,
    font: ctx.bold,
    color
  })
  let first = true
  for (const line of lines) {
    if (!first) need(ctx, 13.5)
    ctx.page.drawText(line, {
      x: MARGIN + indent,
      y: PAGE_H - ctx.y - 9.5,
      size: 9.5,
      font: ctx.regular,
      color: BODY
    })
    ctx.y += 13.5
    first = false
  }
}

/** Agent output, in a tinted monospace panel so it reads as machine-produced. */
function codePanel(ctx: Ctx, content: string): void {
  const size = 8.5
  const pad = 8
  const lines = wrap(content, ctx.mono, size, CONTENT_W - pad * 2)
  for (const line of lines) {
    const lineHeight = size + 3.5
    need(ctx, lineHeight)
    ctx.page.drawRectangle({
      x: MARGIN,
      y: PAGE_H - ctx.y - lineHeight + 2,
      width: CONTENT_W,
      height: lineHeight,
      color: PANEL
    })
    if (line) {
      ctx.page.drawText(line, {
        x: MARGIN + pad,
        y: PAGE_H - ctx.y - size,
        size,
        font: ctx.mono,
        color: INK
      })
    }
    ctx.y += lineHeight
  }
}

/** The cover band: wordmark, title, and the sample stamp when it applies. */
function cover(ctx: Ctx, record: TaskRecord, now: Date): void {
  ctx.page.drawRectangle({
    x: 0,
    y: PAGE_H - 132,
    width: PAGE_W,
    height: 132,
    color: rgb(0.055, 0.055, 0.067)
  })
  ctx.page.drawRectangle({ x: 0, y: PAGE_H - 132, width: PAGE_W, height: 3, color: ACCENT })

  ctx.page.drawText('BRUTUS', {
    x: MARGIN,
    y: PAGE_H - 52,
    size: 21,
    font: ctx.bold,
    color: rgb(1, 1, 1)
  })
  ctx.page.drawText('STUDIO', {
    x: MARGIN + 84,
    y: PAGE_H - 52,
    size: 21,
    font: ctx.regular,
    color: ACCENT
  })
  ctx.page.drawText('AI ORCHESTRATION ENGINE', {
    x: MARGIN,
    y: PAGE_H - 68,
    size: 7,
    font: ctx.regular,
    color: rgb(0.62, 0.62, 0.66)
  })

  ctx.page.drawText('AGENT TASK REVIEW', {
    x: MARGIN,
    y: PAGE_H - 104,
    size: 12.5,
    font: ctx.bold,
    color: rgb(1, 1, 1)
  })
  const stamp = ascii(now.toLocaleString())
  ctx.page.drawText(stamp, {
    x: PAGE_W - MARGIN - ctx.regular.widthOfTextAtSize(stamp, 8.5),
    y: PAGE_H - 103,
    size: 8.5,
    font: ctx.regular,
    color: rgb(0.62, 0.62, 0.66)
  })

  ctx.y = 152

  // A sample record must never be mistaken for a real run, least of all in a
  // file that outlives the app and gets forwarded on.
  if (record.sample) {
    need(ctx, 30)
    ctx.page.drawRectangle({
      x: MARGIN,
      y: PAGE_H - ctx.y - 20,
      width: CONTENT_W,
      height: 24,
      color: rgb(1, 0.973, 0.898)
    })
    ctx.page.drawRectangle({
      x: MARGIN,
      y: PAGE_H - ctx.y - 20,
      width: 3,
      height: 24,
      color: WARN
    })
    ctx.page.drawText('SAMPLE RECORD - seeded for demonstration, not a real agent run.', {
      x: MARGIN + 11,
      y: PAGE_H - ctx.y - 13,
      size: 9,
      font: ctx.bold,
      color: WARN
    })
    ctx.y += 34
  }
}

function sectionBlock(ctx: Ctx, s: TaskSection, index: number): void {
  // Enough for the title, the meta line and a first line of content, so a
  // section header never sits alone at the bottom of a page.
  need(ctx, 78)
  gap(ctx, 8)

  const title = `${index + 1}. ${s.title}`
  text(ctx, title, { font: ctx.bold, size: 11, color: INK, lineGap: 3 })

  const statusColor =
    s.status === 'failed' ? BAD : s.status === 'done' ? GOOD : s.status === 'blocked' ? WARN : MUTED
  const meta = `${s.role}  ·  ${s.agentKind}  ·  ${STATUS_WORD[s.status] ?? s.status}  ·  ${duration(s.startedAt, s.finishedAt)}`
  text(ctx, meta, { size: 8.5, color: statusColor, lineGap: 4 })
  gap(ctx, 4)

  if (s.brief?.trim()) {
    text(ctx, 'Brief', { font: ctx.bold, size: 9, color: MUTED, lineGap: 3 })
    text(ctx, s.brief.trim(), { size: 9.5, indent: 10, color: BODY })
    gap(ctx, 6)
  }

  text(ctx, 'Output', { font: ctx.bold, size: 9, color: MUTED, lineGap: 3 })
  if (s.output?.trim()) {
    codePanel(ctx, s.output.trim())
  } else {
    text(ctx, 'This section produced no output.', { size: 9.5, indent: 10, color: BAD })
  }

  if (s.note?.trim()) {
    gap(ctx, 5)
    text(ctx, `Note: ${s.note.trim()}`, { size: 9, indent: 10, color: MUTED })
  }
  gap(ctx, 6)
}

/**
 * Render the review packet for one agent task.
 *
 * Returns the raw PDF bytes; the caller decides where they land.
 */
export async function buildPacketPdf(record: TaskRecord, now = new Date()): Promise<Uint8Array> {
  const missing = missingFields(record)
  const warnings = validationWarnings(record)
  const progress = completion(record)

  // `updateMetadata: false` stops pdf-lib stamping itself as the Producer and
  // Creator. Left at the default, a document handed to a reviewer arrives
  // labelled as generic library output rather than as a Brutus report.
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setTitle(ascii(`Brutus agent task review - ${record.summary || record.task}`))
  doc.setSubject('Agent task review packet')
  doc.setCreator('BRUTUS Studio')
  doc.setProducer('BRUTUS Studio')
  doc.setCreationDate(now)

  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: MARGIN,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    pages: []
  }
  ctx.pages.push(ctx.page)

  cover(ctx, record, now)

  // ── The request ──────────────────────────────────────────────────────────
  text(ctx, record.summary || record.task, { font: ctx.bold, size: 14, color: INK, lineGap: 5 })
  gap(ctx, 8)

  heading(ctx, 'Overview')
  row(ctx, 'Request', record.task)
  row(ctx, 'Status', STATUS_WORD[record.status] ?? record.status)
  row(ctx, 'Complexity', String(record.complexity))
  row(ctx, 'Sections', String(record.sections.length))
  row(ctx, 'Started', when(record.createdAt))
  row(ctx, 'Finished', when(record.finishedAt))
  row(ctx, 'Duration', duration(record.createdAt, record.finishedAt))
  row(
    ctx,
    'Checklist',
    `${progress.done} of ${progress.required} required inputs supplied`,
    progress.done < progress.required ? WARN : GOOD
  )
  gap(ctx, 6)

  // ── Caveats first, exactly as in the Markdown packet ─────────────────────
  heading(ctx, 'Validation warnings')
  if (warnings.length) {
    for (const w of warnings) bullet(ctx, w, 'warn')
  } else {
    bullet(ctx, 'None. Every section completed and the checklist was fully supplied.', 'good')
  }

  heading(ctx, 'Missing data')
  if (missing.length) {
    for (const m of missing) bullet(ctx, m, 'bad')
  } else {
    bullet(ctx, 'Nothing missing.', 'good')
  }

  // ── Inputs ───────────────────────────────────────────────────────────────
  heading(ctx, 'Source checklist')
  if (record.checklist.length) {
    for (const item of record.checklist) {
      const label = `${item.label}${item.required ? '' : '  (optional)'}`
      bullet(ctx, label, item.done ? 'good' : item.required ? 'bad' : 'plain')
      const detail = item.value?.trim() || (!item.done ? item.hint?.trim() : '')
      if (detail) text(ctx, detail, { size: 8.5, indent: 30, color: MUTED, lineGap: 3 })
    }
  } else {
    bullet(ctx, 'No checklist was recorded for this task.', 'plain')
  }

  // ── What the agents produced ─────────────────────────────────────────────
  heading(ctx, 'Sections')
  if (!record.sections.length) {
    bullet(ctx, 'This task produced no sections.', 'bad')
  }
  for (const [i, s] of record.sections.entries()) sectionBlock(ctx, s, i)

  // ── The reviewer's own words ─────────────────────────────────────────────
  heading(ctx, 'Reviewer notes')
  text(ctx, record.notes?.trim() || 'No notes were added.', {
    size: 9.5,
    color: record.notes?.trim() ? BODY : MUTED
  })

  // ── Footers, once the page count is final ────────────────────────────────
  const total = ctx.pages.length
  ctx.pages.forEach((page, i) => {
    page.drawRectangle({
      x: MARGIN,
      y: 40,
      width: CONTENT_W,
      height: 0.75,
      color: HAIRLINE
    })
    page.drawText('BRUTUS Studio - agent task review', {
      x: MARGIN,
      y: 27,
      size: 7.5,
      font: ctx.regular,
      color: MUTED
    })
    if (record.sample) {
      const tag = 'SAMPLE'
      page.drawText(tag, {
        x: PAGE_W / 2 - ctx.bold.widthOfTextAtSize(tag, 7.5) / 2,
        y: 27,
        size: 7.5,
        font: ctx.bold,
        color: WARN
      })
    }
    const label = `${i + 1} / ${total}`
    page.drawText(label, {
      x: PAGE_W - MARGIN - ctx.regular.widthOfTextAtSize(label, 7.5),
      y: 27,
      size: 7.5,
      font: ctx.regular,
      color: MUTED
    })
  })

  return doc.save()
}
