import { IpcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { GoogleGenAI } from '@google/genai'
import { fetchImage } from '../logic/image-search'
import { findSoffice, convertWithLibreOffice } from '../logic/libreoffice'

/**
 * BRUTUS DECK STUDIO — Presentation Intelligence Engine.
 * ------------------------------------------------------
 * The LLM produces a strict DeckSpec (palette, fonts, per-slide layout + copy);
 * this deterministic pptxgenjs engine renders a submission-ready .pptx with
 * overflow-safe text (fit:'shrink'), native charts/shapes, an emoji-in-circle
 * icon motif, scraped contextual images, and banned-pattern compliance.
 */

// ─── Enhanced system prompt (DeckSpec generator) ──────────────────────
export const DECK_STUDIO_PROMPT = `
You are BRUTUS DECK STUDIO — an elite AI presentation architect producing world-class, submission-ready decks rivaling Canva Premium, Pitch, Gamma, Beautiful.ai and top design agencies. You DESIGN a complete visual communication experience that needs zero manual edits before submission.

You output ONLY a single JSON object (the "DeckSpec") — no markdown, no commentary. The rendering engine turns it into a .pptx, so follow the schema exactly.

# PLANNING (do this internally before emitting JSON)
- Infer: goal (persuade/inform/sell/report/teach), audience, technical depth, category (Investor/Technical/Corporate/Academic/Startup/Marketing/Research/Educational/Executive), industry, and slide count (default 10–14, scale to content).
- Build a narrative arc, adapted to category: Cover → Agenda → Problem/Landscape → Research/Market → Solution → How it works/Architecture → Features/Tech → Results/Data → Advantages → Business/Roadmap → Impact/Demo → Conclusion → References.
- EVERY slide communicates exactly ONE idea. Rewrite source paragraphs into crisp cards/bullets/stats/comparisons/timelines — never copy long prose.
- NEVER invent statistics, quotes, or sources. If unsure, omit or note uncertainty in "notes".

# DESIGN SYSTEM
- COLOR: invent ONE cohesive, topic-specific palette (hex). One dominant color (60–70% weight), 1–2 supporting, one sharp accent. It must feel wrong on a different topic. Never default to generic blue or cream/beige. Dark cover/closing + light content ("sandwich"), or commit to dark throughout.
- TYPOGRAPHY: choose style "sans" (modern) or "serif" (academic). One consistent hierarchy.
- ICONS: pick relevant icon names from this set ONLY (one consistent feel): rocket, bulb, chart, gear, shield, check, star, target, brain, cloud, lock, bolt, globe, code, money, users, clock, flag, trophy, warning, search, link, fire, leaf, heart, phone, mail, doc, flask, graph, eye, map, book, cart, calendar.
- LAYOUT VARIETY: never repeat a layout on consecutive slides. Every slide has a visual (image/chart/icon/diagram). No text-only slides.
- IMAGES: for slides that benefit, give a precise, specific "image.query" (real-world searchable terms, contextually exact — not generic filler).

# BANNED (hard): no title underlines/accent stripes/edge bars; no centered body text; no cream/beige backgrounds; no repeated consecutive layouts; no text-only slides; no typed "•" bullets (the engine adds real bullets — give plain strings); no invented data.

# OUTPUT SCHEMA (emit exactly this shape)
{
  "meta": { "title": str, "subtitle": str, "category": str, "audience": str },
  "theme": {
    "mode": "dark" | "light" | "sandwich",
    "fontStyle": "sans" | "serif",
    "palette": { "primary": "#hex", "secondary": "#hex", "accent": "#hex", "bg": "#hex", "bgAlt": "#hex", "card": "#hex", "text": "#hex", "muted": "#hex", "chart": ["#hex","#hex","#hex","#hex"] }
  },
  "slides": [
    {
      "layout": "cover|agenda|section|split|bullets|cards|bigstat|comparison|timeline|quote|chart|image|closing",
      "title": str,
      "subtitle": str (optional),
      "body": str (optional, short),
      "items": [str] (for agenda/bullets — short lines),
      "cards": [ {"icon": str, "title": str, "text": str} ] (3–6, for cards),
      "stats": [ {"value": str, "label": str} ] (1–4, for bigstat),
      "comparison": { "headers": [str,str], "rows": [ {"feature": str, "a": str, "b": str} ] },
      "timeline": [ {"label": str, "text": str} ] (3–5),
      "quote": { "text": str, "author": str },
      "chart": { "type": "bar|line|pie|doughnut|area", "categories": [str], "series": [ {"name": str, "data": [num] } ] },
      "image": { "query": str, "side": "left|right|bg" } (optional),
      "icon": str (optional, for section/cover),
      "notes": str (speaker notes; put any source citations here)
    }
  ],
  "references": [str] (optional; sources you cited)
}

# RULES OF THUMB
- cover: 1st slide. closing: last (thank you / CTA / contact). Use section dividers for major parts.
- bullets/agenda: ≤6 short items. cards: 3–6. stats: 1–4. comparison rows: ≤6. timeline: 3–5.
- Keep titles ≤ 8 words; card/bullet text ≤ ~16 words. Be punchy and concrete.
- Add meaningful "notes" to every content slide.
# TWO-MODE SYSTEM (never blend on one slide)
- ART/DIVIDER MODE: cover, section, closing — oversized type, minimal body, at most one image. 
- CONTENT MODE: agenda, bullets, cards, bigstat, comparison, timeline, chart, split, image — structured grid, concise copy, a clear visual. 
Never put dense multi-column body text under an oversized art heading.

# CONCISION (the renderer shrink-fits text, so keep it tight)
- Titles ≤ 8 words. Bullets/card text ≤ ~14 words each. Stats are short ("87%", "3x"). Overly long strings get auto-shrunk and look weak — be punchy.

Emit the DeckSpec JSON now.
`

// ─── geometry / theme ─────────────────────────────────────────────────
const PW = 13.333
const PH = 7.5
const M = 0.6 // margin

const hx = (c?: string): string => (c || '').replace('#', '').trim() || '111111'

interface Theme {
  mode: string
  heading: string
  body: string
  serif: boolean
  primary: string
  secondary: string
  accent: string
  bg: string
  bgAlt: string
  card: string
  text: string
  muted: string
  chart: string[]
}

function buildTheme(spec: any): Theme {
  const p = spec?.theme?.palette || {}
  const serif = spec?.theme?.fontStyle === 'serif'
  return {
    mode: spec?.theme?.mode || 'sandwich',
    heading: serif ? 'Georgia' : 'Segoe UI Semibold',
    body: serif ? 'Georgia' : 'Segoe UI',
    serif,
    primary: hx(p.primary) || '2563EB',
    secondary: hx(p.secondary) || '7C3AED',
    accent: hx(p.accent) || 'F59E0B',
    bg: hx(p.bg) || 'FFFFFF',
    bgAlt: hx(p.bgAlt) || '0F172A',
    card: hx(p.card) || 'F1F5F9',
    text: hx(p.text) || '0F172A',
    muted: hx(p.muted) || '64748B',
    chart:
      Array.isArray(p.chart) && p.chart.length
        ? p.chart.map((c: string) => hx(c))
        : [hx(p.primary) || '2563EB', hx(p.secondary) || '7C3AED', hx(p.accent) || 'F59E0B', '94A3B8']
  }
}

const ICONS: Record<string, string> = {
  rocket: '🚀', bulb: '💡', chart: '📊', gear: '⚙️', shield: '🛡️', check: '✅', star: '⭐',
  target: '🎯', brain: '🧠', cloud: '☁️', lock: '🔒', bolt: '⚡', globe: '🌐', code: '💻',
  money: '💰', users: '👥', clock: '⏱️', flag: '🚩', trophy: '🏆', warning: '⚠️', search: '🔍',
  link: '🔗', fire: '🔥', leaf: '🌱', heart: '❤️', phone: '📱', mail: '✉️', doc: '📄',
  flask: '🧪', graph: '📈', eye: '👁️', map: '🗺️', book: '📖', cart: '🛒', calendar: '📅'
}
const iconOf = (name?: string): string => ICONS[(name || '').toLowerCase()] || '✦'

// is the current slide background dark? (for text contrast)
const isDark = (hexColor: string): boolean => {
  const n = parseInt(hexColor, 16)
  if (isNaN(n)) return false
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}

// ─── DeckSpec generation ──────────────────────────────────────────────
async function generateSpec(
  ai: any,
  content: string,
  instructions: string,
  slideCount?: number
): Promise<any> {
  const ask = `${DECK_STUDIO_PROMPT}

# USER INSTRUCTIONS
${instructions || '(none)'}

# TARGET SLIDE COUNT
${slideCount ? slideCount : 'auto (10–14)'}

# SOURCE CONTENT
${(content || '').slice(0, 24000) || '(none provided — design from the instructions and your knowledge; do not invent specific statistics.)'}
`
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: ask,
    config: { responseMimeType: 'application/json', temperature: 0.75 }
  })
  let txt = (res.text || '{}').replace(/^```json/i, '').replace(/```$/i, '').trim()
  return JSON.parse(txt)
}

// ─── render helpers ───────────────────────────────────────────────────
interface Ctx {
  pptx: any
  T: Theme
  bg: string
  text: string
  muted: string
}

function pageColors(T: Theme, layout: string): { bg: string; text: string; muted: string } {
  const dark = ['cover', 'section', 'closing'].includes(layout) || T.mode === 'dark'
  const bg = dark ? T.bgAlt : T.bg
  const onDark = isDark(bg)
  return {
    bg,
    text: onDark ? 'F8FAFC' : T.text,
    muted: onDark ? 'CBD5E1' : T.muted
  }
}

function iconCircle(ctx: Ctx, slide: any, x: number, y: number, d: number, emoji: string, fill?: string) {
  slide.addShape(ctx.pptx.ShapeType.ellipse, {
    x, y, w: d, h: d,
    fill: { color: fill || ctx.T.primary },
    line: { type: 'none' },
    shadow: { type: 'outer', color: '000000', blur: 6, offset: 2, angle: 90, opacity: 0.25 }
  })
  slide.addText(emoji, {
    x, y, w: d, h: d, align: 'center', valign: 'middle',
    fontSize: Math.round(d * 15), fontFace: 'Segoe UI Emoji'
  })
}

function card(ctx: Ctx, slide: any, x: number, y: number, w: number, h: number, tint?: string) {
  slide.addShape(ctx.pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.1,
    fill: { color: tint || ctx.T.card },
    line: { type: 'none' },
    shadow: { type: 'outer', color: '000000', blur: 9, offset: 2, angle: 90, opacity: 0.16 }
  })
}

function titleBar(ctx: Ctx, slide: any, title: string, subtitle?: string) {
  slide.addText(title || '', {
    x: M, y: 0.45, w: PW - 2 * M, h: subtitle ? 0.85 : 1.05,
    fontSize: 32, bold: true, color: ctx.text, fontFace: ctx.T.heading,
    align: 'left', valign: 'middle', fit: 'shrink', wrap: true
  })
  if (subtitle) {
    slide.addText(subtitle, {
      x: M, y: 1.25, w: PW - 2 * M, h: 0.5,
      fontSize: 15, color: ctx.muted, fontFace: ctx.T.body, align: 'left', fit: 'shrink', wrap: true
    })
  }
}

// ─── layouts ──────────────────────────────────────────────────────────
function layoutCover(ctx: Ctx, slide: any, s: any, img: string | null) {
  if (img) {
    slide.addImage({ path: img, x: PW / 2, y: 0, w: PW / 2, h: PH, sizing: { type: 'cover', w: PW / 2, h: PH } })
    slide.addShape(ctx.pptx.ShapeType.rect, { x: PW / 2, y: 0, w: PW / 2, h: PH, fill: { color: ctx.bg, transparency: 35 }, line: { type: 'none' } })
  }
  const tw = img ? PW / 2 - M * 1.5 : PW - 2 * M
  slide.addShape(ctx.pptx.ShapeType.roundRect, { x: M, y: 3.05, w: 0.7, h: 0.14, rectRadius: 0.07, fill: { color: ctx.T.accent }, line: { type: 'none' } })
  slide.addText(s.title || ctx.T && '', {
    x: M, y: 2.0, w: tw, h: 1.0, fontSize: 13, bold: true, color: ctx.T.accent, fontFace: ctx.T.body,
    charSpacing: 3, fit: 'shrink'
  })
  slide.addText(s.title || '', {
    x: M, y: 2.9, w: tw, h: 2.0, fontSize: 46, bold: true, color: ctx.text, fontFace: ctx.T.heading,
    valign: 'top', fit: 'shrink', wrap: true
  })
  if (s.subtitle) {
    slide.addText(s.subtitle, {
      x: M, y: 4.9, w: tw, h: 1.2, fontSize: 18, color: ctx.muted, fontFace: ctx.T.body, fit: 'shrink', wrap: true
    })
  }
}

function layoutSection(ctx: Ctx, slide: any, s: any, _img: string | null) {
  iconCircle(ctx, slide, M, 2.7, 1.0, iconOf(s.icon || 'star'), ctx.T.primary)
  slide.addText(s.title || '', {
    x: M, y: 3.9, w: PW - 2 * M, h: 1.6, fontSize: 40, bold: true, color: ctx.text, fontFace: ctx.T.heading, fit: 'shrink', wrap: true
  })
  if (s.subtitle) {
    slide.addText(s.subtitle, { x: M, y: 5.4, w: PW - 2 * M, h: 0.9, fontSize: 16, color: ctx.muted, fontFace: ctx.T.body, fit: 'shrink', wrap: true })
  }
}

function layoutAgenda(ctx: Ctx, slide: any, s: any, _img: string | null) {
  titleBar(ctx, slide, s.title || 'Agenda', s.subtitle)
  const items: string[] = (s.items || []).slice(0, 6)
  const top = 1.9
  const rh = (PH - top - M) / Math.max(items.length, 1)
  items.forEach((it, i) => {
    const y = top + i * rh
    iconCircle(ctx, slide, M, y + rh / 2 - 0.28, 0.56, String(i + 1) as any, ctx.T.primary)
    slide.addText(String(i + 1), { x: M, y: y + rh / 2 - 0.28, w: 0.56, h: 0.56, align: 'center', valign: 'middle', color: 'FFFFFF', bold: true, fontSize: 18, fontFace: ctx.T.heading })
    slide.addText(it, { x: M + 0.8, y, w: PW - 2 * M - 0.8, h: rh, valign: 'middle', fontSize: 18, color: ctx.text, fontFace: ctx.T.body, fit: 'shrink', wrap: true })
  })
}

function layoutBullets(ctx: Ctx, slide: any, s: any, img: string | null) {
  titleBar(ctx, slide, s.title, s.subtitle)
  const hasImg = !!img
  const colW = hasImg ? (PW - 2 * M) * 0.55 : PW - 2 * M
  const items: string[] = (s.items || (s.body ? [s.body] : [])).slice(0, 6)
  const textObjs = items.map((t) => ({ text: String(t), options: { bullet: { code: '2022', indent: 18 }, color: ctx.text, paraSpaceAfter: 10 } }))
  slide.addText(textObjs.length ? textObjs : [{ text: s.body || '' }], {
    x: M, y: 1.95, w: colW, h: PH - 1.95 - M, fontSize: 17, color: ctx.text, fontFace: ctx.T.body,
    valign: 'top', fit: 'shrink', wrap: true, lineSpacingMultiple: 1.15
  })
  if (hasImg) {
    const ix = M + colW + 0.4
    const iw = PW - M - ix
    slide.addImage({ path: img!, x: ix, y: 1.95, w: iw, h: PH - 1.95 - M, rounding: true, sizing: { type: 'cover', w: iw, h: PH - 1.95 - M } })
  }
}

function layoutCards(ctx: Ctx, slide: any, s: any, _img: string | null) {
  titleBar(ctx, slide, s.title, s.subtitle)
  const cards: any[] = (s.cards || []).slice(0, 6)
  const n = cards.length || 1
  const cols = n <= 3 ? n : n === 4 ? 2 : 3
  const rows = Math.ceil(n / cols)
  const top = 1.95
  const gap = 0.3
  const areaW = PW - 2 * M
  const areaH = PH - top - M
  const cw = (areaW - gap * (cols - 1)) / cols
  const ch = (areaH - gap * (rows - 1)) / rows
  cards.forEach((c, i) => {
    const r = Math.floor(i / cols)
    const col = i % cols
    const x = M + col * (cw + gap)
    const y = top + r * (ch + gap)
    card(ctx, slide, x, y, cw, ch, ctx.T.card)
    iconCircle(ctx, slide, x + 0.3, y + 0.3, 0.62, iconOf(c.icon), ctx.T.primary)
    const cardDark = isDark(ctx.T.card)
    const ctext = cardDark ? 'F8FAFC' : ctx.T.text
    const cmuted = cardDark ? 'CBD5E1' : ctx.T.muted
    slide.addText(c.title || '', { x: x + 0.3, y: y + 1.05, w: cw - 0.6, h: 0.5, fontSize: 16, bold: true, color: ctext, fontFace: ctx.T.heading, fit: 'shrink', wrap: true })
    slide.addText(c.text || '', { x: x + 0.3, y: y + 1.55, w: cw - 0.6, h: ch - 1.75, fontSize: 12.5, color: cmuted, fontFace: ctx.T.body, valign: 'top', fit: 'shrink', wrap: true })
  })
}

function layoutBigstat(ctx: Ctx, slide: any, s: any, _img: string | null) {
  titleBar(ctx, slide, s.title, s.subtitle)
  const stats: any[] = (s.stats || []).slice(0, 4)
  const n = stats.length || 1
  const top = 2.4
  const gap = 0.4
  const cw = (PW - 2 * M - gap * (n - 1)) / n
  const ch = 3.2
  stats.forEach((st, i) => {
    const x = M + i * (cw + gap)
    card(ctx, slide, x, top, cw, ch, ctx.T.card)
    const cardDark = isDark(ctx.T.card)
    slide.addText(String(st.value ?? ''), { x: x + 0.2, y: top + 0.5, w: cw - 0.4, h: 1.6, align: 'center', valign: 'middle', fontSize: 54, bold: true, color: ctx.T.primary, fontFace: ctx.T.heading, fit: 'shrink' })
    slide.addText(String(st.label ?? ''), { x: x + 0.2, y: top + 2.1, w: cw - 0.4, h: 0.9, align: 'center', valign: 'top', fontSize: 15, color: cardDark ? 'CBD5E1' : ctx.T.muted, fontFace: ctx.T.body, fit: 'shrink', wrap: true })
  })
}

function layoutComparison(ctx: Ctx, slide: any, s: any, _img: string | null) {
  titleBar(ctx, slide, s.title, s.subtitle)
  const cmp = s.comparison || { headers: ['A', 'B'], rows: [] }
  const rows: any[] = []
  const headFill = ctx.T.primary
  rows.push([
    { text: cmp.feature_label || 'Aspect', options: { bold: true, color: 'FFFFFF', fill: { color: ctx.T.secondary }, fontFace: ctx.T.heading } },
    { text: String(cmp.headers?.[0] || 'Option A'), options: { bold: true, color: 'FFFFFF', fill: { color: headFill }, fontFace: ctx.T.heading } },
    { text: String(cmp.headers?.[1] || 'Option B'), options: { bold: true, color: 'FFFFFF', fill: { color: headFill }, fontFace: ctx.T.heading } }
  ])
  ;(cmp.rows || []).slice(0, 7).forEach((r: any, idx: number) => {
    const zebra = idx % 2 === 0 ? ctx.T.card : ctx.T.bg
    rows.push([
      { text: String(r.feature ?? ''), options: { bold: true, color: ctx.T.text, fill: { color: zebra } } },
      { text: String(r.a ?? ''), options: { color: ctx.T.text, fill: { color: zebra } } },
      { text: String(r.b ?? ''), options: { color: ctx.T.text, fill: { color: zebra } } }
    ])
  })
  slide.addTable(rows, {
    x: M, y: 2.0, w: PW - 2 * M, h: PH - 2.0 - M,
    fontFace: ctx.T.body, fontSize: 13, valign: 'middle', border: { type: 'solid', pt: 0.5, color: 'D7DCE3' },
    align: 'left', autoPage: false
  })
}

function layoutTimeline(ctx: Ctx, slide: any, s: any, _img: string | null) {
  titleBar(ctx, slide, s.title, s.subtitle)
  const steps: any[] = (s.timeline || []).slice(0, 5)
  const n = steps.length || 1
  const top = 3.4
  const usableW = PW - 2 * M
  const step = usableW / n
  // connector line
  slide.addShape(ctx.pptx.ShapeType.line, { x: M + step / 2, y: top, w: usableW - step, h: 0, line: { color: ctx.T.muted, width: 1.5, dashType: 'dash' } })
  steps.forEach((st, i) => {
    const cx = M + step * i + step / 2
    iconCircle(ctx, slide, cx - 0.32, top - 0.32, 0.64, String(i + 1) as any, ctx.T.primary)
    slide.addText(String(i + 1), { x: cx - 0.32, y: top - 0.32, w: 0.64, h: 0.64, align: 'center', valign: 'middle', color: 'FFFFFF', bold: true, fontSize: 18 })
    slide.addText(st.label || '', { x: cx - step / 2 + 0.1, y: top - 1.35, w: step - 0.2, h: 0.9, align: 'center', valign: 'bottom', fontSize: 15, bold: true, color: ctx.text, fontFace: ctx.T.heading, fit: 'shrink', wrap: true })
    slide.addText(st.text || '', { x: cx - step / 2 + 0.1, y: top + 0.5, w: step - 0.2, h: 1.6, align: 'center', valign: 'top', fontSize: 12, color: ctx.muted, fontFace: ctx.T.body, fit: 'shrink', wrap: true })
  })
}

function layoutQuote(ctx: Ctx, slide: any, s: any, _img: string | null) {
  const q = s.quote || { text: s.body || '', author: '' }
  slide.addText('“', { x: M, y: 1.2, w: 2, h: 2, fontSize: 120, bold: true, color: ctx.T.accent, fontFace: 'Georgia' })
  slide.addText(q.text || '', { x: M + 0.2, y: 2.6, w: PW - 2 * M - 0.4, h: 2.6, fontSize: 30, italic: true, color: ctx.text, fontFace: 'Georgia', valign: 'middle', fit: 'shrink', wrap: true })
  if (q.author) {
    slide.addText(`— ${q.author}`, { x: M + 0.2, y: 5.4, w: PW - 2 * M, h: 0.7, fontSize: 17, bold: true, color: ctx.T.primary, fontFace: ctx.T.heading, fit: 'shrink' })
  }
}

function layoutChart(ctx: Ctx, slide: any, s: any, _img: string | null) {
  titleBar(ctx, slide, s.title, s.subtitle)
  const c = s.chart
  if (!c || !Array.isArray(c.series) || !c.series.length) {
    slide.addText('No chart data provided.', { x: M, y: 3, w: PW - 2 * M, h: 1, align: 'center', color: ctx.muted })
    return
  }
  const typeMap: Record<string, any> = {
    bar: ctx.pptx.ChartType.bar, line: ctx.pptx.ChartType.line, pie: ctx.pptx.ChartType.pie,
    doughnut: ctx.pptx.ChartType.doughnut, area: ctx.pptx.ChartType.area
  }
  const type = typeMap[c.type] || ctx.pptx.ChartType.bar
  const cats = c.categories || c.series[0].data.map((_: any, i: number) => `#${i + 1}`)
  const isPie = c.type === 'pie' || c.type === 'doughnut'
  let data: any[]
  if (isPie) {
    data = [{ name: c.series[0].name || 'Series', labels: cats, values: c.series[0].data }]
  } else {
    data = c.series.map((ser: any) => ({ name: ser.name, labels: cats, values: ser.data }))
  }
  slide.addChart(type, data, {
    x: M, y: 2.0, w: PW - 2 * M, h: PH - 2.0 - M,
    chartColors: ctx.T.chart,
    showLegend: !isPie ? c.series.length > 1 : true,
    legendPos: 'b', legendColor: ctx.muted, legendFontFace: ctx.T.body,
    showTitle: false,
    showValue: isPie, showPercent: isPie,
    catAxisLabelColor: ctx.muted, valAxisLabelColor: ctx.muted,
    catAxisLabelFontFace: ctx.T.body, valAxisLabelFontFace: ctx.T.body,
    catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
    valGridLine: { style: 'dash', color: 'E2E8F0', size: 0.5 },
    dataLabelColor: isDark(ctx.bg) ? 'FFFFFF' : '334155', dataLabelFontFace: ctx.T.body,
    barDir: 'col'
  })
}

function layoutSplit(ctx: Ctx, slide: any, s: any, img: string | null) {
  const imgLeft = s.image?.side === 'left'
  const halfW = (PW - M * 2 - 0.4) / 2
  const imgX = imgLeft ? M : M + halfW + 0.4
  const txtX = imgLeft ? M + halfW + 0.4 : M
  if (img) {
    slide.addImage({ path: img, x: imgX, y: M, w: halfW, h: PH - 2 * M, rounding: true, sizing: { type: 'cover', w: halfW, h: PH - 2 * M } })
  } else {
    card(ctx, slide, imgX, M, halfW, PH - 2 * M, ctx.T.card)
    iconCircle(ctx, slide, imgX + halfW / 2 - 0.6, PH / 2 - 0.6, 1.2, iconOf(s.icon || 'bulb'), ctx.T.primary)
  }
  slide.addText(s.title || '', { x: txtX, y: 1.0, w: halfW, h: 1.4, fontSize: 30, bold: true, color: ctx.text, fontFace: ctx.T.heading, valign: 'top', fit: 'shrink', wrap: true })
  const items: string[] = (s.items || []).slice(0, 5)
  if (items.length) {
    slide.addText(items.map((t) => ({ text: String(t), options: { bullet: { code: '2022', indent: 16 }, color: ctx.text, paraSpaceAfter: 8 } })), {
      x: txtX, y: 2.5, w: halfW, h: PH - 2.5 - M, fontSize: 15, color: ctx.text, fontFace: ctx.T.body, valign: 'top', fit: 'shrink', wrap: true
    })
  } else if (s.body) {
    slide.addText(s.body, { x: txtX, y: 2.5, w: halfW, h: PH - 2.5 - M, fontSize: 15, color: ctx.text, fontFace: ctx.T.body, valign: 'top', fit: 'shrink', wrap: true })
  }
}

function layoutImage(ctx: Ctx, slide: any, s: any, img: string | null) {
  if (img) {
    slide.addImage({ path: img, x: 0, y: 0, w: PW, h: PH, sizing: { type: 'cover', w: PW, h: PH } })
    slide.addShape(ctx.pptx.ShapeType.rect, { x: 0, y: PH - 3.2, w: PW, h: 3.2, fill: { color: '000000', transparency: 25 }, line: { type: 'none' } })
  }
  slide.addText(s.title || '', { x: M, y: PH - 2.6, w: PW - 2 * M, h: 1.2, fontSize: 36, bold: true, color: 'FFFFFF', fontFace: ctx.T.heading, fit: 'shrink', wrap: true })
  if (s.subtitle) {
    slide.addText(s.subtitle, { x: M, y: PH - 1.3, w: PW - 2 * M, h: 0.7, fontSize: 16, color: 'E2E8F0', fontFace: ctx.T.body, fit: 'shrink', wrap: true })
  }
}

function layoutClosing(ctx: Ctx, slide: any, s: any, _img: string | null) {
  iconCircle(ctx, slide, PW / 2 - 0.6, 1.8, 1.2, iconOf(s.icon || 'check'), ctx.T.accent)
  slide.addText(s.title || 'Thank You', { x: M, y: 3.2, w: PW - 2 * M, h: 1.4, align: 'center', fontSize: 48, bold: true, color: ctx.text, fontFace: ctx.T.heading, fit: 'shrink', wrap: true })
  if (s.subtitle || s.body) {
    slide.addText(s.subtitle || s.body, { x: M, y: 4.7, w: PW - 2 * M, h: 1.2, align: 'center', fontSize: 18, color: ctx.muted, fontFace: ctx.T.body, fit: 'shrink', wrap: true })
  }
}

const LAYOUTS: Record<string, (ctx: Ctx, slide: any, s: any, img: string | null) => void> = {
  cover: layoutCover, section: layoutSection, agenda: layoutAgenda, bullets: layoutBullets,
  cards: layoutCards, bigstat: layoutBigstat, comparison: layoutComparison, timeline: layoutTimeline,
  quote: layoutQuote, chart: layoutChart, split: layoutSplit, image: layoutImage, closing: layoutClosing
}

async function renderDeck(spec: any, images: (string | null)[], destPath: string): Promise<void> {
  const mod: any = await import('pptxgenjs')
  const PptxGenJS = mod.default ?? mod
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'BRUTUS Deck Studio'
  pptx.title = spec?.meta?.title || 'Presentation'
  const T = buildTheme(spec)

  const slides: any[] = Array.isArray(spec?.slides) ? spec.slides : []
  slides.forEach((s, i) => {
    const layout = LAYOUTS[s.layout] ? s.layout : 'bullets'
    const pc = pageColors(T, layout)
    const slide = pptx.addSlide()
    slide.background = { color: pc.bg }
    const ctx: Ctx = { pptx, T, bg: pc.bg, text: pc.text, muted: pc.muted }
    try {
      LAYOUTS[layout](ctx, slide, s, images[i] || null)
    } catch (e) {
      slide.addText(String(s.title || ''), { x: M, y: 0.6, w: PW - 2 * M, h: 1, fontSize: 28, bold: true, color: pc.text, fontFace: T.heading, fit: 'shrink' })
    }
    if (s.notes) slide.addNotes(String(s.notes))
  })

  // references / appendix slide
  if (Array.isArray(spec?.references) && spec.references.length) {
    const slide = pptx.addSlide()
    slide.background = { color: T.bg }
    const ctx: Ctx = { pptx, T, bg: T.bg, text: T.text, muted: T.muted }
    titleBar(ctx, slide, 'References')
    slide.addText(
      spec.references.slice(0, 12).map((r: string) => ({ text: String(r), options: { bullet: { code: '2022', indent: 16 }, paraSpaceAfter: 6, color: T.text } })),
      { x: M, y: 1.95, w: PW - 2 * M, h: PH - 1.95 - M, fontSize: 12, color: T.text, fontFace: T.body, valign: 'top', fit: 'shrink', wrap: true }
    )
  }

  await pptx.writeFile({ fileName: destPath })
}

// ─── Research enrichment (Tavily, optional) ───────────────────────────
async function researchTopic(tavilyKey: string, query: string): Promise<string> {
  try {
    const mod: any = await import('@tavily/core')
    const tavily = mod.tavily ?? mod.default?.tavily ?? mod.default
    const tvly = tavily({ apiKey: tavilyKey })
    const r = await tvly.search(query, { searchDepth: 'advanced', maxResults: 6, includeAnswer: true })
    const sources = (r.results || []).map((x: any) => `- ${x.title}: ${x.content} (${x.url})`).join('\n')
    return `# RESEARCHED FACTS (use these; cite sources in notes/references)\nSummary: ${r.answer || ''}\n${sources}`
  } catch {
    return ''
  }
}

// ─── Vision QA loop ───────────────────────────────────────────────────
const QA_PROMPT = `You are a STRICT presentation QA reviewer with fresh eyes. You are shown rendered slide images (1-indexed in order). For EACH slide, report ONLY real, user-visible defects from this list:
- text overflowing or clipped at a box/slide edge
- elements overlapping or colliding (text over shapes, stacked boxes, title over body)
- text over an image with poor contrast / unreadable
- low-contrast text or icons (light on light, dark on dark)
- margins clearly under ~0.5 inch from the slide edge
- empty area imbalance (one half crammed, other half blank)
- leftover placeholder text (TODO, lorem ipsum, [insert], xxx)
- justified body text, or a slide that is just bullets with no visual
Output ONLY JSON: {"slides":[{"slide":N,"issues":["..."]}]}. If a slide is clean, use "issues":[]. Do NOT invent issues; only report what is clearly visible. Be concise.`

async function renderDeckToImages(pptxPath: string): Promise<string[] | null> {
  const soffice = await findSoffice()
  if (!soffice) return null
  const pdfPath = pptxPath.replace(/\.pptx$/i, '_qa.pdf')
  const ok = await convertWithLibreOffice(soffice, pptxPath, 'pdf', pdfPath)
  if (!ok) return null
  try {
    const { PDFParse } = await import('pdf-parse')
    const data = await fs.readFile(pdfPath)
    const parser = new PDFParse({ data: new Uint8Array(data) })
    try {
      const shot: any = await parser.getScreenshot({ scale: 1.15, imageDataUrl: true, imageBuffer: false })
      return (shot.pages || [])
        .map((p: any) => (p.dataUrl || '').split(',')[1])
        .filter((b: string) => b && b.length > 100)
    } finally {
      await parser.destroy()
    }
  } catch {
    return null
  } finally {
    fs.rm(pdfPath, { force: true }).catch(() => {})
  }
}

async function visionInspect(ai: any, images: string[]): Promise<Record<number, string[]>> {
  const parts: any[] = [{ text: QA_PROMPT }]
  images.forEach((b64, i) => {
    parts.push({ text: `--- Slide ${i + 1} ---` })
    parts.push({ inlineData: { mimeType: 'image/png', data: b64 } })
  })
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts }],
    config: { responseMimeType: 'application/json', temperature: 0.2 }
  })
  const out: Record<number, string[]> = {}
  try {
    const parsed = JSON.parse((res.text || '{}').replace(/^```json/i, '').replace(/```$/i, '').trim())
    for (const s of parsed.slides || []) {
      if (Array.isArray(s.issues) && s.issues.length) out[Number(s.slide)] = s.issues
    }
  } catch {
    // unparseable → treat as clean
  }
  return out
}

async function applyQaFixes(
  ai: any,
  spec: any,
  issuesBySlide: Record<number, string[]>
): Promise<any> {
  const issueText = Object.entries(issuesBySlide)
    .map(([n, arr]) => `Slide ${n}: ${arr.join('; ')}`)
    .join('\n')
  const prompt = `${DECK_STUDIO_PROMPT}

You previously produced this DeckSpec JSON:
${JSON.stringify(spec).slice(0, 28000)}

A QA reviewer flagged these defects (slides are 1-indexed, matching the "slides" array order):
${issueText}

Return a CORRECTED DeckSpec JSON that fixes ONLY these issues — shorten any overflowing text, reduce the number of items/cards/stats on crammed slides, raise contrast (adjust palette text/bg if needed), switch a layout if two consecutive slides repeat, and ensure every slide has a visual. Keep the same overall topic, slide order, and content intent. Output ONLY the corrected DeckSpec JSON.`
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'application/json', temperature: 0.5 }
  })
  return JSON.parse((res.text || '{}').replace(/^```json/i, '').replace(/```$/i, '').trim())
}

// ─── Design-director self-critique (Max Quality mode) ─────────────────
async function refineSpec(ai: any, spec: any, instructions: string): Promise<any> {
  const prompt = `${DECK_STUDIO_PROMPT}

You are now the SENIOR DESIGN DIRECTOR doing a ruthless review of a DRAFT DeckSpec. Elevate it to agency-grade — this deck must be submittable to real judges/investors with zero edits. Improve:
- Narrative arc: every slide makes exactly ONE crisp point; strong cover → problem → solution → proof → ask flow.
- Layout VARIETY: no two consecutive slides share a layout; deliberately alternate cover/section/cards/bigstat/comparison/timeline/chart/split/quote/image.
- Every slide has a concrete visual (specific image.query, native chart, icon set, or cards) — zero bullet-only slides.
- Copy: tighten everything — titles ≤ 8 words, bullets/card text ≤ ~14 words, stats short and punchy.
- Color discipline: one dominant color (60–70%), supporting tones, one sharp accent, strong contrast; topic-specific (not generic).
- Make image.query terms highly specific and real-world searchable.
- Ensure speaker notes on content slides and a references list when facts are cited.
Keep the topic, audience, and intent. Return ONLY the improved DeckSpec JSON.

USER INSTRUCTIONS: ${instructions || '(none)'}

DRAFT DeckSpec:
${JSON.stringify(spec).slice(0, 30000)}`
  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'application/json', temperature: 0.6 }
  })
  return JSON.parse((res.text || '{}').replace(/^```json/i, '').replace(/```$/i, '').trim())
}

export default function registerDeckStudio({ ipcMain }: { ipcMain: IpcMain }) {
  ipcMain.removeHandler('deck-generate')
  ipcMain.handle('deck-generate', async (event, params) => {
    const send = (payload: object) => {
      try {
        event.sender.send('deck-progress', payload)
      } catch {
        /* ignore */
      }
    }
    try {
      const { content, instructions, geminiKey, tavilyKey, research, qaLoop, quality, slideCount, fileName, outputDir, fetchImages, renderPdf } = params || {}
      if (!geminiKey || !String(geminiKey).trim()) {
        return { success: false, error: 'Missing Gemini API Key. Configure it in the Command Center Vault.' }
      }

      const ai = new GoogleGenAI({ apiKey: geminiKey })

      // Optional research enrichment (Tavily) when content is thin.
      let sourceContent = content || ''
      if (research && tavilyKey && String(tavilyKey).trim()) {
        send({ stage: 'research', message: 'Researching the topic…' })
        const facts = await researchTopic(String(tavilyKey), instructions || sourceContent.slice(0, 200))
        if (facts) sourceContent = `${facts}\n\n${sourceContent}`
      }

      send({ stage: 'planning', message: 'Designing deck structure & palette…' })
      let spec = await generateSpec(ai, sourceContent, instructions, slideCount)

      // Max Quality: successive senior design-director critique passes before
      // rendering. No rush — each pass builds on the previous to reach
      // agency-grade polish.
      if (quality === 'max') {
        const refinePasses = 2
        for (let r = 0; r < refinePasses; r++) {
          send({
            stage: 'refine',
            message: `Design director review (pass ${r + 1}/${refinePasses}) — elevating to agency-grade…`
          })
          try {
            const improved = await refineSpec(ai, spec, instructions)
            if (improved && Array.isArray(improved.slides) && improved.slides.length) spec = improved
            else break
          } catch {
            break // keep the best spec we have if a refinement fails
          }
        }
      }
      const slides: any[] = Array.isArray(spec?.slides) ? spec.slides : []
      if (!slides.length) return { success: false, error: 'The design model returned no slides.' }

      // image acquisition (parallel, best-effort)
      const imgDir = path.join(app.getPath('userData'), 'DeckStudioTemp', `deck_${Date.now()}`)
      await fs.mkdir(imgDir, { recursive: true })
      let images: (string | null)[] = slides.map(() => null)
      if (fetchImages !== false) {
        const wanted = slides
          .map((s, i) => ({ i, q: s?.image?.query }))
          .filter((x) => x.q)
        send({ stage: 'images', message: `Sourcing ${wanted.length} contextual image(s)…`, total: wanted.length })
        await Promise.all(
          wanted.map(async ({ i, q }) => {
            const p = await fetchImage(String(q), imgDir, `img_${i}`)
            images[i] = p
          })
        )
      }

      send({ stage: 'rendering', message: 'Rendering slides…', slides: slides.length })
      const safeName = (fileName || spec?.meta?.title || 'presentation')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\.pptx$/i, '')
      const destDir = outputDir ? path.resolve(outputDir) : app.getPath('documents')
      await fs.mkdir(destDir, { recursive: true })
      const dest = path.join(destDir, `${safeName}.pptx`)
      await renderDeck(spec, images, dest)

      // ── Vision QA loop: render → inspect → fix → re-render (capped) ──
      let qaReport: Record<number, string[]> = {}
      if (qaLoop !== false) {
        // Max Quality gets more headroom to iterate toward a clean render.
        const cap = quality === 'max' ? 8 : 6
        const fallback = quality === 'max' ? 5 : 2
        const maxPasses = Math.max(1, Math.min(Number(params?.maxPasses) || fallback, cap))
        for (let p = 0; p < maxPasses; p++) {
          send({ stage: 'qa', message: `Visual QA — inspecting every slide (pass ${p + 1})…` })
          const imgs = await renderDeckToImages(dest)
          if (!imgs || !imgs.length) break // LibreOffice unavailable or render failed
          const issues = await visionInspect(ai, imgs)
          qaReport = issues
          if (Object.keys(issues).length === 0) {
            send({ stage: 'qa', message: '✅ QA pass clean — no visible defects.' })
            break
          }
          if (p === maxPasses - 1) break // final pass: report only
          send({ stage: 'qa-fix', message: `Fixing ${Object.keys(issues).length} flagged slide(s)…` })
          try {
            const fixed = await applyQaFixes(ai, spec, issues)
            if (fixed && Array.isArray(fixed.slides) && fixed.slides.length) {
              spec = fixed
              await renderDeck(spec, images, dest)
            } else break
          } catch {
            break
          }
        }
      }

      // optional PDF preview via LibreOffice
      let pdfPath: string | null = null
      if (renderPdf) {
        const soffice = await findSoffice()
        if (soffice) {
          const pdfDest = dest.replace(/\.pptx$/i, '.pdf')
          send({ stage: 'preview', message: 'Rendering PDF preview…' })
          const ok = await convertWithLibreOffice(soffice, dest, 'pdf', pdfDest)
          if (ok) pdfPath = pdfDest
        }
      }

      // cleanup temp images
      fs.rm(imgDir, { recursive: true, force: true }).catch(() => {})

      send({ stage: 'done', message: 'Deck ready.' })
      return {
        success: true,
        path: dest,
        pdfPath,
        slideCount: slides.length + (spec?.references?.length ? 1 : 0),
        title: spec?.meta?.title || safeName,
        qaSlidesFlagged: Object.keys(qaReport).length,
        qaReport
      }
    } catch (err) {
      send({ stage: 'error', message: String(err) })
      return { success: false, error: String(err) }
    }
  })
}
