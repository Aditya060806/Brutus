import fs from 'fs'
import path from 'path'
import {
  DEFAULT_AUTONOMY,
  EMPTY_ENGINE_STATE,
  type AutonomyConfig,
  type Commitment,
  type DeskAction,
  type DeskThread,
  type EngineState
} from './types'

/**
 * Brutus Desk — persistence.
 *
 * Plain JSON under `userData/brutus_desk/`, matching the convention the rest of
 * the app already uses (`brutus_workflows.json`, `commitments.json`). No
 * database: the volumes here are a few thousand rows at most, and a file the
 * user can open, read and back up is worth more than query speed they will
 * never need.
 *
 * ── WHY EVERY WRITE IS ATOMIC ──────────────────────────────────────────────
 * This ledger records what Brutus sent on your behalf. If the process dies
 * mid-write — an update, a crash, the machine sleeping — a plain `writeFile`
 * leaves a truncated file, and the next read finds corrupt JSON. Losing the
 * record of a sent email is worse than the email being slow: the dedupe rail
 * reads this file, so a lost record means Brutus can send the same reply twice.
 *
 * Write to a temp file, fsync, then rename. Rename is atomic on both NTFS and
 * POSIX, so a reader sees either the old file or the new one, never half of one.
 */

/** Injected so tests can point at a temp directory instead of userData. */
let baseDir: string | null = null

export function configureStore(dir: string): void {
  baseDir = dir
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.error('[desk] could not create the store directory:', err)
  }
}

function dir(): string {
  if (!baseDir) throw new Error('Desk store used before configureStore()')
  return baseDir
}

const file = (name: string): string => path.join(dir(), `${name}.json`)

/**
 * Read and parse, degrading to `fallback` on anything unreadable.
 *
 * A corrupt or missing file must never throw. This is called from the engine
 * loop and from IPC handlers; a parse error there would take down the run or
 * the panel, when "there is nothing recorded yet" is both true enough and
 * recoverable.
 */
export function readJson<T>(name: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file(name), 'utf-8')
    const parsed = JSON.parse(raw)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

/** Atomic write — see the note at the top of this file. */
export function writeJson(name: string, value: unknown): void {
  const target = file(name)
  const temp = `${target}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const handle = fs.openSync(temp, 'w')
    try {
      fs.writeFileSync(handle, JSON.stringify(value, null, 2), 'utf-8')
      // Force the bytes to disk before the rename. Without this the rename can
      // land while the contents are still only in the page cache, which is the
      // exact case a power loss turns into an empty-but-valid file.
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temp, target)
  } catch (err) {
    console.error(`[desk] failed to write ${name}:`, err)
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    } catch {
      /* the temp file is debris, not a failure worth reporting twice */
    }
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

export function getConfig(): AutonomyConfig {
  // Spread over the defaults so a config written by an older build gains new
  // keys rather than arriving with `undefined` where a rail expects a number.
  return { ...DEFAULT_AUTONOMY, ...readJson<Partial<AutonomyConfig>>('config', {}) }
}

export function setConfig(patch: Partial<AutonomyConfig>): AutonomyConfig {
  const next = { ...getConfig(), ...patch }
  writeJson('config', next)
  return next
}

// ─── Threads ────────────────────────────────────────────────────────────────

export function getThreads(): DeskThread[] {
  return readJson<DeskThread[]>('threads', [])
}

export function upsertThread(thread: DeskThread): DeskThread[] {
  const all = getThreads()
  const index = all.findIndex((t) => t.threadId === thread.threadId)
  if (index >= 0) all[index] = { ...all[index], ...thread }
  else all.push(thread)
  writeJson('threads', all)
  return all
}

export function getThread(threadId: string): DeskThread | undefined {
  return getThreads().find((t) => t.threadId === threadId)
}

// ─── Commitments ────────────────────────────────────────────────────────────

export function getCommitments(): Commitment[] {
  return readJson<Commitment[]>('commitments', [])
}

export function addCommitment(commitment: Commitment): Commitment[] {
  const all = getCommitments()
  // Same promise, same thread, same due date — the engine re-reads threads, and
  // without this every run would add the sentence again.
  const duplicate = all.some(
    (c) =>
      c.text.trim().toLowerCase() === commitment.text.trim().toLowerCase() &&
      c.threadId === commitment.threadId &&
      c.dueAt === commitment.dueAt
  )
  if (duplicate) return all
  all.push(commitment)
  writeJson('commitments', all)
  return all
}

export function setCommitments(all: Commitment[]): void {
  writeJson('commitments', all)
}

/**
 * Absorb the older `permanent-memory` commitments file.
 *
 * The `save_commitment` voice tool has been writing `{ text, due }` to
 * `userData/BrutusMemory/commitments.json` for a while. Those are real promises
 * the user made, so the Desk adopts them instead of starting empty beside them
 * and quietly showing a different answer to the same question.
 *
 * Idempotent: entries are tagged `legacy` and matched on text, so running twice
 * imports nothing the second time.
 */
export function migrateLegacyCommitments(legacyPath: string): number {
  let raw: string
  try {
    raw = fs.readFileSync(legacyPath, 'utf-8')
  } catch {
    return 0
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 0
  }
  if (!Array.isArray(parsed)) return 0

  const existing = getCommitments()
  const seen = new Set(existing.map((c) => c.text.trim().toLowerCase()))
  let imported = 0

  for (const entry of parsed) {
    const text = String((entry as { text?: unknown })?.text ?? '').trim()
    if (!text || seen.has(text.toLowerCase())) continue

    const dueRaw = (entry as { due?: unknown })?.due
    const dueMs = dueRaw ? Date.parse(String(dueRaw)) : NaN

    existing.push({
      id: `legacy_${Date.now()}_${imported}`,
      text,
      owedBy: 'us',
      dueAt: Number.isFinite(dueMs) ? dueMs : null,
      createdAt: Date.now(),
      legacy: true
    })
    seen.add(text.toLowerCase())
    imported++
  }

  if (imported) setCommitments(existing)
  return imported
}

// ─── Audit ──────────────────────────────────────────────────────────────────

/** Keep the log bounded; older entries are of no operational use. */
const MAX_AUDIT_ENTRIES = 500

export function getAudit(): DeskAction[] {
  return readJson<DeskAction[]>('audit', [])
}

export function recordAction(action: DeskAction): void {
  const all = getAudit()
  all.unshift(action)
  writeJson('audit', all.slice(0, MAX_AUDIT_ENTRIES))
}

// ─── Engine state ───────────────────────────────────────────────────────────

export function getEngineState(): EngineState {
  return { ...EMPTY_ENGINE_STATE, ...readJson<Partial<EngineState>>('engine', {}) }
}

export function setEngineState(patch: Partial<EngineState>): EngineState {
  const next = { ...getEngineState(), ...patch }
  writeJson('engine', next)
  return next
}

/** Every autonomous send in the last 24h — the input to the rate rail. */
export function recentSendsWithin(hours: number, now = Date.now()): number[] {
  const cutoff = now - hours * 3600_000
  return getEngineState().recentSends.filter((t) => t >= cutoff)
}

export function noteSend(now = Date.now()): void {
  const kept = recentSendsWithin(24, now)
  kept.push(now)
  setEngineState({ recentSends: kept })
}
