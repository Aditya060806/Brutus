/**
 * BRUTUS Studio — Gemini CLI adapter
 * -----------------------------------
 * The least instrumented of the three agents, so it leans entirely on the
 * pattern track: no hook system and no stable structured-event contract to
 * key off. That is stated plainly rather than pretended otherwise — the node
 * shows a "pattern-detected" badge so the difference in reliability is visible
 * on the canvas instead of surprising someone mid-run.
 */
import { PROMPT_TAIL, registerAdapter, stripAnsi, trimEdges, type AgentAdapter } from './registry'

/**
 * Chrome the Gemini TUI leaves on screen around its answer: the input box, the
 * hint line, the model/context footer, and the prompt caret.
 */
const GEMINI_CHROME = [
  /^\s*[❯>]\s*$/,
  /type your message/i,
  /ctrl\+c\s+to\s+(quit|exit)/i,
  /\besc\b.*\b(cancel|interrupt)\b/i,
  /\(\s*\d+%\s*context\s*left\s*\)/i,
  /^\s*gemini-[\w.-]+\s*$/i,
  /^\s*using\s+\d+\s+(file|context)/i
]

const gemini: AgentAdapter = {
  kind: 'gemini',
  label: 'Gemini CLI',
  accent: 'text-sky-400',
  bin: 'gemini',
  install: 'npm i -g @google/gemini-cli',

  runModes: [
    {
      id: 'default',
      label: 'Ask me',
      blurb: 'Gemini asks before it acts. Brutus answers what your policy covers.'
    },
    {
      id: 'yolo',
      label: 'Auto approve',
      blurb: 'Gemini acts without asking. Brutus can no longer gate individual actions.',
      danger: true
    }
  ],
  defaultRunMode: 'default',

  models: [
    { id: '', label: 'CLI default' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
  ],
  credentialPath: '.gemini',

  // Gemini CLI has no bypass flag, so `bypass` is deliberately ignored here
  // rather than silently mapped onto --yolo, which is a different thing the
  // user chose separately as a run mode.
  interactiveArgs: ({ runMode, model }) => {
    const args: string[] = runMode === 'yolo' ? ['--yolo'] : []
    if (model) args.push('--model', model)
    return args
  },

  headlessArgs: ({ prompt }) => ['-p', prompt],

  supportsHook: false,

  // No reliable JSON contract, so no parseEvent: the router falls back to
  // idle detection for this adapter.
  idlePatterns: [PROMPT_TAIL, /Type your message/i, /ctrl\+c\s+to\s+(quit|exit)/i],

  /**
   * Strip the TUI furniture from the edges of a turn.
   *
   * Gemini has no structured output, so this is the difference between handing
   * the next agent an answer and handing it an answer wrapped in a status bar.
   */
  extractResponse: (screen) => trimEdges(screen, (line) => GEMINI_CHROME.some((p) => p.test(line))),

  approvalPatterns: [
    {
      match: /(allow|apply|proceed)[\s\S]{0,200}?\(\s*y\s*\/\s*n\s*\)/i,
      yes: 'y\r',
      no: 'n\r',
      describe: (tail) => {
        const clean = stripAnsi(tail).trim().split('\n').filter(Boolean).slice(-2).join(' ')
        return clean.slice(0, 160) || 'Gemini is asking for approval'
      }
    },
    {
      match: /\n\s*(?:❯\s*)?1[.)]\s*(?:Yes|Allow|Approve)/i,
      yes: '1\r',
      no: '2\r',
      describe: () => 'Gemini is asking for approval'
    }
  ]
}

registerAdapter(gemini)
export default gemini
