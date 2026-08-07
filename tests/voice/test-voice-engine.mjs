/**
 * Voice engine resolution: which backend handles speech, and the fallback.
 *
 * ── WHY THIS IS WORTH A SUITE ──────────────────────────────────────────────
 * The whole on-device feature is one branch. `cloud`, `server` and `local` share
 * the same VAD, turn detection, WAV encoding, memory writes and playback — they
 * differ only in which IPC channel transcribes the audio and which mechanism
 * speaks the reply. Get that branch wrong and the failure is quiet: the mic
 * still records, the model still answers, and nothing is ever heard.
 *
 * The stored value is a raw `localStorage` string written by a settings panel
 * and read by the voice service, so it can be anything — a value from an older
 * build, a hand-edited key, or missing entirely. Coercion has to be total.
 *
 * These assertions mirror `speechChannel()` in Brutus-voice-ai.ts and
 * `coerceEngine()` in profile-store.ts. Both are one-liners; both are load-bearing.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const PASS = []
const FAIL = []
const ok = (n, c, extra = '') => (c ? PASS.push(n) : FAIL.push(`${n}${extra ? ` — ${extra}` : ''}`))

// The two functions under test, replicated exactly. They live in files that
// import React/electron and cannot be loaded headlessly, so the suite asserts
// the contract and then verifies the source still matches it (below).
const coerceEngine = (v) => (v === 'server' ? 'server' : v === 'local' ? 'local' : 'cloud')
const speechChannel = (engine) => (engine === 'local' ? 'local-asr' : 'brain-asr')

// ═══ 1. Coercion is total ═════════════════════════════════════════════════

for (const [input, expected] of [
  ['cloud', 'cloud'],
  ['server', 'server'],
  ['local', 'local'],
  ['', 'cloud'],
  [null, 'cloud'],
  [undefined, 'cloud'],
  ['LOCAL', 'cloud'], // case-sensitive on purpose: the writer is our own code
  ['edge', 'cloud'], // a plausible-looking value that was never valid
  ['gemini', 'cloud'],
  ['0', 'cloud']
]) {
  ok(`coerce ${JSON.stringify(input)} -> ${expected}`, coerceEngine(input) === expected)
}

ok(
  'an unknown engine falls back to cloud, not to a local model',
  coerceEngine('something-new') === 'cloud',
  'falling back to `local` would need a model that may not be present'
)

// ═══ 2. Speech channel routing ════════════════════════════════════════════

ok('local transcribes on this machine', speechChannel('local') === 'local-asr')
ok('server transcribes on the Brain Node', speechChannel('server') === 'brain-asr')
ok('cloud does not use the edge ASR path', speechChannel('cloud') === 'brain-asr')

{
  // Only `local` may route to the on-device model. If a future engine were
  // added and accidentally matched here, it would try to transcribe with a
  // model that is not part of its contract.
  const engines = ['cloud', 'server', 'local']
  const localOnly = engines.filter((e) => speechChannel(e) === 'local-asr')
  ok('exactly one engine uses local ASR', localOnly.length === 1 && localOnly[0] === 'local')
}

// ═══ 3. The source still matches these assertions ═════════════════════════
//
// The functions above are copies. These checks fail loudly if the real
// implementations drift away from them, which is the failure mode a replicated
// test otherwise invites.

{
  const voice = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/services/Brutus-voice-ai.ts'),
    'utf8'
  )

  ok('the engine type admits local', /'cloud'\s*\|\s*'server'\s*\|\s*'local'/.test(voice))
  ok('speechChannel() exists', voice.includes('private speechChannel()'))
  ok(
    'speechChannel maps local -> local-asr',
    /this\.engine === 'local' \? 'local-asr' : 'brain-asr'/.test(voice)
  )
  ok(
    'the ASR call site goes through speechChannel',
    voice.includes('invoke(this.speechChannel(), { wavBase64 })'),
    'a hardcoded brain-asr here would silently disable on-device transcription'
  )
  ok(
    'connect() routes local to the edge loop',
    /engine === 'server' \|\| this\.engine === 'local'/.test(voice)
  )
  ok(
    'teardown stops the system synthesiser',
    // Generous window: the call is preceded by an explanatory comment, and this
    // is asserting that teardown cancels speech at all — not where in the body.
    /teardown\(\): void \{[\s\S]{0,600}systemVoice\.cancel\(\)/.test(voice),
    'otherwise ending a session leaves it talking'
  )
  ok(
    'system speech drives the speaking state',
    voice.includes('this.activeAudioNodes.length > 0 || this.systemSpeaking'),
    'the Web Speech API creates no audio node to infer it from'
  )
}

// ═══ 4. Gemini Live reliability and latency ═══════════════════════════════
//
// Four bugs were reported together — high latency, erratic behaviour, sessions
// getting stuck, and the power button switching itself off. Each had a distinct
// cause, and each is one line away from coming back.

{
  const voice = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/services/Brutus-voice-ai.ts'),
    'utf8'
  )

  // ── Latency ──
  // Audio is not sent until a whole packet accumulates, so this value is added
  // to the front of every single reply. It was 4096 samples = 256 ms.
  {
    const match = voice.match(/MIC_CHUNK_SAMPLES_16K = (\d+)/)
    const samples = match ? Number(match[1]) : NaN
    const ms = (samples / 16000) * 1000
    ok('the mic chunk size is declared as a named constant', Number.isFinite(samples))
    ok(
      `mic packets are <= 100 ms (${ms} ms)`,
      ms <= 100,
      'the Live API expects 20-100 ms chunks; larger values are pure added delay'
    )
    ok('mic packets are not so small they thrash the socket', ms >= 20)
    ok('the old 256 ms batching is gone', !/Math\.floor\(4096 \* \(inputSampleRate/.test(voice))
  }

  // ── Erratic behaviour ──
  // `turnComplete: true` means "the user finished speaking, answer now". The
  // app watcher sent it on every window open/close, fabricating user turns and
  // interrupting real ones.
  {
    // The DEFINITION, not the earlier call site — `slice` from the first match
    // lands on `this.startAppWatcher()` and misses the body entirely.
    const watcher = voice.slice(voice.indexOf('startAppWatcher() {'))
    ok(
      'the app watcher does not complete a turn',
      /turnComplete: false/.test(watcher.slice(0, 2500)),
      'turnComplete: true here fabricates a user turn on every app switch'
    )
    ok(
      'the app watcher only injects while idle',
      /_isProcessingTools && this\.activeAudioNodes\.length === 0/.test(watcher.slice(0, 2500)),
      'otherwise it lands mid-sentence and cuts the real turn in half'
    )
    ok(
      'the app watcher poll is not more often than every 5s',
      (() => {
        const m = watcher.match(/\}, (\d+)\)\s*\n\s*\}/)
        return m ? Number(m[1]) >= 5000 : false
      })(),
      'each poll enumerates every running process over IPC'
    )
  }

  // ── Gets stuck ──
  {
    ok(
      'a failed reconnect re-enters the state machine',
      /Reconnect attempt failed[\s\S]{0,300}this\.handleSocketClose\(\)/.test(voice),
      'a bare console.error left isReconnecting true for ever and scheduled nothing'
    )
    ok(
      'there is a whole-attempt connect deadline',
      voice.includes('CONNECT_DEADLINE_MS') && voice.includes('this.connectDeadline'),
      'getUserMedia and addModule can hang without rejecting, stranding isConnecting'
    )
    ok(
      'the deadline is cleared once connected',
      /isReconnecting = false[\s\S]{0,120}clearConnectDeadline\(\)/.test(voice)
    )
    ok('the deadline is cleared on user disconnect', /disconnect\(\): void \{[\s\S]{0,300}clearConnectDeadline\(\)/.test(voice))
  }

  // ── Power button switching itself off ──
  {
    const match = voice.match(/MAX_RECONNECT_ATTEMPTS = (\d+)/)
    ok(
      `it retries more than 3 times (${match?.[1]})`,
      match ? Number(match[1]) > 3 : false,
      'a laptop roaming Wi-Fi or waking from sleep needs more than 3 tries'
    )
  }
}

{
  const root = fs.readFileSync(path.join(ROOT, 'src/renderer/src/IndexRoot.tsx'), 'utf8')
  ok(
    'the UI watchdog requires several consecutive dead polls',
    /DEAD_POLLS_BEFORE_OFF/.test(root),
    'one unlucky sample between a close and its reconnect used to kill the session'
  )
  ok(
    'the watchdog still switches off eventually',
    /setIsSystemActive\(false\)/.test(root),
    'it must not become a watchdog that never fires'
  )
}

{
  const store = fs.readFileSync(path.join(ROOT, 'src/renderer/src/store/profile-store.ts'), 'utf8')
  ok('the store exports coerceEngine', store.includes('export function coerceEngine'))
  ok('the store type admits local', /VoiceEngine = 'cloud' \| 'server' \| 'local'/.test(store))
  ok(
    'the canonical storage key is unchanged',
    store.includes('PREF_KEYS.voiceEngine'),
    '28 call sites read this key as a raw string'
  )
}

{
  // The engine is useless if its channel is not allowlisted — the exact bug
  // that shipped with adb-forget-device.
  const preload = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf8')
  for (const channel of ['local-asr', 'local-voice-status', 'local-voice-warmup']) {
    ok(`${channel} is allowlisted in preload`, preload.includes(`'${channel}'`))
  }
}

{
  // The Web Speech path must not claim it can feed the robot speaker: it
  // produces no PCM, and silently dropping robot audio would look like a
  // hardware fault.
  const sysVoice = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/services/system-voice.ts'),
    'utf8'
  )
  ok('system voice declares it cannot reach the robot', /speaksToRobot = false/.test(sysVoice))
  ok('voice loading handles the async voiceschanged event', sysVoice.includes('voiceschanged'))
}

// ═══ Report ═══════════════════════════════════════════════════════════════

for (const name of PASS) console.log(`  ✓ ${name}`)
for (const name of FAIL) console.error(`  ✗ ${name}`)
console.log(`\n${PASS.length} passed, ${FAIL.length} failed`)
process.exitCode = FAIL.length ? 1 : 0
