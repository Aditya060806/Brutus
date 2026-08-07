import { IpcMain, app } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'

/**
 * BRUTUS VS Code Master — a real VS Code orchestration engine.
 * ------------------------------------------------------------
 * Three control layers, exposed through one `vscode-op` handler:
 *
 *  1. CLI (headless)   — open files/folders, go-to-line, diff, add folder,
 *                        new window, install/uninstall/list extensions.
 *                        Invoked exactly like code.cmd does it:
 *                        Code.exe + resources/app/out/cli.js + ELECTRON_RUN_AS_NODE=1
 *                        (args passed as an array → no shell injection).
 *  2. Settings         — theme / font / any setting, edited via jsonc-parser
 *                        so the user's comments & formatting are preserved.
 *  3. Editor commands  — focus the VS Code window and drive it by keyboard:
 *                        a curated action map (comment, format, go-to-symbol,
 *                        rename, find, split, fold, terminal, …), a universal
 *                        Command Palette runner, free text typing, and timed
 *                        multi-step macros (`sequence`).
 */

// ─── native modules (defensive) ──────────────────────────────────────
let nutjs: any = null
try {
  nutjs = require('@nut-tree-fork/nut-js')
  nutjs.keyboard.config.autoDelayMs = 18
} catch (e) {
  console.warn('⚠️ nut-js unavailable — VS Code editor actions disabled.', e)
}

let windowManager: any = null
try {
  windowManager = require('node-window-manager').windowManager
} catch (e) {
  console.warn('⚠️ node-window-manager unavailable — VS Code focusing disabled.', e)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── locate the VS Code CLI ───────────────────────────────────────────
let codeCache: { exe: string; cli: string } | null | undefined = undefined

function discoverCli(root: string): string | null {
  const direct = path.join(root, 'resources', 'app', 'out', 'cli.js')
  if (fsSync.existsSync(direct)) return direct
  // Modern installs put it under a version-hash subfolder.
  try {
    for (const name of fsSync.readdirSync(root)) {
      const c = path.join(root, name, 'resources', 'app', 'out', 'cli.js')
      if (fsSync.existsSync(c)) return c
    }
  } catch {
    // ignore
  }
  return null
}

async function findCode(): Promise<{ exe: string; cli: string } | null> {
  if (codeCache !== undefined) return codeCache

  const local = process.env.LOCALAPPDATA || ''
  const candidates = [
    path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe'
  ]
  for (const exe of candidates) {
    if (fsSync.existsSync(exe)) {
      const cli = discoverCli(path.dirname(exe))
      if (cli) {
        codeCache = { exe, cli }
        return codeCache
      }
    }
  }

  // PATH fallback: `where code` → ...\bin\code.cmd → root is two levels up
  const fromPath = await new Promise<string | null>((resolve) => {
    execFile('where', ['code'], (err, stdout) => {
      if (err) return resolve(null)
      const first = (stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0]
      resolve(first || null)
    })
  })
  if (fromPath) {
    const root = path.dirname(path.dirname(fromPath))
    const exe = path.join(root, 'Code.exe')
    if (fsSync.existsSync(exe)) {
      const cli = discoverCli(root)
      if (cli) {
        codeCache = { exe, cli }
        return codeCache
      }
    }
  }

  codeCache = null
  return null
}

function runCodeCli(
  code: { exe: string; cli: string },
  args: string[]
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      code.exe,
      [code.cli, ...args],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 16,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: (stdout || '').trim(),
          err: (stderr || '').trim() || (err ? err.message : '')
        })
      }
    )
  })
}

// ─── settings.json (jsonc-parser, comment-preserving) ─────────────────
function findSettingsPath(): string {
  const appData = app.getPath('appData')
  const stable = path.join(appData, 'Code', 'User', 'settings.json')
  const insiders = path.join(appData, 'Code - Insiders', 'User', 'settings.json')
  if (fsSync.existsSync(path.dirname(stable))) return stable
  if (fsSync.existsSync(path.dirname(insiders))) return insiders
  return stable
}

function coerceValue(raw: any): any {
  if (typeof raw !== 'string') return raw
  const t = raw.trim()
  try {
    return JSON.parse(t) // true/false/numbers/arrays/objects/quoted strings
  } catch {
    return raw // plain string (e.g. a theme name)
  }
}

async function setSetting(key: string, value: any): Promise<void> {
  const { modify, applyEdits } = await import('jsonc-parser')
  const p = findSettingsPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  let content = ''
  try {
    content = await fs.readFile(p, 'utf-8')
  } catch {
    // new file
  }
  if (!content.trim()) content = '{}'
  const edits = modify(content, [key], coerceValue(value), {
    formattingOptions: { insertSpaces: true, tabSize: 2 }
  })
  await fs.writeFile(p, applyEdits(content, edits), 'utf-8')
}

async function getSetting(key: string): Promise<any> {
  const { parse } = await import('jsonc-parser')
  const p = findSettingsPath()
  try {
    const obj = parse(await fs.readFile(p, 'utf-8')) || {}
    return obj[key]
  } catch {
    return undefined
  }
}

// ─── keybindings.json (JSONC array, comment-preserving) ───────────────
function findKeybindingsPath(): string {
  const appData = app.getPath('appData')
  const stable = path.join(appData, 'Code', 'User', 'keybindings.json')
  const insiders = path.join(appData, 'Code - Insiders', 'User', 'keybindings.json')
  if (fsSync.existsSync(path.dirname(stable))) return stable
  if (fsSync.existsSync(path.dirname(insiders))) return insiders
  return stable
}

async function addKeybinding(binding: {
  key: string
  command: string
  when?: string
  args?: any
}): Promise<void> {
  const { modify, applyEdits, parse } = await import('jsonc-parser')
  const p = findKeybindingsPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  let content = ''
  try {
    content = await fs.readFile(p, 'utf-8')
  } catch {
    // new file
  }
  if (!content.trim()) {
    content = '// Place your key bindings in this file to override the defaults\n[]'
  }
  let arr = parse(content)
  if (!Array.isArray(arr)) {
    content = '[]'
    arr = []
  }
  const obj: any = { key: binding.key, command: binding.command }
  if (binding.when) obj.when = binding.when
  if (binding.args !== undefined) obj.args = binding.args
  const edits = modify(content, [arr.length], obj, {
    isArrayInsertion: true,
    formattingOptions: { insertSpaces: true, tabSize: 2 }
  })
  await fs.writeFile(p, applyEdits(content, edits), 'utf-8')
}

async function getKeybindings(): Promise<any[]> {
  const { parse } = await import('jsonc-parser')
  try {
    const a = parse(await fs.readFile(findKeybindingsPath(), 'utf-8'))
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

// ─── per-project workspace settings (.vscode/settings.json) ───────────
function workspaceSettingsPath(folder: string): string {
  return path.join(path.resolve(folder), '.vscode', 'settings.json')
}

async function setWorkspaceSetting(folder: string, key: string, value: any): Promise<string> {
  const { modify, applyEdits } = await import('jsonc-parser')
  const p = workspaceSettingsPath(folder)
  await fs.mkdir(path.dirname(p), { recursive: true })
  let content = ''
  try {
    content = await fs.readFile(p, 'utf-8')
  } catch {
    // new file
  }
  if (!content.trim()) content = '{}'
  const edits = modify(content, [key], coerceValue(value), {
    formattingOptions: { insertSpaces: true, tabSize: 2 }
  })
  await fs.writeFile(p, applyEdits(content, edits), 'utf-8')
  return p
}

async function getWorkspaceSetting(folder: string, key: string): Promise<any> {
  const { parse } = await import('jsonc-parser')
  try {
    const obj = parse(await fs.readFile(workspaceSettingsPath(folder), 'utf-8')) || {}
    return obj[key]
  } catch {
    return undefined
  }
}

// ─── editor keyboard control ──────────────────────────────────────────
function focusVSCode(): boolean {
  if (!windowManager) return false
  try {
    if (typeof windowManager.requestAccessibility === 'function') {
      windowManager.requestAccessibility()
    }
    const wins = windowManager.getWindows()
    const target = wins.find((w: any) => {
      try {
        if (!w.isWindow() || !w.isVisible()) return false
        const title = (w.getTitle() || '').toLowerCase()
        const p = (w.path || '').toLowerCase()
        return title.includes('visual studio code') || p.includes('code.exe')
      } catch {
        return false
      }
    })
    if (target) {
      if (typeof target.restore === 'function') target.restore()
      target.bringToTop()
      return true
    }
  } catch {
    // ignore
  }
  return false
}

interface Combo {
  mods?: string[]
  key: string
}

// Curated VS Code (Windows default) shortcuts. Arrays of combos = chords.
const EDITOR_ACTIONS: Record<string, Combo[]> = {
  save: [{ mods: ['LeftControl'], key: 'S' }],
  save_all: [{ mods: ['LeftControl'], key: 'K' }, { key: 'S' }],
  comment_line: [{ mods: ['LeftControl'], key: 'Slash' }],
  uncomment_line: [{ mods: ['LeftControl'], key: 'Slash' }],
  block_comment: [{ mods: ['LeftShift', 'LeftAlt'], key: 'A' }],
  format_document: [{ mods: ['LeftShift', 'LeftAlt'], key: 'F' }],
  organize_imports: [{ mods: ['LeftShift', 'LeftAlt'], key: 'O' }],
  go_to_symbol: [{ mods: ['LeftControl', 'LeftShift'], key: 'O' }],
  go_to_definition: [{ key: 'F12' }],
  peek_definition: [{ mods: ['LeftAlt'], key: 'F12' }],
  go_to_line: [{ mods: ['LeftControl'], key: 'G' }],
  rename_symbol: [{ key: 'F2' }],
  quick_fix: [{ mods: ['LeftControl'], key: 'Period' }],
  find: [{ mods: ['LeftControl'], key: 'F' }],
  replace: [{ mods: ['LeftControl'], key: 'H' }],
  find_in_files: [{ mods: ['LeftControl', 'LeftShift'], key: 'F' }],
  command_palette: [{ mods: ['LeftControl', 'LeftShift'], key: 'P' }],
  quick_open: [{ mods: ['LeftControl'], key: 'P' }],
  toggle_terminal: [{ mods: ['LeftControl'], key: 'Grave' }],
  new_terminal: [{ mods: ['LeftControl', 'LeftShift'], key: 'Grave' }],
  toggle_sidebar: [{ mods: ['LeftControl'], key: 'B' }],
  split_editor: [{ mods: ['LeftControl'], key: 'Backslash' }],
  close_editor: [{ mods: ['LeftControl'], key: 'W' }],
  next_tab: [{ mods: ['LeftControl'], key: 'PageDown' }],
  prev_tab: [{ mods: ['LeftControl'], key: 'PageUp' }],
  duplicate_line: [{ mods: ['LeftShift', 'LeftAlt'], key: 'Down' }],
  move_line_up: [{ mods: ['LeftAlt'], key: 'Up' }],
  move_line_down: [{ mods: ['LeftAlt'], key: 'Down' }],
  delete_line: [{ mods: ['LeftControl', 'LeftShift'], key: 'K' }],
  select_all: [{ mods: ['LeftControl'], key: 'A' }],
  undo: [{ mods: ['LeftControl'], key: 'Z' }],
  redo: [{ mods: ['LeftControl'], key: 'Y' }],
  fold: [{ mods: ['LeftControl', 'LeftShift'], key: 'LeftBracket' }],
  unfold: [{ mods: ['LeftControl', 'LeftShift'], key: 'RightBracket' }],
  trigger_suggest: [{ mods: ['LeftControl'], key: 'Space' }],
  zen_mode: [{ mods: ['LeftControl'], key: 'K' }, { key: 'Z' }]
}

async function pressCombo(combo: Combo): Promise<void> {
  if (!nutjs) return
  const { keyboard, Key } = nutjs
  const mods = (combo.mods || []).map((m) => Key[m]).filter((m) => m !== undefined)
  const main = Key[combo.key]
  if (main === undefined) return
  for (const mod of mods) await keyboard.pressKey(mod)
  await keyboard.pressKey(main)
  await keyboard.releaseKey(main)
  for (const mod of [...mods].reverse()) await keyboard.releaseKey(mod)
}

async function runEditorAction(name: string): Promise<boolean> {
  const combos = EDITOR_ACTIONS[name]
  if (!combos) return false
  for (let i = 0; i < combos.length; i++) {
    await pressCombo(combos[i])
    if (i < combos.length - 1) await sleep(140) // chord gap
  }
  return true
}

async function runPaletteCommand(title: string): Promise<void> {
  if (!nutjs) return
  const { keyboard } = nutjs
  await runEditorAction('command_palette')
  await sleep(280)
  await keyboard.type(title)
  await sleep(280)
  const { Key } = nutjs
  await keyboard.pressKey(Key.Enter)
  await keyboard.releaseKey(Key.Enter)
}

export default function registerVscodeMaster(ipcMain: IpcMain) {
  ipcMain.removeHandler('vscode-status')
  ipcMain.handle('vscode-status', async () => {
    const code = await findCode()
    const settingsPath = findSettingsPath()
    const keybindingsPath = findKeybindingsPath()
    if (!code) {
      return { available: false, path: null, extensions: 0, settingsPath, keybindingsPath }
    }
    const r = await runCodeCli(code, ['--list-extensions'])
    const extensions = r.ok ? r.out.split(/\r?\n/).filter(Boolean).length : 0
    return { available: true, path: code.exe, extensions, settingsPath, keybindingsPath }
  })

  ipcMain.removeHandler('vscode-op')
  ipcMain.handle('vscode-op', async (_event, params) => {
    try {
      const action = String(params?.action || '').toLowerCase()

      // ── editor / palette / typing (need a focused VS Code window) ────
      const editorActions = new Set([
        'editor_action',
        'run_command',
        'type_text',
        'sequence'
      ])

      if (editorActions.has(action)) {
        if (!nutjs) return '❌ Editor control disabled: nut-js native module missing.'
        const focused = focusVSCode()
        if (!focused) {
          return '❌ I could not find an open VS Code window. Open VS Code first.'
        }
        await sleep(300)

        if (action === 'editor_action') {
          const name = String(params.action_name || '').toLowerCase()
          const ok = await runEditorAction(name)
          return ok
            ? `✅ VS Code: ${name.replace(/_/g, ' ')}.`
            : `❌ Unknown editor action "${params.action_name}".`
        }
        if (action === 'run_command') {
          if (!params.command) return '❌ command (palette title) is required.'
          await runPaletteCommand(String(params.command))
          return `✅ Ran VS Code command: "${params.command}".`
        }
        if (action === 'type_text') {
          if (params.text === undefined) return '❌ text is required.'
          await nutjs.keyboard.type(String(params.text))
          return `✅ Typed ${String(params.text).length} characters into VS Code.`
        }
        if (action === 'sequence') {
          const steps: any[] = Array.isArray(params.steps) ? params.steps : []
          if (steps.length === 0) return '❌ steps array is required for a sequence.'
          let count = 0
          for (const step of steps) {
            if (step.wait_ms) {
              await sleep(Math.min(Number(step.wait_ms) || 0, 5000))
            } else if (step.action_name) {
              await runEditorAction(String(step.action_name).toLowerCase())
            } else if (step.command) {
              await runPaletteCommand(String(step.command))
            } else if (step.text !== undefined) {
              await nutjs.keyboard.type(String(step.text))
            }
            count++
            await sleep(160)
          }
          return `✅ Executed VS Code macro of ${count} step(s).`
        }
      }

      // ── settings layer ───────────────────────────────────────────────
      if (action === 'set_setting') {
        if (!params.key) return '❌ key is required.'
        await setSetting(String(params.key), params.value)
        return `✅ Set VS Code setting "${params.key}" = ${JSON.stringify(coerceValue(params.value))}.`
      }
      if (action === 'get_setting') {
        if (!params.key) return '❌ key is required.'
        const v = await getSetting(String(params.key))
        return v === undefined
          ? `Setting "${params.key}" is not set (uses default).`
          : `"${params.key}" = ${JSON.stringify(v)}`
      }
      if (action === 'set_theme') {
        if (!params.theme) return '❌ theme is required.'
        await setSetting('workbench.colorTheme', String(params.theme))
        return `✅ VS Code theme set to "${params.theme}". (Open or reload VS Code to see it.)`
      }
      if (action === 'set_font_size') {
        const size = Number(params.value ?? params.size)
        if (!size || isNaN(size)) return '❌ A numeric font size is required.'
        await setSetting('editor.fontSize', size)
        return `✅ VS Code editor font size set to ${size}.`
      }
      if (action === 'toggle_format_on_save') {
        const cur = await getSetting('editor.formatOnSave')
        const next = !(cur === true)
        await setSetting('editor.formatOnSave', next)
        return `✅ Format on save is now ${next ? 'ON' : 'OFF'}.`
      }
      if (action === 'set_keybinding') {
        if (!params.key || !params.command) return '❌ key and command are required.'
        await addKeybinding({
          key: String(params.key),
          command: String(params.command),
          when: params.when ? String(params.when) : undefined,
          args: params.args
        })
        return `✅ Added keybinding: ${params.key} → ${params.command}${
          params.when ? ` (when ${params.when})` : ''
        }.`
      }
      if (action === 'get_keybindings') {
        const list = await getKeybindings()
        if (!list.length) return 'No custom keybindings are set.'
        return (
          `Custom keybindings (${list.length}):\n` +
          list
            .map((b: any) => `${b.key} → ${b.command}${b.when ? ` [${b.when}]` : ''}`)
            .join('\n')
        )
      }
      if (action === 'set_workspace_setting') {
        if (!params.path || !params.key) {
          return '❌ path (project folder) and key are required.'
        }
        const saved = await setWorkspaceSetting(String(params.path), String(params.key), params.value)
        return `✅ Set workspace setting "${params.key}" = ${JSON.stringify(
          coerceValue(params.value)
        )} in ${saved}.`
      }
      if (action === 'get_workspace_setting') {
        if (!params.path || !params.key) return '❌ path and key are required.'
        const v = await getWorkspaceSetting(String(params.path), String(params.key))
        return v === undefined
          ? `Workspace setting "${params.key}" is not set in ${params.path}.`
          : `"${params.key}" = ${JSON.stringify(v)}`
      }

      // ── CLI layer ────────────────────────────────────────────────────
      const code = await findCode()
      if (!code) {
        return '❌ VS Code CLI not found. Make sure VS Code is installed.'
      }

      switch (action) {
        case 'open': {
          if (!params.path) return '❌ path is required.'
          const target = path.resolve(String(params.path))
          if (params.line) {
            const loc = `${target}:${params.line}${params.col ? `:${params.col}` : ''}`
            const r = await runCodeCli(code, ['-g', loc])
            return r.ok ? `✅ Opened ${target} at line ${params.line}.` : `❌ ${r.err}`
          }
          const flag = params.new_window ? '-n' : '-r'
          const r = await runCodeCli(code, [flag, target])
          return r.ok ? `✅ Opened ${target} in VS Code.` : `❌ ${r.err}`
        }
        case 'goto': {
          if (!params.path || !params.line) return '❌ path and line are required.'
          const loc = `${path.resolve(String(params.path))}:${params.line}${
            params.col ? `:${params.col}` : ''
          }`
          const r = await runCodeCli(code, ['-g', loc])
          return r.ok ? `✅ Jumped to ${loc}.` : `❌ ${r.err}`
        }
        case 'add_folder': {
          if (!params.path) return '❌ path is required.'
          const r = await runCodeCli(code, ['--add', path.resolve(String(params.path))])
          return r.ok ? `✅ Added folder to workspace: ${params.path}.` : `❌ ${r.err}`
        }
        case 'new_window': {
          const args = ['-n']
          if (params.path) args.push(path.resolve(String(params.path)))
          const r = await runCodeCli(code, args)
          return r.ok ? '✅ Opened a new VS Code window.' : `❌ ${r.err}`
        }
        case 'diff': {
          if (!params.file1 || !params.file2) return '❌ file1 and file2 are required.'
          const r = await runCodeCli(code, [
            '--diff',
            path.resolve(String(params.file1)),
            path.resolve(String(params.file2))
          ])
          return r.ok ? `✅ Opened diff view.` : `❌ ${r.err}`
        }
        case 'install_extension': {
          if (!params.extension_id) return '❌ extension_id is required.'
          const r = await runCodeCli(code, [
            '--install-extension',
            String(params.extension_id),
            '--force'
          ])
          if (r.ok || /successfully installed|already installed/i.test(r.out)) {
            return `✅ Installed extension "${params.extension_id}".\n${r.out}`
          }
          return `❌ Failed to install "${params.extension_id}": ${r.err || r.out}`
        }
        case 'uninstall_extension': {
          if (!params.extension_id) return '❌ extension_id is required.'
          const r = await runCodeCli(code, ['--uninstall-extension', String(params.extension_id)])
          if (r.ok || /successfully uninstalled/i.test(r.out)) {
            return `✅ Uninstalled extension "${params.extension_id}".`
          }
          return `❌ Failed to uninstall "${params.extension_id}": ${r.err || r.out}`
        }
        case 'list_extensions': {
          const r = await runCodeCli(code, ['--list-extensions'])
          if (!r.ok) return `❌ ${r.err}`
          const list = r.out.split(/\r?\n/).filter(Boolean)
          return `Installed VS Code extensions (${list.length}):\n${list.join('\n')}`
        }
        default:
          return `❌ Unknown VS Code action: "${action}".`
      }
    } catch (err) {
      return `❌ VS Code operation failed: ${String(err)}`
    }
  })
}
