/**
 * BRUTUS Studio — Claude Code adapter
 * ------------------------------------
 * The best-instrumented agent of the set, so it gets the strongest treatment:
 *
 *  • Headless turns use `-p --output-format stream-json --verbose`, which emits
 *    newline-delimited typed events ending in a `result` message. That makes
 *    turn completion exact rather than inferred from a spinner.
 *  • Permissions go through a real `PreToolUse` hook (installed separately),
 *    so Brutus decides deterministically instead of pattern-matching the TUI.
 *  • `--resume <session_id>` continues a conversation, which is what lets a
 *    canvas string feed a second prompt into the same agent with full context.
 *
 * Flags verified against code.claude.com/docs/en/headless and /cli-reference.
 */
import type { AgentEvent } from '../types'
import { PROMPT_TAIL, registerAdapter, stripAnsi, trimEdges, type AgentAdapter } from './registry'

/**
 * Chrome the interactive TUI leaves around a turn.
 *
 * Only used when Claude Code is being watched in a live terminal; a headless
 * turn reports its result through `stream-json` and never comes near this.
 */
const CLAUDE_CHROME = [
  /^\s*[❯>]\s*$/,
  /shift\+tab to cycle/i,
  /⏵⏵\s*(auto|accept)/i,
  /\besc\b.*\binterrupt\b/i,
  /^\s*\?\s*for shortcuts\s*$/i,
  /^\s*✻\s*Welcome to/i,
  /\bcwd:\s/i
]

/**
 * Run modes map onto Claude Code's permission modes.
 *
 * `bypassPermissions` is deliberately absent: Brutus never launches an agent
 * that cannot be stopped, and the whole point of the policy layer is that a
 * human set the rules once. A user who wants it can still type it themselves.
 */
const claude: AgentAdapter = {
  kind: 'claude',
  label: 'Claude Code',
  accent: 'text-orange-400',
  bin: 'claude',
  install: 'npm i -g @anthropic-ai/claude-code',

  runModes: [
    {
      id: 'default',
      label: 'Ask me',
      blurb: 'Claude asks before edits and commands. Brutus answers what your policy covers.'
    },
    {
      id: 'acceptEdits',
      label: 'Accept edits',
      blurb: 'File writes and common filesystem commands run without asking. Shell still prompts.'
    },
    {
      id: 'plan',
      label: 'Plan only',
      blurb: 'Claude researches and proposes, but changes nothing on disk.'
    },
    {
      id: 'dontAsk',
      label: 'Locked down',
      blurb:
        'Denies anything outside your allow rules and the read-only set. Best for unattended runs.'
    }
  ],
  defaultRunMode: 'default',

  models: [
    { id: '', label: 'CLI default' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' }
  ],
  credentialPath: '.claude',

  interactiveArgs: ({ runMode, model, bypass }) => {
    const args: string[] = []
    // Bypass is only ever reached through an explicit, gated setting; it is
    // never a default and never inferred.
    if (bypass) args.push('--dangerously-skip-permissions')
    else if (runMode && runMode !== 'default') args.push('--permission-mode', runMode)
    if (model) args.push('--model', model)
    return args
  },

  headlessArgs: ({ prompt, runMode, resumeId }) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']
    if (runMode && runMode !== 'default') args.push('--permission-mode', runMode)
    if (resumeId) args.push('--resume', resumeId)
    return args
  },

  supportsHook: true,

  /**
   * stream-json is one JSON object per line. Event types seen in the stream:
   *   system  (subtype init | api_retry | plugin_install)
   *   assistant / user
   *   stream_event  (token deltas, only with --include-partial-messages)
   *   result        (final; ends the turn)
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

    const type = String(msg.type ?? '')

    if (type === 'system') {
      const sid = typeof msg.session_id === 'string' ? msg.session_id : undefined
      if (msg.subtype === 'init' && sid) {
        return { type: 'session', agentSessionId: sid, raw: trimmed }
      }
      return null
    }

    if (type === 'result') {
      const text =
        typeof msg.result === 'string'
          ? msg.result
          : typeof msg.structured_output === 'object'
            ? JSON.stringify(msg.structured_output)
            : ''
      const sid = typeof msg.session_id === 'string' ? msg.session_id : undefined
      return { type: 'turn-complete', text, agentSessionId: sid, raw: trimmed }
    }

    if (type === 'assistant') {
      // content is an array of blocks; surface text and tool names separately.
      const message = msg.message as { content?: unknown[] } | undefined
      const blocks = Array.isArray(message?.content) ? message!.content : []
      const toolBlock = blocks.find((b) => (b as { type?: string })?.type === 'tool_use') as
        | { name?: string }
        | undefined
      if (toolBlock?.name) {
        return { type: 'tool-use', toolName: String(toolBlock.name), raw: trimmed }
      }
      const textBlock = blocks.find((b) => (b as { type?: string })?.type === 'text') as
        | { text?: string }
        | undefined
      if (textBlock?.text) {
        return { type: 'assistant-text', text: String(textBlock.text), raw: trimmed }
      }
      return null
    }

    return null
  },

  /**
   * Interactive fallback: the shapes that mean "waiting for you".
   *
   * "Waiting for you" takes several shapes, and missing any of them means the
   * turn never completes and nothing downstream ever runs:
   *
   *   • the input prompt at the end of the buffer
   *   • the permission-mode footer
   *   • the hint line the newer TUI shows
   *   • a selection menu — observed live as "Enter to select · ↑/↓ to
   *     navigate · Esc to cancel", which is still the agent waiting on a human
   */
  idlePatterns: [
    PROMPT_TAIL,
    /⏵⏵\s*(auto|accept)/i,
    /shift\+tab to cycle/i,
    /\?\s*for shortcuts/i,
    /enter to (select|confirm)/i,
    /esc to (cancel|interrupt|clear)/i
  ],

  extractResponse: (screen) => trimEdges(screen, (line) => CLAUDE_CHROME.some((p) => p.test(line))),

  /**
   * Only used if the hook is unavailable. Claude Code's approval block is a
   * numbered list; option 1 is always the affirmative and the last is the
   * decline.
   */
  approvalPatterns: [
    {
      match: /Do you want to proceed\?[\s\S]{0,400}?\n\s*(?:❯\s*)?1\.\s*Yes/i,
      yes: '1\r',
      no: '3\r',
      describe: (tail) => {
        const clean = stripAnsi(tail)
        const cmd = clean.match(/(?:Bash command|Command)\s*\n\s*(.+)/i)?.[1]
        return cmd ? `Run: ${cmd.trim().slice(0, 160)}` : 'Claude Code is asking to proceed'
      }
    }
  ]
}

registerAdapter(claude)
export default claude
