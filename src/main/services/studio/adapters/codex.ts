/**
 * BRUTUS Studio — Codex adapter
 * ------------------------------
 * Codex has no hook system, so permissions are handled two ways:
 *   • coarsely, up front, via `--sandbox` (the CLI's own containment), and
 *   • finely, at runtime, by the prompt-watch pattern track.
 *
 * `codex exec --json` gives structured events for headless turns. Note that
 * exec streams progress to stderr and prints only the final message to stdout,
 * which is why the pty (which merges both) is the interactive path and the
 * JSON is parsed line-by-line regardless of stream.
 *
 * `--full-auto` is deprecated in favour of explicit `--sandbox`, so it is not
 * used here.
 *
 * Verified against developers.openai.com/codex/noninteractive.
 */
import type { AgentEvent } from '../types'
import { PROMPT_TAIL, registerAdapter, stripAnsi, trimEdges, type AgentAdapter } from './registry'

/** Chrome the interactive Codex TUI leaves around a turn. */
const CODEX_CHROME = [
  /^\s*[❯>»]\s*$/,
  /press\s+enter\s+to\s+send/i,
  /ctrl\+c\s+to\s+quit/i,
  /\besc\b.*\binterrupt\b/i,
  /^\s*codex\s+v?\d/i,
  /\bsandbox:\s/i
]

const codex: AgentAdapter = {
  kind: 'codex',
  label: 'Codex',
  accent: 'text-emerald-400',
  bin: 'codex',
  install: 'npm i -g @openai/codex',

  runModes: [
    {
      id: 'read-only',
      label: 'Read only',
      blurb: 'Codex can read and reason but cannot modify anything. Safest.'
    },
    {
      id: 'workspace-write',
      label: 'Workspace write',
      blurb: 'Codex may edit files inside the working folder. The usual choice.'
    },
    {
      id: 'danger-full-access',
      label: 'Full access',
      blurb: 'No sandbox at all. Codex can touch anything your user account can.',
      danger: true
    }
  ],
  defaultRunMode: 'read-only',

  models: [
    { id: '', label: 'CLI default' },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'o4-mini', label: 'o4-mini' }
  ],
  credentialPath: '.codex',

  interactiveArgs: ({ runMode, model, bypass }) => {
    const args: string[] = []
    // Bypass replaces the sandbox rather than sitting alongside it — passing
    // both would be contradictory.
    if (bypass) args.push('--dangerously-bypass-approvals-and-sandbox')
    else if (runMode) args.push('--sandbox', runMode)
    if (model) args.push('--model', model)
    return args
  },

  headlessArgs: ({ prompt, runMode }) => {
    const args = ['exec', '--json']
    if (runMode) args.push('--sandbox', runMode)
    args.push(prompt)
    return args
  },

  supportsHook: false,

  /**
   * Codex's JSON is event-shaped. Rather than couple to one schema version,
   * match on the field names that have been stable: a `type`/`msg.type`
   * discriminator, and a terminal event whose name contains "completed".
   */
  parseEvent(line: string): AgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return null
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return null
    }

    const inner = (msg.msg ?? msg) as Record<string, unknown>
    const type = String(inner.type ?? msg.type ?? '')

    if (/thread\.started|session\.created|session_configured/i.test(type)) {
      const sid =
        (typeof inner.thread_id === 'string' && inner.thread_id) ||
        (typeof inner.session_id === 'string' && inner.session_id) ||
        undefined
      return sid ? { type: 'session', agentSessionId: sid, raw: trimmed } : null
    }

    if (/turn\.completed|task_complete|agent_turn_complete/i.test(type)) {
      const text =
        (typeof inner.last_agent_message === 'string' && inner.last_agent_message) ||
        (typeof inner.text === 'string' && inner.text) ||
        ''
      return { type: 'turn-complete', text, raw: trimmed }
    }

    if (/agent_message|item\.completed/i.test(type)) {
      const text =
        (typeof inner.message === 'string' && inner.message) ||
        (typeof inner.text === 'string' && inner.text) ||
        ''
      return text ? { type: 'assistant-text', text, raw: trimmed } : null
    }

    if (/exec_command|tool|function_call/i.test(type)) {
      const name =
        (typeof inner.name === 'string' && inner.name) ||
        (typeof inner.command === 'string' && inner.command) ||
        'tool'
      return { type: 'tool-use', toolName: name, raw: trimmed }
    }

    if (/error/i.test(type)) {
      return { type: 'error', text: String(inner.message ?? 'Codex error'), raw: trimmed }
    }

    return null
  },

  /**
   * Codex draws its prompt with `›` (U+203A), which the previous character
   * class did not contain — so it never reported idle and never handed off.
   * The status footer (`gpt-5… xhigh · ~/some/dir`) is a second, independent
   * signal, which matters because one missed pattern stops the whole canvas.
   */
  idlePatterns: [
    PROMPT_TAIL,
    /press\s+enter\s+to\s+send/i,
    /ctrl\+c\s+to\s+quit/i,
    /send a message|ask codex/i,
    /^\s*(gpt|o\d)[\w.-]*\s+\S+\s+·\s+/im
  ],

  extractResponse: (screen) => trimEdges(screen, (line) => CODEX_CHROME.some((p) => p.test(line))),

  approvalPatterns: [
    {
      // Codex asks to run a command or apply a patch outside its sandbox.
      match:
        /(allow|approve|run)\s+this\s+(command|patch|edit)\??[\s\S]{0,300}?\by(es)?\b\s*\/\s*\bn(o)?\b/i,
      yes: 'y\r',
      no: 'n\r',
      describe: (tail) => {
        const clean = stripAnsi(tail)
        const cmd = clean.match(/\$\s*(.+)/)?.[1]
        return cmd ? `Run: ${cmd.trim().slice(0, 160)}` : 'Codex is asking for approval'
      }
    },
    {
      match: /\n\s*(?:❯\s*)?1[.)]\s*(?:Yes|Approve|Allow)/i,
      yes: '1\r',
      no: '2\r',
      describe: () => 'Codex is asking for approval'
    }
  ]
}

registerAdapter(codex)
export default codex
