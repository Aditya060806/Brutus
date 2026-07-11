import { IpcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'

/**
 * BRUTUS PDF tools
 * ----------------
 * - read-pdf   : extract text from a single PDF OR every PDF in a folder
 *                (the LLM then summarizes / analyzes the returned text)
 * - create-pdf : render a title + body of text into a real .pdf
 *
 * Reading uses pdf-parse (pdfjs under the hood); creation uses pdf-lib.
 */

const MAX_TEXT_PER_FILE = 12000 // chars returned per PDF to keep the model prompt sane

async function extractPdfText(filePath: string): Promise<{ text: string; pages: number }> {
  const { PDFParse } = await import('pdf-parse')
  const data = await fs.readFile(filePath)
  const parser = new PDFParse({ data: new Uint8Array(data) })
  try {
    const res = await parser.getText()
    return { text: res.text || '', pages: res.total || 0 }
  } finally {
    await parser.destroy()
  }
}

const truncate = (s: string): string =>
  s.length > MAX_TEXT_PER_FILE ? `${s.slice(0, MAX_TEXT_PER_FILE)}\n…(truncated)` : s

export default function registerPdfTools(ipcMain: IpcMain) {
  // ─── READ / ANALYZE ─────────────────────────────────────────────────
  ipcMain.removeHandler('read-pdf')
  ipcMain.handle('read-pdf', async (_event, { targetPath }) => {
    try {
      if (!targetPath) return '❌ Error: targetPath is required.'
      const resolved = path.resolve(targetPath)

      let stat
      try {
        stat = await fs.stat(resolved)
      } catch {
        return `❌ Error: Path not found at '${resolved}'.`
      }

      // Folder mode — read every PDF inside
      if (stat.isDirectory()) {
        const entries = await fs.readdir(resolved)
        const pdfs = entries.filter((f) => f.toLowerCase().endsWith('.pdf'))
        if (pdfs.length === 0) return `⚠️ No PDF files found in ${resolved}.`

        const blocks: string[] = []
        for (const name of pdfs.slice(0, 10)) {
          try {
            const { text, pages } = await extractPdfText(path.join(resolved, name))
            blocks.push(`📄 ${name} (${pages} pages):\n${truncate(text.trim())}`)
          } catch (e) {
            blocks.push(`📄 ${name}: ❌ could not read (${String(e)})`)
          }
        }
        const note =
          pdfs.length > 10 ? `\n\n(Showing first 10 of ${pdfs.length} PDFs in the folder.)` : ''
        return blocks.join('\n\n---\n\n') + note
      }

      // Single file mode
      if (!resolved.toLowerCase().endsWith('.pdf')) {
        return `❌ Error: '${path.basename(resolved)}' is not a PDF file.`
      }
      const { text, pages } = await extractPdfText(resolved)
      if (!text.trim()) {
        return `⚠️ "${path.basename(
          resolved
        )}" has ${pages} page(s) but no extractable text (it may be a scanned image PDF).`
      }
      return `📄 "${path.basename(resolved)}" (${pages} pages):\n\n${truncate(text.trim())}`
    } catch (err) {
      return `❌ PDF read failed: ${String(err)}`
    }
  })

  // ─── CREATE ─────────────────────────────────────────────────────────
  ipcMain.removeHandler('create-pdf')
  ipcMain.handle('create-pdf', async (_event, { fileName, title, content, outputDir }) => {
    try {
      if (!content && !title) return '❌ Error: Provide at least a title or content for the PDF.'

      const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
      const pdf = await PDFDocument.create()
      const font = await pdf.embedFont(StandardFonts.Helvetica)
      const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)

      const pageWidth = 595.28
      const pageHeight = 841.89 // A4
      const margin = 50
      const maxWidth = pageWidth - margin * 2

      let page = pdf.addPage([pageWidth, pageHeight])
      let y = pageHeight - margin

      const draw = (line: string, f: any, size: number) => {
        if (y < margin) {
          page = pdf.addPage([pageWidth, pageHeight])
          y = pageHeight - margin
        }
        page.drawText(line, { x: margin, y, size, font: f, color: rgb(0.1, 0.1, 0.1) })
        y -= size * 1.5
      }

      const wrap = (str: string, f: any, size: number): string[] => {
        const words = str.split(/\s+/)
        const lines: string[] = []
        let line = ''
        for (const w of words) {
          const test = line ? `${line} ${w}` : w
          if (line && f.widthOfTextAtSize(test, size) > maxWidth) {
            lines.push(line)
            line = w
          } else {
            line = test
          }
        }
        if (line) lines.push(line)
        return lines.length ? lines : ['']
      }

      // StandardFonts can only encode WinAnsi characters
      const sanitize = (s: string) => s.replace(/\t/g, '    ').replace(/[^\x00-\xFF]/g, '?')

      if (title) {
        for (const wl of wrap(sanitize(title), fontBold, 20)) draw(wl, fontBold, 20)
        y -= 10
      }
      for (const raw of (content || '').split('\n')) {
        for (const wl of wrap(sanitize(raw), font, 11)) draw(wl, font, 11)
      }

      const safeName = (fileName || title || 'document')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\.pdf$/i, '')
      const destDir = outputDir ? path.resolve(outputDir) : app.getPath('documents')
      await fs.mkdir(destDir, { recursive: true })
      const dest = path.join(destDir, `${safeName}.pdf`)

      await fs.writeFile(dest, await pdf.save())
      return `✅ PDF created: ${dest}`
    } catch (err) {
      return `❌ PDF creation failed: ${String(err)}`
    }
  })
}
