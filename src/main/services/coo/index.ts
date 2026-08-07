import { app, type IpcMain } from 'electron'
import path from 'path'
import * as engine from './engine'
import { replyInThread, getThread as fetchThread } from './gmail-ops'
import { extractAddress } from './rails'
import {
  configureStore,
  getAudit,
  getCommitments,
  getConfig,
  getEngineState,
  getThreads,
  migrateLegacyCommitments,
  noteSend,
  recordAction,
  setCommitments,
  setConfig,
  upsertThread
} from './store'
import type { AutonomyConfig } from './types'

/**
 * Brutus Desk — the IPC surface.
 *
 * Every channel here is also listed in `src/preload/index.ts`. That is not
 * optional: the preload allowlist is enforced, and a missing entry fails only at
 * runtime with "Blocked IPC channel". `tests/renderer/test-ipc-allowlist.mjs`
 * exists to catch exactly that, because it has shipped broken before.
 *
 * There is a second, subtler way to lose a channel: throw while registering it.
 * A build shipped where the Desk view rendered and every button was dead, and
 * the only clue anywhere was "No handler registered for 'desk-state'". Hence the
 * split below — `registerDesk` registers, `boot()` does everything that can
 * fail, and it runs last. `tests/desk/test-desk-register.mjs` pins that order.
 */

/**
 * Set to a message if start-up failed. `desk-state` reports it instead of the
 * handler simply not existing — see the ordering note in `registerDesk`.
 */
let bootError: string | null = null

/**
 * Everything that touches the disk or starts a timer.
 *
 * Separated from handler registration and called AFTER it, and it never
 * rethrows: a Desk that cannot read its own store should be a Desk that says so,
 * not a Desk whose IPC channels do not exist.
 */
function boot(): void {
  try {
    configureStore(path.join(app.getPath('userData'), 'brutus_desk'))
  } catch (err) {
    bootError = `The Desk could not open its data folder: ${String(err)}`
    console.error('[desk] store setup failed:', err)
    return
  }

  // The `save_commitment` voice tool has been writing promises to the older
  // permanent-memory file. Adopt them so the Desk and the voice tool do not
  // show different answers to "what did I promise?".
  try {
    const imported = migrateLegacyCommitments(
      path.join(app.getPath('userData'), 'BrutusMemory', 'commitments.json')
    )
    if (imported) console.log(`[desk] imported ${imported} commitment(s) from voice memory`)
  } catch (err) {
    console.error('[desk] commitment migration failed:', err)
  }

  // Resume the loop if autonomy was left on. `start()` no-ops when it is off.
  try {
    engine.start()
  } catch (err) {
    console.error('[desk] could not start the engine:', err)
  }
}

export default function registerDesk(ipcMain: IpcMain): void {
  // ── Registration first, start-up second. ─────────────────────────────────
  // These `handle()` calls only store a function; they cannot fail. Anything
  // that CAN fail runs in `boot()` below them, so a bad store or a broken timer
  // can never leave the renderer facing "No handler registered for desk-state" —
  // an error that names an Electron internal and tells the user nothing.

  /** Everything the Desk view renders, in one round trip. */
  ipcMain.removeHandler('desk-state')
  ipcMain.handle('desk-state', () => {
    if (bootError) return { success: false, error: bootError }
    try {
      const threads = getThreads()
      return {
        success: true,
        config: getConfig(),
        engine: { ...getEngineState(), busy: engine.isRunning() },
        needsYou: threads
          .filter((t) => t.state === 'needs-you')
          .sort((a, b) => (a.triage?.priority ?? 3) - (b.triage?.priority ?? 3)),
        handled: threads
          .filter((t) => t.state === 'handled')
          .sort((a, b) => (b.lastAutoReplyAt ?? 0) - (a.lastAutoReplyAt ?? 0)),
        triaged: threads.filter((t) => t.state === 'triaged'),
        commitments: getCommitments()
          .filter((c) => !c.doneAt)
          // Overdue first; undated last, since they cannot be late.
          .sort(
            (a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
          ),
        audit: getAudit().slice(0, 50)
      }
    } catch (err) {
      // A corrupt store degrades to an explained empty Desk. `readJson` already
      // swallows parse errors, so reaching here means something worse.
      console.error('[desk] could not build the state snapshot:', err)
      return { success: false, error: `The Desk could not read its data: ${String(err)}` }
    }
  })

  ipcMain.removeHandler('desk-config')
  ipcMain.handle('desk-config', (_event, patch: Partial<AutonomyConfig>) => {
    const next = setConfig(patch || {})
    // Applying config restarts the loop so a new interval — or the kill switch —
    // takes effect immediately rather than after the current wait expires.
    try {
      if (next.level === 'off') engine.stop()
      else engine.start()
    } catch (err) {
      console.error('[desk] could not apply the new config:', err)
    }
    return { success: true, config: next }
  })

  /** Force a pass now, without waiting for the timer. */
  ipcMain.removeHandler('desk-run-now')
  ipcMain.handle('desk-run-now', async () => {
    const result = await engine.runOnce()
    return { success: !result.error, ...result }
  })

  /** The kill switch. Stops the loop and turns autonomy off in one action. */
  ipcMain.removeHandler('desk-stop')
  ipcMain.handle('desk-stop', () => {
    engine.stop()
    const config = setConfig({ level: 'off' })
    recordAction({
      id: `a_${Date.now()}_stop`,
      kind: 'engine',
      at: Date.now(),
      reason: 'Stopped by the user. Autonomy switched off.'
    })
    return { success: true, config }
  })

  /**
   * Send a held draft, after the human has looked at it.
   *
   * Deliberately does NOT consult the rails. The rails answer "may Brutus do
   * this unattended"; this is the user pressing send on something they have
   * read, which is a different question with a different answer.
   */
  ipcMain.removeHandler('desk-approve')
  ipcMain.handle(
    'desk-approve',
    async (_event, { threadId, body }: { threadId: string; body?: string }) => {
      const thread = getThreads().find((t) => t.threadId === threadId)
      if (!thread?.draft) return { success: false, error: 'No draft for that thread' }

      try {
        const messages = await fetchThread(threadId)
        const last = messages[messages.length - 1]
        const finalBody = (body ?? thread.draft.body).trim()
        if (!finalBody) return { success: false, error: 'The message was empty' }

        await replyInThread({
          threadId,
          inReplyTo: last.messageId,
          references: last.references,
          to: extractAddress(thread.contact),
          subject: thread.draft.subject,
          body: finalBody
        })
        noteSend()

        upsertThread({
          ...thread,
          state: 'handled',
          blockedReason: undefined,
          lastAutoReplyAt: Date.now()
        })
        recordAction({
          id: `a_${Date.now()}_manual`,
          kind: 'manual-send',
          at: Date.now(),
          threadId,
          contact: thread.contact,
          subject: thread.draft.subject,
          body: finalBody,
          reason: 'Approved and sent by you'
        })
        return { success: true }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /** Close a thread without replying. */
  ipcMain.removeHandler('desk-dismiss')
  ipcMain.handle('desk-dismiss', (_event, { threadId }: { threadId: string }) => {
    const thread = getThreads().find((t) => t.threadId === threadId)
    if (!thread) return { success: false, error: 'Unknown thread' }
    upsertThread({ ...thread, state: 'dismissed', blockedReason: undefined })
    return { success: true }
  })

  ipcMain.removeHandler('desk-commitment-done')
  ipcMain.handle('desk-commitment-done', (_event, { id }: { id: string }) => {
    const all = getCommitments()
    const target = all.find((c) => c.id === id)
    if (!target) return { success: false, error: 'Unknown commitment' }
    target.doneAt = Date.now()
    setCommitments(all)
    return { success: true }
  })

  // Every channel above is now reachable. Only now do the work that can fail.
  boot()
}
