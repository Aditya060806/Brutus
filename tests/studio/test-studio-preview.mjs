/**
 * Preview detection: what an agent produced, and whether it may be shown.
 *
 * This module decides which strings out of untrusted agent output become a live
 * frame inside Brutus, so the loopback rule and the write-vs-read distinction
 * are the assertions that matter. Everything is pure, so the awkward cases —
 * a URL split across two pty chunks, a README mentioning a remote address, an
 * agent reading twenty HTML files while working — are tests rather than hopes.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

const {
  DevServerWatcher,
  PageWatcher,
  TAIL_BYTES,
  detectDevServerUrl,
  detectWrittenPages,
  isPreviewableFile,
  isWriteTool
} = require('./dev-server.test.cjs')

// ═══ 1. Finding a dev server in real output ═══════════════════════════════

{
  const vite = [
    '  VITE v8.0.8  ready in 340 ms',
    '',
    '  [32m➜[39m  Local:   [36mhttp://localhost:5173/[39m',
    '  ➜  Network: use --host to expose'
  ].join('\n')
  const hit = detectDevServerUrl(vite)
  ok('a vite banner is recognised', hit?.url === 'http://localhost:5173/', hit?.url)
  ok('the port is reported', hit?.port === 5173)
}

ok(
  'ansi colour codes do not hide the url',
  detectDevServerUrl('[36mhttp://127.0.0.1:3000[0m')?.url === 'http://127.0.0.1:3000/'
)

ok(
  'a path on the url is kept',
  detectDevServerUrl('serving http://localhost:8080/admin/')?.url === 'http://localhost:8080/admin/'
)

ok(
  '0.0.0.0 is rewritten to something loadable',
  detectDevServerUrl('listening on http://0.0.0.0:4000')?.url === 'http://localhost:4000/'
)

ok(
  'trailing punctuation is trimmed',
  detectDevServerUrl('open http://localhost:3000/app.')?.url === 'http://localhost:3000/app'
)

{
  // Frameworks print Local first, then Network; a restart prints the new port
  // last. The most recent line is the one that is true now.
  const two = 'Local: http://localhost:3000\nrestarted on http://localhost:3001'
  ok('the last url wins', detectDevServerUrl(two)?.port === 3001)
}

// ── What must never become a frame ──

ok('a remote host is refused', detectDevServerUrl('see https://evil.example:443/x') === null)
ok('a lookalike host is refused', detectDevServerUrl('http://localhost.evil.com:3000/') === null)
ok('a bare host with no port is refused', detectDevServerUrl('visit http://localhost') === null)
ok('the node inspector is ignored', detectDevServerUrl('ws://localhost:9229 debugger') === null)
ok('plain prose finds nothing', detectDevServerUrl('I will now start the server.') === null)
ok('empty input finds nothing', detectDevServerUrl('') === null)
ok('null input does not throw', detectDevServerUrl(null) === null)

// ═══ 2. The per-session watcher ═══════════════════════════════════════════

{
  const w = new DevServerWatcher()
  ok('the first sighting reports', w.push('s1', 'ready http://localhost:5173/')?.port === 5173)
  ok('the same url again is silent', w.push('s1', 'ready http://localhost:5173/') === null)
  ok(
    'a different port is a new sighting',
    w.push('s1', 'now http://localhost:5174/')?.port === 5174
  )
}

{
  // A pty delivers arbitrary slices; a url split down the middle must still be
  // found, or the preview simply never opens for half of all runs.
  const w = new DevServerWatcher()
  ok('half a url reports nothing yet', w.push('s1', 'Local:  http://localho') === null)
  const hit = w.push('s1', 'st:5173/\n')
  ok('the other half completes it', hit?.url === 'http://localhost:5173/', hit?.url)
}

{
  const w = new DevServerWatcher()
  // Padding longer than the tail must not let a split url match across it.
  w.push('s1', 'http://localho')
  w.push('s1', 'x'.repeat(TAIL_BYTES + 50))
  ok('a url separated by more than the tail is not stitched', w.push('s1', 'st:5173/') === null)
}

{
  const w = new DevServerWatcher()
  w.push('s1', 'http://localhost:5173/')
  ok('another session is tracked separately', w.push('s2', 'http://localhost:5173/')?.port === 5173)
  w.forget('s1')
  ok('a forgotten session reports the url again', w.push('s1', 'http://localhost:5173/') !== null)
}

// ═══ 3. Static files — the other half of "show me what was built" ═════════

ok('an html file is previewable', isPreviewableFile('index.html'))
ok('a nested html file is previewable', isPreviewableFile('site/pages/about.html'))
ok('the .htm spelling works too', isPreviewableFile('old.htm'))
ok('case does not matter', isPreviewableFile('INDEX.HTML'))

ok('a stylesheet is not a page', !isPreviewableFile('styles.css'))
ok('a script is not a page', !isPreviewableFile('main.js'))
ok('a source file is not a page', !isPreviewableFile('App.tsx'))
ok('a lookalike name is not a page', !isPreviewableFile('index.html.bak'))
ok('an empty path is not a page', !isPreviewableFile(''))
ok('a null path does not throw', !isPreviewableFile(null))

// ── Write vs read: only a write means "this is the thing I made" ──

ok('Write counts', isWriteTool('Write'))
ok('Edit counts', isWriteTool('Edit'))
ok('MultiEdit counts', isWriteTool('MultiEdit'))
ok('apply_patch counts', isWriteTool('apply_patch'))
ok('str_replace counts', isWriteTool('str_replace_editor'))
ok('case does not matter', isWriteTool('write'))

ok('Read does not count', !isWriteTool('Read'))
ok('Grep does not count', !isWriteTool('Grep'))
ok('Bash does not count', !isWriteTool('Bash'))
ok('an empty tool name does not count', !isWriteTool(''))
ok('a null tool name does not throw', !isWriteTool(null))

// ═══ N. Static pages, read out of the agent's own output ══════════════════

/**
 * The bug these pin: a preview only ever opened for Claude Code, because the
 * detection hung off `PreToolUse` and `supportsHook` is false for Codex, Gemini
 * and the shell node. Ask a Codex agent for an HTML page and the canvas stayed
 * empty — the smallest and most common job the feature exists for.
 */

{
  const claude = '● Write(index.html)\n  ⎿  Wrote 42 lines to index.html'
  ok(
    "Claude Code's Write line is recognised",
    detectWrittenPages(claude).includes('index.html'),
    JSON.stringify(detectWrittenPages(claude))
  )
}

ok(
  'Codex phrasing is recognised',
  detectWrittenPages('applied patch to src/pages/tree.html').includes('src/pages/tree.html')
)

ok(
  'Gemini phrasing is recognised',
  detectWrittenPages('WriteFile: wrote about/team.htm').includes('about/team.htm')
)

ok(
  'an absolute windows path is recognised',
  detectWrittenPages('Created C:\\Users\\Aditya Pandey\\tree.html').some((p) =>
    p.endsWith('tree.html')
  )
)

ok(
  'a closing paren is not part of the name',
  detectWrittenPages('● Update(dist/index.html)').includes('dist/index.html')
)

ok(
  'ansi codes do not hide the path',
  detectWrittenPages('\u001b[32mwrote\u001b[0m a.html').includes('a.html')
)

// The read/write distinction is the whole reason a bare path is not enough.
ok('merely reading a page is not a write', detectWrittenPages('Read(index.html)').length === 0)
ok(
  'a page mentioned in prose is ignored',
  detectWrittenPages('the docs say index.html is the entry point').length === 0
)
ok('a non-page write is ignored', detectWrittenPages('Write(main.ts)').length === 0)
ok('a bare extension is ignored', detectWrittenPages('wrote .html').length === 0)
ok('empty output finds nothing', detectWrittenPages('').length === 0)
ok('null does not throw', detectWrittenPages(null).length === 0)

// ═══ N+1. PageWatcher — existence is what makes stream-reading safe ═══════

{
  const onDisk = new Set(['/repo/index.html'])
  const w = new PageWatcher((p) => onDisk.has(p))
  const resolve = (p) => (p.startsWith('/') ? p : `/repo/${p}`)

  const first = w.push('s1', 'wrote index.html', resolve)
  ok('a page that exists is announced', first.length === 1 && first[0] === '/repo/index.html')

  const again = w.push('s1', 'wrote index.html', resolve)
  ok('the same page is not announced twice', again.length === 0)

  const ghost = w.push('s1', 'wrote missing.html', resolve)
  ok('a path that is not on disk is dropped', ghost.length === 0)

  // ...and is still caught once it appears. A name is only marked seen after it
  // resolved, so an early mention does not poison it.
  onDisk.add('/repo/missing.html')
  const later = w.push('s1', 'and wrote missing.html now', resolve)
  ok('a page announced late is still caught', later.length === 1)

  // Sessions are independent.
  const other = w.push('s2', 'wrote index.html', resolve)
  ok('another session gets its own announcement', other.length === 1)

  w.forget('s1')
  const afterForget = w.push('s1', 'wrote index.html', resolve)
  ok('forgetting a session clears its memory', afterForget.length === 1)
}

{
  // A path split across two pty chunks must still be found.
  const onDisk = new Set(['/repo/tree.html'])
  const w = new PageWatcher((p) => onDisk.has(p))
  const resolve = (p) => (p.startsWith('/') ? p : `/repo/${p}`)

  ok('half a line finds nothing yet', w.push('s1', 'wrote tre', resolve).length === 0)
  ok('the rest completes it', w.push('s1', 'e.html\n', resolve).length === 1)
}

{
  // `markSeen` is the shared gate: whichever detector notices first wins, and
  // the other stays quiet rather than opening a second window.
  const w = new PageWatcher(() => true)
  ok('the first claim wins', w.markSeen('s1', '/repo/a.html') === true)
  ok('a second claim is refused', w.markSeen('s1', '/repo/a.html') === false)
  ok(
    'and the stream detector then stays quiet',
    w.push('s1', 'wrote /repo/a.html', (p) => p).length === 0
  )
}

{
  // A resolver that throws — an unparseable path — must not take the run down.
  const w = new PageWatcher(() => true)
  let threw = false
  try {
    w.push('s1', 'wrote x.html', () => {
      throw new Error('bad path')
    })
  } catch {
    threw = true
  }
  ok('a throwing resolver is contained', !threw)
}

// ═══ Report ═══════════════════════════════════════════════════════════════

for (const p of PASS) console.log(`  ✓ ${p}`)
for (const f of FAIL) console.error(`  ✗ ${f}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exit(FAIL.length ? 1 : 0)
