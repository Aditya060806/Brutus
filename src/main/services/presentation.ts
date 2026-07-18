import { IpcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'

/**
 * BRUTUS Presentation creator — generates a real .pptx from a title + an array
 * of slides ({ title, bullets[], notes? }) using pptxgenjs, with a clean dark
 * professional theme.
 */
export default function registerPresentation({ ipcMain }: { ipcMain: IpcMain }) {
  ipcMain.removeHandler('create-presentation')
  ipcMain.handle('create-presentation', async (_e, { title, subtitle, slides, fileName, outputDir }) => {
    try {
      if (!title && (!slides || !slides.length)) {
        return { success: false, error: 'Provide a title and at least one slide.' }
      }

      const mod: any = await import('pptxgenjs')
      const PptxGenJS = mod.default ?? mod
      const pptx = new PptxGenJS()
      pptx.layout = 'LAYOUT_WIDE'
      pptx.author = 'BRUTUS'

      const BG = '0F0F17'
      const ACCENT = 'EF4444'
      const TEXT = 'F4F4F5'
      const MUTED = 'A1A1AA'

      // ── Title slide ──
      const title0 = pptx.addSlide()
      title0.background = { color: BG }
      title0.addText(String(title || 'Untitled'), {
        x: 0.6,
        y: 2.1,
        w: 12,
        h: 1.6,
        fontSize: 44,
        bold: true,
        color: TEXT,
        align: 'left'
      })
      if (subtitle) {
        title0.addText(String(subtitle), { x: 0.6, y: 3.7, w: 12, h: 0.8, fontSize: 20, color: MUTED })
      }
      title0.addShape('rect', { x: 0.6, y: 1.9, w: 2.4, h: 0.08, fill: { color: ACCENT } })

      // ── Content slides ──
      for (const s of Array.isArray(slides) ? slides : []) {
        const slide = pptx.addSlide()
        slide.background = { color: BG }
        slide.addText(String(s.title || ''), {
          x: 0.6,
          y: 0.5,
          w: 12,
          h: 1,
          fontSize: 30,
          bold: true,
          color: TEXT
        })
        slide.addShape('rect', { x: 0.6, y: 1.45, w: 1.6, h: 0.06, fill: { color: ACCENT } })

        const bullets = Array.isArray(s.bullets) ? s.bullets : []
        if (bullets.length) {
          slide.addText(
            bullets.map((b: any) => ({ text: String(b), options: { bullet: true, color: TEXT } })),
            { x: 0.8, y: 1.9, w: 11.5, h: 5, fontSize: 18, color: TEXT, lineSpacingMultiple: 1.3 }
          )
        }
        if (s.notes) slide.addNotes(String(s.notes))
      }

      const safeName = (fileName || title || 'presentation')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\.pptx$/i, '')
      const destDir = outputDir ? path.resolve(outputDir) : app.getPath('documents')
      await fs.mkdir(destDir, { recursive: true })
      const dest = path.join(destDir, `${safeName}.pptx`)

      await pptx.writeFile({ fileName: dest })
      return { success: true, path: dest, slideCount: (Array.isArray(slides) ? slides.length : 0) + 1 }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
