import { IpcMain, app } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'

/**
 * BRUTUS Excel Master
 * -------------------
 * Comprehensive, file-based spreadsheet control via ExcelJS (no Microsoft
 * Excel install required). A single `excel-op` IPC handler dispatches to a
 * full set of operations: create, read/info, cell & row writing, formulas,
 * formatting, column sizing, sorting, filtering and conditional formatting.
 *
 * Every operation is stateless: it opens the workbook, mutates it, and saves
 * — so there is no fragile "active document" state to corrupt.
 */

// ─── address helpers ──────────────────────────────────────────────────
const colToNum = (col: string): number => {
  let n = 0
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

const numToCol = (num: number): string => {
  let s = ''
  let n = num
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

interface CellRef {
  row: number
  col: number
}

const parseCell = (addr: string): CellRef | null => {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(addr).trim())
  if (!m) return null
  return { col: colToNum(m[1]), row: parseInt(m[2], 10) }
}

const parseRange = (range: string): { s: CellRef; e: CellRef } | null => {
  const parts = String(range).trim().split(':')
  if (parts.length === 1) {
    const c = parseCell(parts[0])
    return c ? { s: c, e: c } : null
  }
  const s = parseCell(parts[0])
  const e = parseCell(parts[1])
  if (!s || !e) return null
  return {
    s: { row: Math.min(s.row, e.row), col: Math.min(s.col, e.col) },
    e: { row: Math.max(s.row, e.row), col: Math.max(s.col, e.col) }
  }
}

// '#FF0000' / 'FF0000' / 'red' → ARGB 'FFFF0000'
const NAMED_COLORS: Record<string, string> = {
  red: 'FFFF0000',
  green: 'FF00B050',
  blue: 'FF0070C0',
  yellow: 'FFFFFF00',
  orange: 'FFFFA500',
  black: 'FF000000',
  white: 'FFFFFFFF',
  gray: 'FF808080',
  grey: 'FF808080',
  purple: 'FF7030A0'
}
const toArgb = (color?: string): string | undefined => {
  if (!color) return undefined
  const c = color.trim().toLowerCase()
  if (NAMED_COLORS[c]) return NAMED_COLORS[c]
  const hex = color.replace('#', '').toUpperCase()
  if (/^[0-9A-F]{6}$/.test(hex)) return `FF${hex}`
  if (/^[0-9A-F]{8}$/.test(hex)) return hex
  return undefined
}

const getExcelJS = async (): Promise<any> => {
  const mod: any = await import('exceljs')
  return mod.default ?? mod
}

const resolveFile = (filePath: string): string => path.resolve(filePath)

const getSheet = (wb: any, sheetName?: string): any => {
  if (sheetName) {
    const ws = wb.getWorksheet(sheetName)
    if (ws) return ws
  }
  return wb.worksheets[0]
}

export default function registerExcelMaster(ipcMain: IpcMain) {
  ipcMain.removeHandler('excel-op')
  ipcMain.handle('excel-op', async (_event, params) => {
    try {
      const ExcelJS = await getExcelJS()
      const action = String(params?.action || '').toLowerCase()

      // ── CREATE ──────────────────────────────────────────────────────
      if (action === 'create') {
        const wb = new ExcelJS.Workbook()
        const ws = wb.addWorksheet(params.sheet_name || 'Sheet1')
        if (Array.isArray(params.headers) && params.headers.length) {
          ws.addRow(params.headers)
          ws.getRow(1).font = { bold: true }
        }
        if (Array.isArray(params.rows)) {
          params.rows.forEach((r: any[]) => ws.addRow(r))
        }
        const dest = params.file_path
          ? resolveFile(params.file_path)
          : path.join(app.getPath('documents'), `${params.file_name || 'workbook'}.xlsx`)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await wb.xlsx.writeFile(dest)
        return `✅ Created Excel workbook: ${dest}`
      }

      // All remaining actions require an existing file
      const filePath = resolveFile(params.file_path || '')
      if (!params.file_path || !fsSync.existsSync(filePath)) {
        return `❌ Error: Excel file not found at '${filePath}'. Use action "create" first.`
      }

      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(filePath)

      // ── INFO / READ ───────────────────────────────────────────────────
      if (action === 'info' || action === 'read') {
        const sheets = wb.worksheets.map((s: any) => s.name)
        const ws = getSheet(wb, params.sheet)
        if (!ws) return `📊 Workbook "${path.basename(filePath)}" — sheets: ${sheets.join(', ')}.`
        const previewRows: string[] = []
        let count = 0
        ws.eachRow({ includeEmpty: false }, (row: any) => {
          if (count < 10) {
            const vals = (row.values as any[]).slice(1).map((v) => (v == null ? '' : v.text ?? v.result ?? v))
            previewRows.push(vals.join(' | '))
          }
          count++
        })
        return [
          `📊 "${path.basename(filePath)}" — sheets: ${sheets.join(', ')}`,
          `Active sheet "${ws.name}": ${ws.rowCount} rows × ${ws.columnCount} cols`,
          'Preview:',
          ...previewRows
        ].join('\n')
      }

      // ── LIST SHEETS ───────────────────────────────────────────────────
      if (action === 'list_sheets') {
        return `Sheets: ${wb.worksheets.map((s: any) => s.name).join(', ')}`
      }

      // ── ADD SHEET ─────────────────────────────────────────────────────
      if (action === 'add_sheet') {
        if (!params.sheet_name) return '❌ sheet_name is required.'
        if (wb.getWorksheet(params.sheet_name)) return `⚠️ Sheet "${params.sheet_name}" already exists.`
        wb.addWorksheet(params.sheet_name)
        await wb.xlsx.writeFile(filePath)
        return `✅ Added sheet "${params.sheet_name}".`
      }

      // ── DELETE SHEET ──────────────────────────────────────────────────
      if (action === 'delete_sheet') {
        const ws = wb.getWorksheet(params.sheet_name || params.sheet)
        if (!ws) return `❌ Sheet not found.`
        if (wb.worksheets.length === 1) return '❌ Cannot delete the only sheet in the workbook.'
        wb.removeWorksheet(ws.id)
        await wb.xlsx.writeFile(filePath)
        return `✅ Deleted sheet "${ws.name}".`
      }

      const ws = getSheet(wb, params.sheet)
      if (!ws) return '❌ Target sheet not found.'

      // ── WRITE CELL ────────────────────────────────────────────────────
      if (action === 'write_cell') {
        if (!params.cell) return '❌ cell is required (e.g. "B2").'
        ws.getCell(params.cell).value = params.value
        await wb.xlsx.writeFile(filePath)
        return `✅ Set ${ws.name}!${params.cell} = ${params.value}`
      }

      // ── WRITE ROWS ────────────────────────────────────────────────────
      if (action === 'write_rows') {
        const rows: any[][] = Array.isArray(params.rows) ? params.rows : []
        if (rows.length === 0) return '❌ rows array is required.'
        if (params.start_row && Number(params.start_row) > 0) {
          let r = Number(params.start_row)
          for (const row of rows) {
            ws.insertRow(r, row)
            r++
          }
        } else {
          rows.forEach((row) => ws.addRow(row))
        }
        await wb.xlsx.writeFile(filePath)
        return `✅ Wrote ${rows.length} row(s) to "${ws.name}".`
      }

      // ── READ RANGE ────────────────────────────────────────────────────
      if (action === 'read_range') {
        const rg = parseRange(params.range || '')
        if (!rg) return '❌ Invalid range (expected like "A1:C5").'
        const out: string[] = []
        for (let r = rg.s.row; r <= rg.e.row; r++) {
          const line: string[] = []
          for (let c = rg.s.col; c <= rg.e.col; c++) {
            const v = ws.getCell(r, c).value as any
            line.push(v == null ? '' : String(v.text ?? v.result ?? v))
          }
          out.push(line.join(' | '))
        }
        return `Range ${params.range} of "${ws.name}":\n${out.join('\n')}`
      }

      // ── SET FORMULA ───────────────────────────────────────────────────
      if (action === 'set_formula') {
        if (!params.cell || !params.formula) return '❌ cell and formula are required.'
        const formula = String(params.formula).replace(/^=/, '')
        ws.getCell(params.cell).value = { formula }
        await wb.xlsx.writeFile(filePath)
        return `✅ Set formula ${ws.name}!${params.cell} = ${formula}`
      }

      // ── FORMAT CELL / RANGE ───────────────────────────────────────────
      if (action === 'format_cell') {
        const rg = parseRange(params.range || params.cell || '')
        if (!rg) return '❌ Provide a cell or range to format.'
        const fontColor = toArgb(params.font_color)
        const fillColor = toArgb(params.fill_color)
        for (let r = rg.s.row; r <= rg.e.row; r++) {
          for (let c = rg.s.col; c <= rg.e.col; c++) {
            const cell = ws.getCell(r, c)
            const font: any = { ...(cell.font || {}) }
            if (params.bold !== undefined) font.bold = !!params.bold
            if (params.italic !== undefined) font.italic = !!params.italic
            if (fontColor) font.color = { argb: fontColor }
            cell.font = font
            if (fillColor) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } }
            }
            if (params.number_format) cell.numFmt = String(params.number_format)
          }
        }
        await wb.xlsx.writeFile(filePath)
        return `✅ Formatted ${params.range || params.cell} on "${ws.name}".`
      }

      // ── COLUMN WIDTH ──────────────────────────────────────────────────
      if (action === 'set_column_width') {
        if (!params.column) return '❌ column is required (letter or number).'
        const colNum = /^\d+$/.test(String(params.column))
          ? Number(params.column)
          : colToNum(String(params.column))
        ws.getColumn(colNum).width = Number(params.width) || 15
        await wb.xlsx.writeFile(filePath)
        return `✅ Set column ${numToCol(colNum)} width to ${ws.getColumn(colNum).width}.`
      }

      // ── AUTOFIT ───────────────────────────────────────────────────────
      if (action === 'autofit') {
        ws.columns.forEach((col: any) => {
          let max = 10
          col.eachCell?.({ includeEmpty: false }, (cell: any) => {
            const len = String(cell.value?.text ?? cell.value?.result ?? cell.value ?? '').length
            if (len > max) max = len
          })
          col.width = Math.min(max + 2, 60)
        })
        await wb.xlsx.writeFile(filePath)
        return `✅ Auto-fitted columns on "${ws.name}".`
      }

      // ── SORT ──────────────────────────────────────────────────────────
      if (action === 'sort') {
        if (!params.column) return '❌ column is required (letter or number).'
        const colIdx = /^\d+$/.test(String(params.column))
          ? Number(params.column)
          : colToNum(String(params.column))
        const hasHeader = params.has_header !== false
        const desc = String(params.order || 'asc').toLowerCase() === 'desc'

        const all: any[][] = []
        ws.eachRow({ includeEmpty: false }, (row: any) => {
          all.push((row.values as any[]).slice(1))
        })
        if (all.length === 0) return '⚠️ Sheet is empty.'

        const header = hasHeader ? all[0] : null
        const data = hasHeader ? all.slice(1) : all
        data.sort((a, b) => {
          const av = a[colIdx - 1]
          const bv = b[colIdx - 1]
          const an = Number(av)
          const bn = Number(bv)
          let cmp: number
          if (!isNaN(an) && !isNaN(bn)) cmp = an - bn
          else cmp = String(av ?? '').localeCompare(String(bv ?? ''))
          return desc ? -cmp : cmp
        })

        // ExcelJS spliceRows does not reliably clear a sheet, so we remove
        // and recreate the worksheet to guarantee a clean rewrite.
        const sortedSheetName = ws.name
        wb.removeWorksheet(ws.id)
        const sortedWs = wb.addWorksheet(sortedSheetName)
        if (header) {
          sortedWs.addRow(header)
          sortedWs.getRow(1).font = { bold: true }
        }
        data.forEach((r) => sortedWs.addRow(r))
        await wb.xlsx.writeFile(filePath)
        return `✅ Sorted "${sortedSheetName}" by column ${numToCol(colIdx)} (${desc ? 'desc' : 'asc'}).`
      }

      // ── AUTOFILTER ────────────────────────────────────────────────────
      if (action === 'add_filter') {
        const range = params.range || `A1:${numToCol(ws.columnCount)}${ws.rowCount}`
        ws.autoFilter = range
        await wb.xlsx.writeFile(filePath)
        return `✅ Added filter over ${range} on "${ws.name}".`
      }

      // ── CONDITIONAL FORMAT ────────────────────────────────────────────
      if (action === 'conditional_format') {
        const range = params.range
        if (!range) return '❌ range is required.'
        const operatorMap: Record<string, string> = {
          '>': 'greaterThan',
          '<': 'lessThan',
          '>=': 'greaterThanOrEqual',
          '<=': 'lessThanOrEqual',
          '=': 'equal',
          '==': 'equal'
        }
        const operator = operatorMap[params.operator] || params.operator || 'greaterThan'
        const fill = toArgb(params.fill_color) || 'FFFFFF00'
        ws.addConditionalFormatting({
          ref: range,
          rules: [
            {
              type: 'cellIs',
              operator,
              formulae: [String(params.value ?? 0)],
              priority: 1,
              style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: fill } } }
            }
          ]
        })
        await wb.xlsx.writeFile(filePath)
        return `✅ Added conditional formatting on ${range} (${operator} ${params.value}).`
      }

      return `❌ Unknown Excel action: "${action}".`
    } catch (err) {
      return `❌ Excel operation failed: ${String(err)}`
    }
  })
}
