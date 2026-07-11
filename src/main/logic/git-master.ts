import { IpcMain, BrowserWindow, dialog } from 'electron'
import { execFile } from 'child_process'
import path from 'path'

/**
 * BRUTUS Git Master.
 * ------------------
 * Runs git via execFile (array args → no shell injection), scoped to a
 * working directory. Safe by design: destructive operations (force-push,
 * reset --hard, clean -f, branch -D) are intentionally NOT exposed here;
 * push to a brand-new branch uses `-u origin <branch>` rather than touching
 * an unknown remote default.
 */

const runGit = (
  args: string[],
  cwd: string
): Promise<{ ok: boolean; out: string; err: string }> =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 90000, maxBuffer: 1024 * 1024 * 16, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: (stdout || '').trim(),
          err: (stderr || '').trim() || (err ? err.message : '')
        })
      }
    )
  })

const currentBranch = async (cwd: string): Promise<string> => {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  return r.ok ? r.out : ''
}

export default function registerGitMaster(ipcMain: IpcMain) {
  ipcMain.removeHandler('git-pick-folder')
  ipcMain.handle('git-pick-folder', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win!, {
      title: 'Select a project folder',
      properties: ['openDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return { success: false, canceled: true }
    return { success: true, path: res.filePaths[0] }
  })

  ipcMain.removeHandler('git-op')
  ipcMain.handle('git-op', async (_event, params) => {
    try {
      const action = String(params?.action || '').toLowerCase()
      const cwd = params?.cwd ? path.resolve(String(params.cwd)) : process.cwd()

      // clone/init don't require an existing repo
      if (action === 'clone') {
        if (!params.url) return '❌ url is required to clone.'
        const args = ['clone', String(params.url)]
        if (params.dest) args.push(path.resolve(String(params.dest)))
        const r = await runGit(args, cwd)
        return r.ok ? `✅ Cloned ${params.url}.\n${r.out || r.err}` : `❌ Clone failed: ${r.err}`
      }
      if (action === 'init') {
        const r = await runGit(['init'], cwd)
        return r.ok ? `✅ Initialized a git repository in ${cwd}.` : `❌ ${r.err}`
      }

      // verify it's a repo for the rest
      const check = await runGit(['rev-parse', '--is-inside-work-tree'], cwd)
      if (!check.ok || check.out.trim() !== 'true') {
        return `❌ ${cwd} is not a git repository. Use action "init" or pass the correct cwd.`
      }

      switch (action) {
        case 'status': {
          const r = await runGit(['status', '--short', '--branch'], cwd)
          return r.ok ? `📦 git status (${cwd}):\n${r.out || 'clean'}` : `❌ ${r.err}`
        }
        case 'current_branch': {
          const b = await currentBranch(cwd)
          return b ? `Current branch: ${b}` : '❌ Could not determine current branch.'
        }
        case 'add': {
          const files: string[] = Array.isArray(params.files) ? params.files : []
          const args = files.length ? ['add', ...files] : ['add', '-A']
          const r = await runGit(args, cwd)
          return r.ok
            ? `✅ Staged ${files.length ? files.join(', ') : 'all changes'}.`
            : `❌ ${r.err}`
        }
        case 'commit': {
          if (!params.message) return '❌ A commit message is required.'
          if (params.add_all) await runGit(['add', '-A'], cwd)
          const r = await runGit(['commit', '-m', String(params.message)], cwd)
          if (r.ok) return `✅ Committed: "${params.message}".\n${r.out}`
          if (/nothing to commit/i.test(r.out + r.err)) return '⚠️ Nothing to commit (working tree clean).'
          return `❌ Commit failed: ${r.err || r.out}`
        }
        case 'push': {
          const branch = await currentBranch(cwd)
          // Detect whether the branch already has an upstream.
          const up = await runGit(
            ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
            cwd
          )
          const args = up.ok ? ['push'] : ['push', '-u', 'origin', branch]
          const r = await runGit(args, cwd)
          return r.ok || /everything up-to-date/i.test(r.out + r.err)
            ? `✅ Pushed ${branch}.\n${r.out || r.err}`
            : `❌ Push failed: ${r.err || r.out}`
        }
        case 'pull': {
          const r = await runGit(['pull'], cwd)
          return r.ok ? `✅ Pulled.\n${r.out}` : `❌ Pull failed: ${r.err || r.out}`
        }
        case 'fetch': {
          const r = await runGit(['fetch', '--all'], cwd)
          return r.ok ? `✅ Fetched all remotes.\n${r.out || r.err}` : `❌ ${r.err}`
        }
        case 'branch_list': {
          const r = await runGit(['branch', '-a'], cwd)
          return r.ok ? `🌿 Branches:\n${r.out}` : `❌ ${r.err}`
        }
        case 'branch_create': {
          if (!params.branch) return '❌ branch name is required.'
          const r = await runGit(['checkout', '-b', String(params.branch)], cwd)
          return r.ok ? `✅ Created and switched to "${params.branch}".` : `❌ ${r.err}`
        }
        case 'checkout': {
          if (!params.target) return '❌ target (branch/commit) is required.'
          const r = await runGit(['checkout', String(params.target)], cwd)
          return r.ok ? `✅ Checked out "${params.target}".\n${r.out || r.err}` : `❌ ${r.err}`
        }
        case 'stash': {
          const args = ['stash', 'push']
          if (params.message) args.push('-m', String(params.message))
          const r = await runGit(args, cwd)
          return r.ok ? `✅ Stashed changes.\n${r.out}` : `❌ ${r.err}`
        }
        case 'stash_pop': {
          const r = await runGit(['stash', 'pop'], cwd)
          return r.ok ? `✅ Restored stashed changes.\n${r.out}` : `❌ ${r.err || r.out}`
        }
        case 'log': {
          const n = Number(params.count) || 10
          const r = await runGit(['log', `-n${n}`, '--oneline', '--decorate'], cwd)
          return r.ok ? `🕘 Last ${n} commits:\n${r.out}` : `❌ ${r.err}`
        }
        case 'diff': {
          const args = ['diff']
          if (params.staged) args.push('--staged')
          if (params.file) args.push('--', String(params.file))
          const r = await runGit(args, cwd)
          return r.ok ? `📝 Diff:\n${r.out || '(no changes)'}` : `❌ ${r.err}`
        }
        case 'remote_list': {
          const r = await runGit(['remote', '-v'], cwd)
          return r.ok ? `🔗 Remotes:\n${r.out || '(none)'}` : `❌ ${r.err}`
        }
        default:
          return `❌ Unknown git action: "${action}".`
      }
    } catch (err) {
      return `❌ Git operation failed: ${String(err)}`
    }
  })
}
