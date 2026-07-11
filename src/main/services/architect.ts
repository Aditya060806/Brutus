import { IpcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import { GoogleGenAI } from '@google/genai'

/**
 * BRUTUS Architect Mode
 * ---------------------
 * - architect-draft   : ask Gemini to design a concrete project scaffold
 *                       (folders + files + setup commands) as JSON, stored.
 * - architect-execute : materialize the drafted plan on disk (with path
 *                       traversal guards) and optionally run setup commands
 *                       (gated behind an explicit runCommands flag).
 */

interface ArchitectPlan {
  projectName?: string
  summary?: string
  folders?: string[]
  files?: { path: string; content?: string }[]
  commands?: string[]
}

const runCommand = (cmd: string, cwd: string): Promise<string> =>
  new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { cwd })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      out += '\n[timed out after 120s]'
      resolve(out)
    }, 120000)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(out + `\n[exit ${code}]`)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(`error: ${e.message}`)
    })
  })

export default function registerArchitect({ ipcMain }: { ipcMain: IpcMain }) {
  const planPath = path.join(app.getPath('userData'), 'brutus_architect_plan.json')

  // ─── DRAFT ──────────────────────────────────────────────────────────
  ipcMain.handle('architect-draft', async (_event, { goal, geminiKey }) => {
    try {
      if (!geminiKey || String(geminiKey).trim() === '') {
        return { success: false, error: 'Missing Gemini API Key.' }
      }
      if (!goal) return { success: false, error: 'No project goal provided.' }

      const ai = new GoogleGenAI({ apiKey: geminiKey })
      const prompt = `You are a senior software architect. Design a concrete, minimal-but-complete project scaffold for this goal:
"${goal}"

Output ONLY a JSON object (no markdown) with this exact shape:
{
  "projectName": "kebab-case-name",
  "summary": "1-2 sentence description of the project",
  "folders": ["src", "src/components"],
  "files": [
    { "path": "package.json", "content": "...full file content..." },
    { "path": "src/index.js", "content": "..." }
  ],
  "commands": ["npm install"]
}

Rules:
- File "content" must be real, runnable, and reasonably complete (not placeholders).
- Use relative paths only (never absolute, never starting with .. or /).
- Keep it focused: 5-15 files max.
- "commands" should be the setup/install commands to run from the project root.`

      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' }
      })

      let txt = (res.text || '{}').replace(/^```json/i, '').replace(/```$/i, '').trim()
      const plan: ArchitectPlan = JSON.parse(txt)
      await fs.writeFile(planPath, JSON.stringify(plan, null, 2))

      const fileList = (plan.files || []).map((f) => f.path).slice(0, 30)
      return { success: true, plan, summary: plan.summary, projectName: plan.projectName, fileList }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ─── EXECUTE ────────────────────────────────────────────────────────
  ipcMain.handle('architect-execute', async (_event, { baseDir, runCommands }) => {
    try {
      const raw = await fs.readFile(planPath, 'utf-8').catch(() => null)
      if (!raw) return { success: false, error: 'No drafted plan found. Draft a plan first.' }

      const plan: ArchitectPlan = JSON.parse(raw)
      const safeProjectName = (plan.projectName || `project_${Date.now()}`).replace(
        /[<>:"/\\|?*]/g,
        '_'
      )
      const baseRoot = baseDir
        ? path.resolve(baseDir)
        : path.join(app.getPath('documents'), 'BrutusProjects')
      const root = path.join(baseRoot, safeProjectName)
      await fs.mkdir(root, { recursive: true })

      const rootResolved = path.resolve(root)

      // folders
      for (const folder of plan.folders || []) {
        const target = path.resolve(path.join(root, folder))
        if (!target.startsWith(rootResolved)) continue // traversal guard
        await fs.mkdir(target, { recursive: true })
      }

      // files
      let created = 0
      const skipped: string[] = []
      for (const file of plan.files || []) {
        if (!file || !file.path) continue
        const target = path.resolve(path.join(root, file.path))
        if (!target.startsWith(rootResolved)) {
          skipped.push(file.path)
          continue // traversal guard
        }
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, file.content ?? '', 'utf-8')
        created++
      }

      // commands (explicitly gated)
      let cmdOut = ''
      if (runCommands && Array.isArray(plan.commands) && plan.commands.length) {
        for (const cmd of plan.commands.slice(0, 5)) {
          cmdOut += `\n$ ${cmd}\n${await runCommand(cmd, root)}`
        }
      }

      return { success: true, root, created, skipped, ranCommands: !!runCommands, cmdOut }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}
