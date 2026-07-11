import { IpcMain, app, BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import Store from 'electron-store'
import { findSoffice, convertWithLibreOffice, setCustomSofficePath, warmUpLibreOffice } from './libreoffice'

/**
 * BRUTUS Universal File Converter (high-fidelity)
 * -----------------------------------------------
 * Document/visual targets (PDF, HTML) are produced through a real Chromium
 * renderer (Electron's webContents.printToPDF) fed with professionally
 * styled HTML — so headings, bold/italic, lists, tables, links, colors and
 * embedded images are preserved and properly laid out (e.g. DOCX → PDF keeps
 * its structure and looks clean, not a flat text dump).
 *
 * Source readers : pdf, docx, xlsx/xls, csv, json, txt/md/html/..., images
 * Target writers : txt, md, html, json, csv, xlsx, pdf, png, jpg/jpeg, webp
 */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff'])
const RAW_TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.log',
  '.xml',
  '.yml',
  '.yaml',
  '.css',
  '.js',
  '.ts'
])
const IMAGE_TARGETS = new Set(['png', 'jpg', 'jpeg', 'webp'])

// User preference: use LibreOffice (pixel-perfect) when available. Default OFF
// so the silent built-in engine is used out of the box and conversions never
// touch the system printer.
let preferLibreOffice = false

// Conversions where LibreOffice (if installed) gives pixel-perfect fidelity.
const LIBRE_SOURCE_EXTS = new Set([
  '.docx',
  '.doc',
  '.odt',
  '.rtf',
  '.pptx',
  '.ppt',
  '.odp',
  '.xlsx',
  '.xls',
  '.ods'
])
const LIBRE_TARGETS = new Set([
  'pdf',
  'docx',
  'odt',
  'rtf',
  'html',
  'txt',
  'xlsx',
  'csv',
  'ods',
  'pptx',
  'odp'
])

interface Extracted {
  text?: string
  rows?: any[][]
  html?: string
  imageBuffer?: Buffer
  imageExt?: string
}

interface WriteCtx {
  sourceExt: string
}

// ─── professional print stylesheet (used for PDF + HTML output) ───────
const CONVERTER_CSS = `
  @page { size: A4; margin: 18mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', 'Calibri', 'Helvetica Neue', Arial, sans-serif;
    color: #1a1a1a; line-height: 1.6; font-size: 12pt;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  h1 { font-size: 22pt; margin: 0 0 12px; color: #111; font-weight: 700; }
  h2 { font-size: 17pt; margin: 18px 0 8px; font-weight: 700; }
  h3 { font-size: 14pt; margin: 14px 0 6px; font-weight: 700; }
  h4, h5, h6 { margin: 12px 0 4px; font-weight: 700; }
  p { margin: 0 0 10px; }
  ul, ol { margin: 0 0 10px 24px; padding: 0; }
  li { margin: 3px 0; }
  strong, b { font-weight: 700; }
  em, i { font-style: italic; }
  a { color: #0563c1; text-decoration: underline; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 16px 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 11pt; }
  th, td { border: 1px solid #b4bcc4; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #eef2f7; font-weight: 700; }
  tr:nth-child(even) td { background: #fafbfc; }
  pre {
    white-space: pre-wrap; word-wrap: break-word;
    font-family: 'Consolas', 'Courier New', monospace; font-size: 10.5pt;
    background: #f7f7f9; padding: 14px; border: 1px solid #e3e3e8; border-radius: 6px;
  }
  code { font-family: 'Consolas', 'Courier New', monospace; background: #f0f0f3; padding: 1px 4px; border-radius: 3px; }
  blockquote { border-left: 4px solid #d0d7de; margin: 10px 0; padding: 4px 14px; color: #4a4a4a; }
`

// ─── CSV helpers ──────────────────────────────────────────────────────
function parseCsv(raw: string): string[][] {
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      cur.push(field)
      field = ''
    } else if (c === '\n') {
      cur.push(field)
      rows.push(cur)
      cur = []
      field = ''
    } else if (c === '\r') {
      // ignore — handled by \n
    } else {
      field += c
    }
  }

  if (field.length > 0 || cur.length > 0) {
    cur.push(field)
    rows.push(cur)
  }
  return rows
}

function csvStringify(rows: any[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const s = cell === null || cell === undefined ? '' : String(cell)
          return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
        })
        .join(',')
    )
    .join('\r\n')
}

function rowsToObjects(rows: any[][]): Record<string, any>[] {
  if (!rows.length) return []
  const headers = rows[0].map((h, i) => String(h ?? `col${i + 1}`))
  return rows.slice(1).map((r) => {
    const obj: Record<string, any> = {}
    headers.forEach((h, i) => {
      obj[h] = r[i] ?? ''
    })
    return obj
  })
}

function jsonToRows(parsed: any): any[][] | undefined {
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined
  if (typeof parsed[0] === 'object' && parsed[0] !== null && !Array.isArray(parsed[0])) {
    const headerSet = new Set<string>()
    parsed.forEach((o) => Object.keys(o || {}).forEach((k) => headerSet.add(k)))
    const headers = Array.from(headerSet)
    return [headers, ...parsed.map((o) => headers.map((h) => o?.[h] ?? ''))]
  }
  if (Array.isArray(parsed[0])) return parsed
  return parsed.map((v) => [v])
}

function toText(data: Extracted): string {
  if (data.text !== undefined) return data.text
  if (data.rows) return data.rows.map((r) => r.join('\t')).join('\n')
  return ''
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ─── HTML builders ────────────────────────────────────────────────────
function rowsToHtmlTable(rows: any[][]): string {
  if (!rows.length) return '<p>(empty)</p>'
  const esc = (v: any) => escapeHtml(v == null ? '' : String(v.text ?? v.result ?? v))
  const head = `<thead><tr>${rows[0].map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
  const body = `<tbody>${rows
    .slice(1)
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`
  return `<table>${head}${body}</table>`
}

function wrapHtml(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CONVERTER_CSS}</style></head><body>${body}</body></html>`
}

// Produce a complete, styled HTML document for a given source representation.
async function toRenderableHtml(data: Extracted, sourceExt: string): Promise<string> {
  // HTML source that is already a full document → preserve its own styles
  if (data.html && /^\s*(<!doctype|<html)/i.test(data.html)) return data.html

  let body: string
  if (sourceExt === '.md' || sourceExt === '.markdown') {
    const mod: any = await import('marked')
    const marked = mod.marked ?? mod.default ?? mod
    body = String(await marked.parse(data.text || ''))
  } else if (data.html) {
    body = data.html
  } else if (data.rows) {
    body = rowsToHtmlTable(data.rows)
  } else {
    body = `<pre>${escapeHtml(data.text || '')}</pre>`
  }
  return wrapHtml(body)
}

// ─── Chromium-based HTML → PDF (high fidelity) ────────────────────────
async function htmlToPdf(html: string, targetPath: string): Promise<void> {
  const tmpDir = path.join(app.getPath('userData'), 'ConverterTemp')
  await fs.mkdir(tmpDir, { recursive: true })
  const tmpHtml = path.join(tmpDir, `conv_${Date.now()}_${Math.random().toString(36).slice(2)}.html`)
  await fs.writeFile(tmpHtml, html, 'utf-8')

  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: { sandbox: false, offscreen: false }
  })

  try {
    await win.loadFile(tmpHtml)
    // wait for fonts/images to settle for faithful rendering
    try {
      await win.webContents.executeJavaScript(
        'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true'
      )
    } catch {
      // ignore — proceed with best effort
    }
    await new Promise((r) => setTimeout(r, 350))

    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    })
    await fs.writeFile(targetPath, pdf)
  } finally {
    if (!win.isDestroyed()) win.destroy()
    fs.unlink(tmpHtml).catch(() => {})
  }
}

// ─── Source extraction ────────────────────────────────────────────────
async function extractFromSource(sourcePath: string, ext: string): Promise<Extracted> {
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse')
    const data = await fs.readFile(sourcePath)
    const parser = new PDFParse({ data: new Uint8Array(data) })
    try {
      const res = await parser.getText()
      return { text: res.text }
    } finally {
      await parser.destroy()
    }
  }

  if (ext === '.docx') {
    const mammothMod: any = await import('mammoth')
    const mammoth = mammothMod.default ?? mammothMod
    // mammoth embeds images as data URIs and maps headings/bold/italic/lists/tables
    const html = (await mammoth.convertToHtml({ path: sourcePath })).value
    const text = (await mammoth.extractRawText({ path: sourcePath })).value
    return { text, html }
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const ExcelJSMod: any = await import('exceljs')
    const ExcelJS = ExcelJSMod.default ?? ExcelJSMod
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(sourcePath)
    const ws = wb.worksheets[0]
    const rows: any[][] = []
    if (ws) {
      ws.eachRow((row: any) => {
        const vals = (row.values as any[]).slice(1)
        rows.push(
          vals.map((v) => {
            if (v === null || v === undefined) return ''
            if (typeof v === 'object') return v.text ?? v.result ?? v.hyperlink ?? JSON.stringify(v)
            return v
          })
        )
      })
    }
    return { rows }
  }

  if (ext === '.csv') {
    const raw = await fs.readFile(sourcePath, 'utf-8')
    return { rows: parseCsv(raw), text: raw }
  }

  if (ext === '.json') {
    const raw = await fs.readFile(sourcePath, 'utf-8')
    let rows: any[][] | undefined
    try {
      rows = jsonToRows(JSON.parse(raw))
    } catch {
      // leave as text only
    }
    return { text: raw, rows }
  }

  if (RAW_TEXT_EXTS.has(ext)) {
    const raw = await fs.readFile(sourcePath, 'utf-8')
    const isHtml = ext === '.html' || ext === '.htm'
    return { text: raw, html: isHtml ? raw : undefined }
  }

  if (IMAGE_EXTS.has(ext)) {
    const buf = await fs.readFile(sourcePath)
    return { imageBuffer: buf, imageExt: ext }
  }

  throw new Error(`Unsupported source format: ${ext}`)
}

// ─── image → PDF (exact image-sized page via pdf-lib) ─────────────────
async function imageToPdf(buffer: Buffer, targetPath: string): Promise<void> {
  const { PDFDocument } = await import('pdf-lib')
  const sharpMod: any = await import('sharp')
  const sharp = sharpMod.default ?? sharpMod
  const pngBuf = await sharp(buffer).png().toBuffer()
  const pdf = await PDFDocument.create()
  const img = await pdf.embedPng(pngBuf)
  const page = pdf.addPage([img.width, img.height])
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height })
  await fs.writeFile(targetPath, await pdf.save())
}

async function rowsToXlsx(rows: any[][], targetPath: string): Promise<void> {
  const ExcelJSMod: any = await import('exceljs')
  const ExcelJS = ExcelJSMod.default ?? ExcelJSMod
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  rows.forEach((r) => ws.addRow(r))
  await wb.xlsx.writeFile(targetPath)
}

// ─── Target writing ───────────────────────────────────────────────────
async function writeTarget(
  targetPath: string,
  target: string,
  data: Extracted,
  ctx: WriteCtx
): Promise<void> {
  switch (target) {
    case 'txt':
    case 'md':
    case 'markdown':
    case 'log':
    case 'xml':
    case 'yml':
    case 'yaml':
      await fs.writeFile(targetPath, toText(data), 'utf-8')
      return

    case 'html':
    case 'htm':
      await fs.writeFile(targetPath, await toRenderableHtml(data, ctx.sourceExt), 'utf-8')
      return

    case 'json':
      if (data.rows) {
        await fs.writeFile(targetPath, JSON.stringify(rowsToObjects(data.rows), null, 2), 'utf-8')
      } else {
        await fs.writeFile(targetPath, JSON.stringify({ content: toText(data) }, null, 2), 'utf-8')
      }
      return

    case 'csv':
      if (data.rows) {
        await fs.writeFile(targetPath, csvStringify(data.rows), 'utf-8')
      } else {
        const lines = toText(data).split('\n')
        await fs.writeFile(targetPath, csvStringify(lines.map((l) => [l])), 'utf-8')
      }
      return

    case 'xlsx':
      await rowsToXlsx(data.rows ?? toText(data).split('\n').map((l) => [l]), targetPath)
      return

    case 'pdf':
      if (data.imageBuffer) {
        await imageToPdf(data.imageBuffer, targetPath)
      } else {
        await htmlToPdf(await toRenderableHtml(data, ctx.sourceExt), targetPath)
      }
      return

    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp': {
      if (!data.imageBuffer) {
        throw new Error(
          `Cannot convert text/document content into an image (${target}). Image targets only work from image sources.`
        )
      }
      const sharpMod: any = await import('sharp')
      const sharp = sharpMod.default ?? sharpMod
      let pipeline = sharp(data.imageBuffer)
      if (target === 'png') pipeline = pipeline.png()
      else if (target === 'webp') pipeline = pipeline.webp()
      else pipeline = pipeline.jpeg({ quality: 92 })
      await fs.writeFile(targetPath, await pipeline.toBuffer())
      return
    }

    default:
      throw new Error(`Unsupported target format: ${target}`)
  }
}

export default function registerFileConverter(ipcMain: IpcMain) {
  // Load any previously configured LibreOffice path so detection finds it.
  try {
    const StoreClass: any = (Store as any).default || Store
    const store = new StoreClass()
    const savedLo = store.get('brutus_libreoffice_path') as string | undefined
    if (savedLo) setCustomSofficePath(savedLo)
    // Default ON (pixel-perfect when LibreOffice is available) unless the user
    // has explicitly chosen otherwise. The persistent profile + automatic
    // built-in fallback keep this safe.
    const storedPref = store.get('brutus_prefer_libreoffice')
    preferLibreOffice = storedPref === undefined ? true : storedPref === true

    // If pixel-perfect is on and LibreOffice is available, warm its profile in
    // the background (one-time init, no printing) so the first real conversion
    // is fast instead of taking ~50s on first-run initialization.
    if (preferLibreOffice) {
      setTimeout(() => {
        findSoffice()
          .then((s) => {
            if (s) warmUpLibreOffice(s)
          })
          .catch(() => {})
      }, 4000)
    }

    ipcMain.removeHandler('set-libreoffice-path')
    ipcMain.handle('set-libreoffice-path', async (_e, p: string) => {
      const resolved = setCustomSofficePath(p)
      if (resolved) {
        store.set('brutus_libreoffice_path', p)
        // Explicitly configuring a path implies the user wants to use it.
        preferLibreOffice = true
        store.set('brutus_prefer_libreoffice', true)
        warmUpLibreOffice(resolved)
        return { success: true, path: resolved, preferred: true }
      }
      setCustomSofficePath((store.get('brutus_libreoffice_path') as string) || null)
      return { success: false, error: `No LibreOffice (soffice) binary found at "${p}".` }
    })

    ipcMain.removeHandler('get-libreoffice-status')
    ipcMain.handle('get-libreoffice-status', async () => {
      const s = await findSoffice()
      return { available: !!s, path: s, preferred: preferLibreOffice }
    })

    ipcMain.removeHandler('set-libreoffice-preference')
    ipcMain.handle('set-libreoffice-preference', async (_e, prefer: boolean) => {
      preferLibreOffice = !!prefer
      store.set('brutus_prefer_libreoffice', preferLibreOffice)
      const s = await findSoffice()
      if (preferLibreOffice && s) warmUpLibreOffice(s)
      return { success: true, preferred: preferLibreOffice, available: !!s, path: s }
    })

    ipcMain.removeHandler('pick-libreoffice-path')
    ipcMain.handle('pick-libreoffice-path', async () => {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const res = await dialog.showOpenDialog(win!, {
        title: 'Select LibreOffice — its install folder, program folder, or soffice.exe/.com',
        properties: ['openFile', 'openDirectory'],
        filters: [{ name: 'LibreOffice', extensions: ['exe', 'com'] }]
      })
      if (res.canceled || !res.filePaths[0]) return { success: false, canceled: true }
      const chosen = res.filePaths[0]
      const resolved = setCustomSofficePath(chosen)
      if (resolved) {
        store.set('brutus_libreoffice_path', chosen)
        preferLibreOffice = true
        store.set('brutus_prefer_libreoffice', true)
        warmUpLibreOffice(resolved)
        return { success: true, path: resolved, preferred: true }
      }
      // restore previous valid config if the pick was invalid
      setCustomSofficePath((store.get('brutus_libreoffice_path') as string) || null)
      return { success: false, error: 'No LibreOffice binary found in the selected location.' }
    })
  } catch {
    // electron-store unavailable — LibreOffice config disabled, built-in engine still works
  }

  ipcMain.removeHandler('convert-file')
  ipcMain.handle('convert-file', async (_event, { sourcePath, targetFormat, outputDir }) => {
    try {
      if (!sourcePath || !targetFormat) {
        return '❌ Error: sourcePath and targetFormat are required.'
      }

      const resolvedSource = path.resolve(sourcePath)
      try {
        const stat = await fs.stat(resolvedSource)
        if (!stat.isFile()) return `❌ Error: '${resolvedSource}' is not a file.`
      } catch {
        return `❌ Error: Source file not found at '${resolvedSource}'.`
      }

      const ext = path.extname(resolvedSource).toLowerCase()
      const target = targetFormat.toLowerCase().replace(/^\./, '').trim()

      const baseName = path.basename(resolvedSource, path.extname(resolvedSource))
      const destDir = outputDir ? path.resolve(outputDir) : path.dirname(resolvedSource)
      await fs.mkdir(destDir, { recursive: true })

      let targetPath = path.join(destDir, `${baseName}.${target}`)
      if (path.resolve(targetPath) === resolvedSource) {
        targetPath = path.join(destDir, `${baseName}_converted.${target}`)
      }

      // ── High-fidelity path: use LibreOffice only when the user enabled it ──
      if (preferLibreOffice && LIBRE_SOURCE_EXTS.has(ext) && LIBRE_TARGETS.has(target)) {
        const soffice = await findSoffice()
        if (soffice) {
          const ok = await convertWithLibreOffice(soffice, resolvedSource, target, targetPath)
          if (ok) {
            return `✅ Converted "${path.basename(resolvedSource)}" → "${path.basename(
              targetPath
            )}" with pixel-perfect fidelity (LibreOffice). Saved to: ${targetPath}`
          }
          // LibreOffice produced nothing — fall through to the built-in engine.
        }
      }

      const extracted = await extractFromSource(resolvedSource, ext)

      if (extracted.imageBuffer && !IMAGE_TARGETS.has(target) && target !== 'pdf') {
        return `❌ Error: Image files can only be converted to another image format or to PDF.`
      }

      await writeTarget(targetPath, target, extracted, { sourceExt: ext })

      return `✅ Converted "${path.basename(resolvedSource)}" → "${path.basename(
        targetPath
      )}". Saved to: ${targetPath}`
    } catch (err) {
      return `❌ Conversion failed: ${String(err)}`
    }
  })

  ipcMain.removeHandler('convert-file-capabilities')
  ipcMain.handle('convert-file-capabilities', async () => {
    const soffice = await findSoffice()
    return {
      sources: ['pdf', 'docx', 'xlsx', 'xls', 'csv', 'json', ...[...RAW_TEXT_EXTS], ...[...IMAGE_EXTS]],
      targets: ['txt', 'md', 'html', 'json', 'csv', 'xlsx', 'pdf', 'png', 'jpg', 'jpeg', 'webp'],
      libreOfficeAvailable: !!soffice,
      libreOfficePath: soffice || null,
      officeTargets: soffice ? [...LIBRE_TARGETS] : [],
      userDataDir: app.getPath('userData')
    }
  })
}
