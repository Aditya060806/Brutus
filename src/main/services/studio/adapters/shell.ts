/**
 * BRUTUS Studio — plain shell adapter
 * ------------------------------------
 * Not an agent: a real terminal node for the things that surround one — dev
 * servers, test watchers, git, builds. It is what makes the canvas a workshop
 * rather than just three chat boxes, and it is the fallback that always works
 * because the binary is guaranteed to exist.
 *
 * No approval patterns: a shell running the user's own commands is the user's
 * business, and inventing prompts to auto-answer here would be wrong.
 */
import { registerAdapter, trimEdges, type AgentAdapter } from './registry'

const isWin = process.platform === 'win32'

/**
 * A shell prompt line, with or without a command echoed after it.
 *
 * PowerShell (`PS C:\dir>`), cmd (`C:\dir>`) and POSIX (`user@host:~$`).
 *
 * The POSIX half deliberately forbids whitespace before the prompt character.
 * An earlier version allowed anything (`[^\n]*[$#%]`), which quietly matched
 * ordinary output: `Tests: 100% passed` ends a turn far more often than a
 * prompt does, and it was being stripped as chrome.
 */
const PROMPT_LINE = /^(?:PS )?[A-Za-z]:\\[^\n>]*>\s*.*$|^\S*[$#%](?:\s.*)?$/

const shell: AgentAdapter = {
  kind: 'shell',
  label: 'Terminal',
  accent: 'text-zinc-400',
  bin: isWin ? 'powershell.exe' : (process.env.SHELL?.split('/').pop() ?? 'bash'),
  install: '',

  runModes: [{ id: 'default', label: 'Shell', blurb: 'A plain terminal in the working folder.' }],
  defaultRunMode: 'default',

  interactiveArgs: () => (isWin ? ['-NoLogo'] : []),

  supportsHook: false,

  // A shell is "idle" when it has drawn a prompt. Covers PowerShell (PS C:\>),
  // cmd (C:\>), and common POSIX prompts.
  idlePatterns: [/\n?(?:PS )?[A-Za-z]:\\[^\n]*>\s*$/, /\n[^\n]*[$#%]\s*$/],

  /**
   * A shell turn renders as: the prompt with the command echoed after it, the
   * command's output, then the next prompt. Only the middle part is the result,
   * so the prompt lines are trimmed off both ends.
   *
   * Edges only — a prompt-looking line inside real output (a grep hit on a
   * shell script, say) is content and must survive.
   */
  extractResponse: (screen) => trimEdges(screen, (line) => PROMPT_LINE.test(line))
}

registerAdapter(shell)
export default shell
