/**
 * Phase 2 tests: adapter registry, argv construction, structured-event parsing
 * and approval-pattern matching against realistic CLI output fixtures.
 *
 * These are the parts that silently rot when a CLI changes, so they get real
 * fixtures rather than trivial assertions.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const reg = require('./adapters.test.cjs')
const { getAdapter, listAdapters, adapterAvailability, stripAnsi } = reg

// ═══ Registry ═════════════════════════════════════════════════════════════
const kinds = listAdapters()
  .map((a) => a.kind)
  .sort()
ok(
  'all four adapters register',
  JSON.stringify(kinds) === '["claude","codex","gemini","shell"]',
  kinds.join(',')
)
ok('unknown kind returns null', getAdapter('nope') === null)

const avail = adapterAvailability()
ok('availability lists every adapter', avail.length === 4)
ok(
  'availability reports install hints',
  avail.filter((a) => a.kind !== 'shell').every((a) => a.install.length > 0)
)
ok(
  'availability marks presence honestly',
  avail.every((a) => a.available === !!a.path)
)
console.log(
  '   detected on this machine:',
  avail
    .filter((a) => a.available)
    .map((a) => a.kind)
    .join(', ') || 'none'
)

// ═══ ANSI stripping (everything downstream depends on it) ═════════════════
ok('strips CSI colour codes', stripAnsi('\x1b[31mred\x1b[0m') === 'red')
ok('strips cursor moves', stripAnsi('a\x1b[2Kb') === 'ab')
ok('strips OSC title sequences', stripAnsi('\x1b]0;title\x07x') === 'x')
ok('leaves plain text alone', stripAnsi('Do you want to proceed?') === 'Do you want to proceed?')

// ═══ Claude Code ══════════════════════════════════════════════════════════
const claude = getAdapter('claude')
ok('claude declares hook support', claude.supportsHook === true)
ok('claude never offers bypassPermissions', !claude.runModes.some((m) => /bypass/i.test(m.id)))

const cInteractive = claude.interactiveArgs({ runMode: 'acceptEdits' })
ok(
  'claude interactive passes permission-mode',
  cInteractive.join(' ') === '--permission-mode acceptEdits'
)
ok(
  'claude interactive omits mode for default',
  claude.interactiveArgs({ runMode: 'default' }).length === 0
)

const cHeadless = claude.headlessArgs({ prompt: 'fix the build', runMode: 'default' })
ok('claude headless uses -p', cHeadless[0] === '-p' && cHeadless[1] === 'fix the build')
ok(
  'claude headless requests stream-json',
  cHeadless.includes('--output-format') && cHeadless.includes('stream-json')
)
ok('claude headless passes --verbose', cHeadless.includes('--verbose'))
const cResume = claude.headlessArgs({ prompt: 'next', runMode: 'default', resumeId: 'sess_42' })
ok('claude headless resumes a session', cResume.includes('--resume') && cResume.includes('sess_42'))

// Real stream-json shapes.
const initEv = claude.parseEvent(
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc123', tools: [] })
)
ok(
  'claude parses system/init → session id',
  initEv?.type === 'session' && initEv.agentSessionId === 'abc123'
)

const toolEv = claude.parseEvent(
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }
  })
)
ok('claude parses tool_use', toolEv?.type === 'tool-use' && toolEv.toolName === 'Bash')

const textEv = claude.parseEvent(
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: "I'll add the toggle." }] }
  })
)
ok('claude parses assistant text', textEv?.type === 'assistant-text' && /toggle/.test(textEv.text))

const resultEv = claude.parseEvent(
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Added the toggle and tests pass.',
    session_id: 'abc123'
  })
)
ok('claude parses result → turn-complete', resultEv?.type === 'turn-complete')
ok('claude turn-complete carries the text', /tests pass/.test(resultEv.text))
ok('claude turn-complete carries session id', resultEv.agentSessionId === 'abc123')

ok(
  'claude ignores partial stream_event noise',
  claude.parseEvent(JSON.stringify({ type: 'stream_event', event: {} })) === null
)
ok('claude ignores non-JSON lines', claude.parseEvent('Welcome back Ben!') === null)
ok('claude survives malformed JSON', claude.parseEvent('{"type":"result"') === null)

// Approval prompt fixture, as it appears in the real TUI (with ANSI).
const claudePrompt = `
\x1b[1mBash command\x1b[0m
git commit -am 'Add dark-mode toggle'

Do you want to proceed?
\x1b[36m❯ 1. Yes\x1b[0m
  2. Yes, and don't ask again this session
  3. No, and tell Claude what to do (esc)
`
const cPat = claude.approvalPatterns[0]
ok('claude approval pattern matches the real prompt', cPat.match.test(stripAnsi(claudePrompt)))
ok('claude answers 1 for yes / 3 for no', cPat.yes === '1\r' && cPat.no === '3\r')
ok(
  'claude approval summary extracts the command',
  /git commit/.test(cPat.describe(claudePrompt)),
  cPat.describe(claudePrompt)
)
ok(
  'claude pattern does NOT match ordinary output',
  !cPat.match.test('Running the test suite, 12 passed')
)
ok('claude pattern does NOT match the word yes alone', !cPat.match.test('Yes, that file exists.'))

// ═══ Codex ════════════════════════════════════════════════════════════════
const codex = getAdapter('codex')
ok('codex has no hook support', codex.supportsHook === false)
ok('codex defaults to the safest sandbox', codex.defaultRunMode === 'read-only')
ok(
  'codex marks full access as dangerous',
  codex.runModes.find((m) => m.id === 'danger-full-access').danger === true
)
ok(
  'codex interactive passes --sandbox',
  codex.interactiveArgs({ runMode: 'workspace-write' }).join(' ') === '--sandbox workspace-write'
)

const xHeadless = codex.headlessArgs({ prompt: 'run the tests', runMode: 'workspace-write' })
ok('codex headless uses exec --json', xHeadless[0] === 'exec' && xHeadless.includes('--json'))
ok('codex headless never uses deprecated --full-auto', !xHeadless.includes('--full-auto'))
ok('codex headless puts the prompt last', xHeadless[xHeadless.length - 1] === 'run the tests')

ok(
  'codex parses thread.started',
  codex.parseEvent(JSON.stringify({ type: 'thread.started', thread_id: 't1' }))?.agentSessionId ===
    't1'
)
const xDone = codex.parseEvent(
  JSON.stringify({ type: 'turn.completed', last_agent_message: 'All green.' })
)
ok('codex parses turn.completed', xDone?.type === 'turn-complete' && /All green/.test(xDone.text))
const xNested = codex.parseEvent(
  JSON.stringify({ msg: { type: 'agent_message', message: 'working on it' } })
)
ok('codex parses the nested msg envelope', xNested?.type === 'assistant-text')
ok('codex ignores plain text', codex.parseEvent('Reading files...') === null)

ok(
  'codex y/n pattern matches',
  codex.approvalPatterns[0].match.test('Allow this command? $ rm -rf build  (y/n)')
)
ok('codex numbered pattern matches', codex.approvalPatterns[1].match.test('\n❯ 1. Yes, approve'))
ok(
  'codex pattern ignores prose',
  !codex.approvalPatterns[0].match.test('The command completed successfully')
)

// ═══ Gemini ═══════════════════════════════════════════════════════════════
const gem = getAdapter('gemini')
ok('gemini has no hook support', gem.supportsHook === false)
ok('gemini has no structured parser (honest)', typeof gem.parseEvent === 'undefined')
ok('gemini yolo maps to --yolo', gem.interactiveArgs({ runMode: 'yolo' }).join(' ') === '--yolo')
ok('gemini marks yolo dangerous', gem.runModes.find((m) => m.id === 'yolo').danger === true)
ok('gemini default passes no flags', gem.interactiveArgs({ runMode: 'default' }).length === 0)

// ═══ Shell ════════════════════════════════════════════════════════════════
const sh = getAdapter('shell')
ok('shell offers NO approval patterns', typeof sh.approvalPatterns === 'undefined')
ok('shell has idle prompt detection', sh.idlePatterns.length > 0)
ok(
  'shell idle matches a PowerShell prompt',
  sh.idlePatterns.some((p) => p.test('\nPS D:\\work> '))
)

// ═══ Idle detection must not fire mid-output ══════════════════════════════
ok(
  'claude idle does not match mid-stream text',
  !claude.idlePatterns.some((p) => p.test('Reading app/settings/page.tsx and thinking'))
)

console.log(`PASS ${PASS.length}`)
PASS.forEach((p) => console.log(`  ✓ ${p}`))
if (FAIL.length) {
  console.log(`\nFAIL ${FAIL.length}`)
  FAIL.forEach((f) => console.log(`  ✗ ${f}`))
}
process.exit(FAIL.length ? 1 : 0)
