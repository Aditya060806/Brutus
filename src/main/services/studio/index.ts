/**
 * BRUTUS Studio — service entry point
 * ------------------------------------
 * Owns the pty manager, the policy engine and the IPC surface.
 *
 *   studio-available   is the terminal engine usable on this machine?
 *   studio-agents      adapter roster with live binary detection
 *   studio-spawn       start a real terminal running a real binary
 *   studio-write       type into it (a human keystroke, or Brutus)
 *   studio-resize      reflow the TUI
 *   studio-kill        stop a session
 *   studio-scrollback  replay history into a re-mounted node
 *   studio-sessions    list live sessions
 *   studio-approve     answer a pending permission request
 *   studio-autonomy    read/set how much Brutus decides on its own
 *
 * ── HOW BRUTUS BECOMES THE BRAIN ───────────────────────────────────────────
 * Two tracks converge on ONE policy:
 *
 *   Claude Code → a real `PreToolUse` HTTP hook. Structured, deterministic.
 *   Codex/Gemini → the prompt watcher reading the terminal like a human.
 *
 * Both call `decide()`. `allow` proceeds silently, `deny` is refused, and `ask`
 * raises a card on the canvas and BLOCKS until the human answers. Nothing that
 * was not positively recognised is ever auto-approved.
 */
import { IpcMain, BrowserWindow, app, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { spawn } from 'child_process'
import { PtyManager, defaultShell, ptyAvailable } from './pty-manager'
import {
  adapterAvailability,
  binaryIssue,
  clearDetectCache,
  detectBinary,
  getAdapter,
  type AgentAdapter
} from './adapters/registry'
// Importing an adapter registers it. Add a file, get a node.
import './adapters/claude'
import './adapters/codex'
import './adapters/gemini'
import './adapters/shell'
import {
  createWorkspace,
  deleteWorkspace,
  exportWorkspace,
  importWorkspace,
  listWorkspaces,
  readWorkspace,
  saveWorkspace
} from './workspace'
import { getDock, resetDock, setDock, studioConfig } from './dock'
import {
  busyRepoCount,
  commitAndMerge,
  createWorktree,
  git,
  listOrphanedWorktrees,
  removeWorktree,
  type OrphanedWorktree,
  type Worktree
} from './worktree'
import { decide, describeToolCall, type Autonomy } from './policy'
import { startPolicyServer, type PolicyServerHandle } from './policy-server'
import { installClaudeHook, uninstallClaudeHook } from './hook-install'
import { PromptWatcher } from './prompt-watch'
import { StudioRouter, reframeWithModel, type CompletionLike, type RouterGraph } from './router'
import { DevServerWatcher, PageWatcher, isPreviewableFile, isWriteTool } from './dev-server'
import { ProjectJournal, filesFromToolInput, resolveProjectRoot } from './project'
import { COMMAND_SYSTEM, commandPrompt, validateMutations } from './command'
import {
  MISSION_SYSTEM,
  MissionTracker,
  estimateComplexity,
  missionEdges,
  missionPrompt,
  validateMission,
  type MissionPlan
} from './mission'
import {
  allRecords,
  configureRecords,
  deleteRecord,
  deriveChecklist,
  filterOptions,
  getRecord,
  patchRecord,
  reconcileRunning,
  searchRecords,
  sectionsFromMission,
  setChecklistItem,
  removeSamples,
  upsertRecord,
  type ChecklistItem,
  type RecordQuery,
  type TaskRecord
} from './records'
import { sampleRecords } from './record-seeds'
import { buildPacket } from './packet'
import { buildPacketPdf } from './packet-pdf'
import { Telemetry, parseLegacyLine } from './telemetry'
import { getSharedModelRouter } from '../orchestrator'
import type {
  AgentKind,
  PolicyRequest,
  PolicyResult,
  StudioApproval,
  StudioEvent,
  StudioWorkspace
} from './types'

interface RegisterOpts {
  ipcMain: IpcMain
  getWindow: () => BrowserWindow | null
}

/**
 * How long a permission request may sit unanswered before Brutus steps aside.
 *
 * Kept under the hook's own 30s timeout so we always respond first. Timing out
 * resolves to `ask`, which hands the decision back to Claude Code's built-in
 * prompt — the human still decides, just in the terminal instead of on canvas.
 */
const APPROVAL_TIMEOUT_MS = 25_000

/**
 * How long after a `PreToolUse` hook to look for the file it named.
 *
 * The hook fires before the write, so the file is not there yet. Long enough for
 * the tool to have finished, short enough that the preview still feels immediate.
 */
const WRITE_SETTLE_MS = 600

interface SessionMeta {
  kind: AgentKind
  cwd: string
  runMode: string
  adapter: AgentAdapter | null
  watcher: PromptWatcher | null
  hookInstalled: boolean
  /** Canvas node that owns this terminal — how edges find their endpoints. */
  nodeId: string
  /** Repository root this agent is working in; the journal is keyed by it. */
  projectRoot: string
  /** Isolated worktree, when per-agent isolation is on. */
  worktree: Worktree | null
}

export default function registerStudio({ ipcMain, getWindow }: RegisterOpts): void {
  const manager = new PtyManager({ getWindow })

  const sessions = new Map<string, SessionMeta>()
  const pending = new Map<
    string,
    {
      sessionId: string
      resolve: (r: PolicyResult) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  /** Pattern-track prompts waiting on the human: answered by writing a key. */
  const pendingKeys = new Map<string, { sessionId: string; yes: string; no: string }>()

  /**
   * Nodes with a spawn in flight.
   *
   * `studio-spawn` awaits worktree creation and hook installation, so a second
   * click during that window would start a second pty for one window — the
   * first becoming an orphan the UI has no handle on and cannot kill.
   */
  const spawning = new Set<string>()

  let policyServer: PolicyServerHandle | null = null
  let autonomy: Autonomy = 'guarded'
  let approvalSeq = 0

  /**
   * Live missions, one per workspace.
   *
   * Not a single global. Agents outlive the canvas being closed, so a user can
   * start a crew in one workspace, back out to the launcher and start another
   * elsewhere — and both are genuinely still running. A single slot meant the
   * second `studio-mission-start` aborted the first, and every Dashboard showed
   * whichever mission began last no matter which canvas it was looking at.
   *
   * Keyed by workspace id, which is also what makes re-entering a workspace show
   * its own board again rather than someone else's.
   */
  const missions = new Map<string, MissionTracker>()

  /**
   * The mission that owns a canvas node.
   *
   * Turn, status and exit events arrive with a node id and no workspace, so the
   * owner is found by asking. The map holds one entry per workspace with a crew
   * on it, so this is a handful of lookups at most.
   */
  const missionForNode = (nodeId: string): MissionTracker | null => {
    for (const m of missions.values()) if (m.owns(nodeId)) return m
    return null
  }

  /**
   * Persisted agent task records.
   *
   * A mission itself is in-memory and dies with the process; this is what
   * survives it — the sections each agent produced, the source checklist, and
   * whatever the human wrote about the run afterwards.
   */
  configureRecords(path.join(app.getPath('userData'), 'brutus_studio', 'records'))

  /**
   * Keep a record in step with its live mission.
   *
   * Debounced: a busy crew produces a transition every few hundred milliseconds
   * and each one would otherwise be a synchronous disk write. 300ms coalesces a
   * burst into one, and the timer is unref'd so a pending write cannot hold the
   * process open at quit.
   */
  const recordWrites = new Map<string, { timer: NodeJS.Timeout; write: () => void }>()

  const syncRecord = (recordId: string, tracker: MissionTracker): void => {
    clearTimeout(recordWrites.get(recordId)?.timer)

    const write = (): void => {
      recordWrites.delete(recordId)
      const snapshot = tracker.snapshot()
      patchRecord(recordId, {
        status: snapshot.status,
        sections: sectionsFromMission(snapshot),
        finishedAt: snapshot.finishedAt
      })
    }

    const timer = setTimeout(write, 300)
    timer.unref?.()
    recordWrites.set(recordId, { timer, write })
  }

  /**
   * Write out anything the debounce is still holding.
   *
   * The 300ms window is the whole point of the debounce, and it is also exactly
   * long enough to lose the last transition of a run if the app closes right
   * after a crew finishes — which is when people close it. Flushed on quit so
   * the final state is the one that gets recorded.
   */
  const flushRecordWrites = (): void => {
    for (const { timer, write } of Array.from(recordWrites.values())) {
      clearTimeout(timer)
      try {
        write()
      } catch (err) {
        console.error('[records] flush failed:', err)
      }
    }
    recordWrites.clear()
  }

  const emit = (event: StudioEvent): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('studio-event', event)
  }
  /**
   * One recorder for the whole service.
   *
   * `log()` keeps its old signature so the existing `[scope] message` call
   * sites are untouched — rewriting dozens of them would be churn with no
   * behavioural gain. The line is parsed into structured form on the way
   * through, and the raw line is still emitted so anything already listening
   * keeps working.
   */
  const telemetry = new Telemetry()

  const log = (line: string): void => {
    const { scope, message } = parseLegacyLine(line)
    const level = /fail|error|could not|refus/i.test(message) ? 'warn' : ('info' as 'warn' | 'info')
    telemetry.record(level, scope, 'log', message)
    emit({ type: 'log', line })
  }

  // Stream structured events to the renderer for the Activity panel.
  telemetry.onEvent((event) => emit({ type: 'telemetry', event }))

  /**
   * Seed the demonstration records, once, into a completely empty store.
   *
   * Every part of the review surface is invisible with no records in it, so a
   * first-time user cannot tell a working feature from a new one. The guard is
   * strict — `length === 0`, not "no samples" — so this can never appear
   * alongside real runs, and each seeded record is flagged and removable.
   */
  /**
   * Settle anything a previous run left mid-flight.
   *
   * Missions are in-memory, so a record still marked `running` is describing a
   * crew that died with the last process. Left alone it claims to be in progress
   * forever — showing up under "running" filters and exporting a packet that
   * says the work is ongoing when it stopped days ago.
   */
  try {
    const settled = reconcileRunning()
    if (settled) log(`[records] settled ${settled} record(s) left running by a previous session`)
  } catch (err) {
    console.error('[records] could not reconcile stale records:', err)
  }

  try {
    if (allRecords().length === 0) {
      for (const sample of sampleRecords()) upsertRecord(sample)
      log('[records] seeded 3 sample task records into an empty store')
    }
  } catch (err) {
    console.error('[records] could not seed samples:', err)
  }

  // ── The router: canvas strings as real data flow ──────────────────────────

  /**
   * What every agent in a repository knows about the others.
   *
   * Shared per project root, which is why the root is resolved rather than
   * taken literally: two agents opened in different subfolders of the same repo
   * must land in the same journal, or they cannot coordinate at all.
   */
  const journal = new ProjectJournal()

  /** Node id → display name, so journal entries read like the canvas looks. */
  const nodeTitles = new Map<string, string>()

  const router = new StudioRouter({
    deliver: (sessionId, text) => manager.submit(sessionId, text),
    emit,
    log,
    reframe: async (input) => {
      const span = telemetry.startSpan('router', 'reframe', {
        from: input.fromTitle,
        to: input.toTitle,
        edge: input.edgeKind
      })
      try {
        const model = getSharedModelRouter()
        if (!model) throw new Error('no model router configured')
        const text = await reframeWithModel(model as unknown as CompletionLike, input)
        span.end('ok', { chars: text.length })
        return text
      } catch (err) {
        // Recorded as a span failure, then rethrown: the router's own fallback
        // is what decides whether the handoff survives, not this.
        span.fail(err)
        throw err
      }
    },
    recordTurn: (nodeId, sessionId, summary) => {
      // Before the journal, and before the handoff fires: the dashboard must
      // show a step as done at the moment it finished, not after the next agent
      // has already been prompted.
      missionForNode(nodeId)?.noteTurn(nodeId, summary)

      const meta = sessions.get(sessionId)
      if (!meta?.projectRoot) return
      const agent = nodeTitles.get(nodeId) ?? nodeId
      journal.record(meta.projectRoot, sessionId, { agent, kind: meta.kind, summary })

      /**
       * Fold this turn's work back into the base branch.
       *
       * Only ever with isolation on, because there is nothing to merge
       * otherwise. A conflict is reported and left alone — the branch keeps the
       * work, and resolving it is a human's job.
       */
      if (meta.worktree && studioConfig().autoMerge) {
        const span = telemetry.startSpan('git', 'merge', { agent, branch: meta.worktree.branch })
        void commitAndMerge(meta.worktree, `${agent}: ${summary}`).then((res) => {
          if (res.status === 'merged' || res.status === 'nothing-to-do') span.end('ok', res)
          else span.end(res.status, res)
          if (res.status === 'merged')
            log(`[git] ${agent} merged into ${meta.worktree?.base} (${res.commit})`)
          else if (res.status === 'conflict') {
            manager.setStatus(sessionId, 'awaiting-approval')
            log(`[git] ${agent} hit a merge conflict — resolve branch ${res.branch}`)
          } else if (res.status === 'failed') log(`[git] ${agent} merge failed: ${res.detail}`)
        })
      }
    },
    projectDigest: (targetNodeId, excludeAgent) => {
      const targetSession = router.sessionForNode(targetNodeId)
      const meta = targetSession ? sessions.get(targetSession) : null
      if (!meta?.projectRoot) return ''
      // Off means an agent is told only what its own string carries.
      if (!studioConfig().shareContext) return ''
      return journal.digest(meta.projectRoot, excludeAgent)
    }
  })

  // ── The one decision point both tracks funnel through ─────────────────────

  /**
   * Resolve a policy request, raising it to the human when the answer is
   * `ask`. Returns a promise the caller blocks on, which is what makes the
   * agent genuinely wait rather than racing ahead.
   */
  const resolvePolicy = async (req: PolicyRequest): Promise<PolicyResult> => {
    const meta = req.sessionId ? sessions.get(req.sessionId) : null
    const workingDir = meta?.cwd || req.cwd || ''
    const verdict = decide(req, { autonomy, workingDir })

    /**
     * Harvest which files this agent is touching.
     *
     * Every tool call already passes through here to be judged, so the file
     * paths are free — no extra prompting and nothing to ask the agent for.
     * They become the "files already changed by others" line that stops two
     * agents editing the same file at once.
     */
    if (meta?.projectRoot) {
      const files = filesFromToolInput(req.toolName, req.toolInput, meta.projectRoot)
      if (files.length) journal.noteFiles(req.sessionId, files)

      /**
       * The other half of "show me what was built".
       *
       * A dev server announces itself and `DevServerWatcher` catches it. A single
       * static page announces nothing — an agent asked for one `index.html`
       * writes the file and stops — so there is no URL to scrape and the canvas
       * would stay empty for exactly the smallest, most common job.
       *
       * These paths are already harvested to judge the tool call, and
       * `filesFromToolInput` discards anything outside the project root, so this
       * costs one regex and can only ever name a file inside the user's own
       * repository. Reads are ignored: an agent opens many HTML files while
       * working, and only a write means "this is the thing I made".
       */
      if (isWriteTool(req.toolName)) {
        const page = files.find(isPreviewableFile)
        if (page) {
          const abs = path.join(meta.projectRoot, page)
          /**
           * Checked on a delay, not now.
           *
           * `PreToolUse` runs BEFORE the tool does, so at this instant the file
           * the hook is telling us about does not exist. Announcing it here
           * pointed the frame at nothing, and the preview window spent its three
           * retries failing before settling on "nothing is answering" — for a
           * file that had by then been written perfectly well.
           *
           * The timer is unref'd so a pending check can never hold the process
           * open at quit, and `markSeen` is shared with the stream detector so
           * whichever notices first wins and the other stays quiet.
           */
          const timer = setTimeout(() => {
            let onDisk = false
            try {
              onDisk = fs.statSync(abs).isFile()
            } catch {
              onDisk = false
            }
            if (!onDisk) return
            if (!pages.markSeen(req.sessionId, abs)) return
            announcePage(req.sessionId, abs)
          }, WRITE_SETTLE_MS)
          timer.unref?.()
        }
      }
    }

    if (verdict.decision !== 'ask') {
      log(`[policy] ${verdict.decision.toUpperCase()} ${req.toolName} — ${verdict.reason}`)
      return verdict
    }

    const approval: StudioApproval = {
      id: `ap_${Date.now()}_${++approvalSeq}`,
      nodeId: '',
      sessionId: req.sessionId,
      toolName: req.toolName,
      summary: describeToolCall(req.toolName, req.toolInput),
      detail: { ...req.toolInput, reason: verdict.reason, cwd: workingDir },
      createdAt: Date.now()
    }

    emit({ type: 'approval-required', approval })
    log(`[policy] ASK ${req.toolName} — ${verdict.reason}`)

    return await new Promise<PolicyResult>((resolvePromise) => {
      const timer = setTimeout(() => {
        pending.delete(approval.id)
        emit({ type: 'approval-resolved', approvalId: approval.id, granted: false })
        log(`[policy] ${approval.id} timed out — handing the prompt back to the agent`)
        // Not a denial: let the agent's own prompt take over so the human can
        // still answer in the terminal.
        resolvePromise({ decision: 'ask', reason: 'No answer from the operator in time.' })
      }, APPROVAL_TIMEOUT_MS)

      pending.set(approval.id, { sessionId: req.sessionId, resolve: resolvePromise, timer })
    })
  }

  /** Lazily start the policy server — only when an agent actually needs it. */
  const ensurePolicyServer = async (): Promise<PolicyServerHandle | null> => {
    if (policyServer) return policyServer
    try {
      policyServer = await startPolicyServer(resolvePolicy)
      log(`[policy] server listening on 127.0.0.1:${policyServer.port}`)
      return policyServer
    } catch (err) {
      log(`[policy] could not start the policy server: ${err}`)
      return null
    }
  }

  const stopPolicyServerIfIdle = (): void => {
    const stillHooked = Array.from(sessions.values()).some((m) => m.hookInstalled)
    if (stillHooked || !policyServer) return
    policyServer.close()
    policyServer = null
    log('[policy] server stopped — no hooked agents remain')
  }

  /**
   * Attach the pattern watcher.
   *
   * Every session gets one, because idle detection is how the router knows a
   * turn ended — without it a Claude node could never hand off, since the hook
   * reports permissions but says nothing about the agent finishing.
   *
   * `detectApprovals` is what differs. When Claude Code's hook installed, the
   * watcher does idle only: two permission paths reading the same prompt could
   * type an answer to a question the hook had already decided. When the hook
   * failed to install, the patterns become the fallback they were written as.
   *
   * On the approval path the watcher only tells us a prompt *shape* was seen,
   * not which tool is being called, so the summary is parsed back into a
   * synthetic command and put through the same policy. That way Codex and
   * Gemini obey exactly the rules Claude Code does, not a looser second set.
   */
  const attachWatcher = (
    sessionId: string,
    adapter: AgentAdapter,
    cwd: string,
    detectApprovals: boolean
  ): PromptWatcher => {
    const watcher = new PromptWatcher(
      adapter,
      {
        onBusy: () => manager.setStatus(sessionId, 'busy'),
        onIdle: () => manager.setStatus(sessionId, 'idle'),
        onApproval: (hit) => {
          manager.setStatus(sessionId, 'awaiting-approval')

          const command = hit.summary.replace(/^Run:\s*/i, '')
          const verdict = decide(
            { sessionId, toolName: 'Bash', toolInput: { command }, cwd },
            { autonomy, workingDir: cwd }
          )

          if (verdict.decision === 'allow') {
            log(`[policy] ALLOW (pattern) ${hit.summary} — ${verdict.reason}`)
            manager.write(sessionId, hit.pattern.yes)
            watcher.clearAfterAnswer()
            return
          }
          if (verdict.decision === 'deny') {
            log(`[policy] DENY (pattern) ${hit.summary} — ${verdict.reason}`)
            manager.write(sessionId, hit.pattern.no)
            watcher.clearAfterAnswer()
            return
          }

          const approval: StudioApproval = {
            id: `ap_${Date.now()}_${++approvalSeq}`,
            nodeId: sessions.get(sessionId)?.nodeId ?? '',
            sessionId,
            toolName: adapter.label,
            summary: hit.summary,
            detail: { reason: verdict.reason, cwd },
            createdAt: Date.now(),
            answerKeys: { yes: hit.pattern.yes, no: hit.pattern.no }
          }
          pendingKeys.set(approval.id, {
            sessionId,
            yes: hit.pattern.yes,
            no: hit.pattern.no
          })
          emit({ type: 'approval-required', approval })
          log(`[policy] ASK (pattern) ${hit.summary} — ${verdict.reason}`)
        }
      },
      { detectApprovals }
    )
    return watcher
  }

  /**
   * Watches every stream for an agent announcing a dev server.
   *
   * Lives here rather than in the renderer because a node scrolled off-screen
   * has no mounted terminal — its output never reaches the renderer at all — and
   * "the preview only appears if you happened to be looking at that window" is
   * not a feature anyone would describe as working.
   */
  const devServers = new DevServerWatcher()

  /**
   * Static pages an agent wrote, spotted in its own output.
   *
   * ── WHY THE POLICY HOOK WAS NOT ENOUGH ─────────────────────────────────────
   * The hook path below `resolvePolicy` is precise, and it only ever fires for
   * Claude Code — `supportsHook` is false for Codex, Gemini and the shell node,
   * because `PreToolUse` is a Claude Code feature. A crew where Codex writes the
   * page, or where the hook failed to install, opened no preview at all. That is
   * the smallest and most common job this feature exists for: "make me an HTML
   * page" produces one file, starts no server, and announced nothing.
   *
   * Reading the stream covers every agent. It is less precise, so the existence
   * check is what keeps it honest — a path that is not on disk is not a page.
   */
  const pages = new PageWatcher((abs) => {
    try {
      return fs.statSync(abs).isFile()
    } catch {
      return false
    }
  })

  /**
   * Files a preview window is currently showing, watched for changes.
   *
   * A dev server reloads itself when the agent edits; a static page cannot, so
   * without this the window shows the agent's first draft forever — and the
   * agent's second pass, which is usually the good one, is invisible.
   *
   * Bounded: a long session that previews many pages must not accumulate
   * watchers, and each one is a real OS handle.
   */
  const pageWatches = new Map<string, { watcher: fs.FSWatcher; timer?: NodeJS.Timeout }>()
  const MAX_PAGE_WATCHES = 12
  /** Editors and agents write a file in several bursts; coalesce them. */
  const PAGE_CHANGE_DEBOUNCE_MS = 250

  const watchPage = (absPath: string): void => {
    if (pageWatches.has(absPath)) return

    if (pageWatches.size >= MAX_PAGE_WATCHES) {
      const [oldest] = pageWatches.keys()
      const entry = pageWatches.get(oldest)
      if (entry) {
        clearTimeout(entry.timer)
        entry.watcher.close()
      }
      pageWatches.delete(oldest)
    }

    try {
      const watcher = fs.watch(absPath, { persistent: false }, () => {
        const entry = pageWatches.get(absPath)
        if (!entry) return
        clearTimeout(entry.timer)
        // Debounced: one save produces several change events, and reloading an
        // iframe three times in a row is visible flicker for no gain.
        entry.timer = setTimeout(() => {
          emit({ type: 'preview-changed', url: pathToFileURL(absPath).href })
        }, PAGE_CHANGE_DEBOUNCE_MS)
        entry.timer.unref?.()
      })
      // A watcher that dies — the file was deleted or moved — must not take the
      // process with it. The window simply stops auto-reloading.
      watcher.on('error', () => {
        pageWatches.get(absPath)?.watcher.close()
        pageWatches.delete(absPath)
      })
      pageWatches.set(absPath, { watcher })
    } catch {
      /* not watchable; the reload button still works */
    }
  }

  const closePageWatches = (): void => {
    for (const { watcher, timer } of pageWatches.values()) {
      clearTimeout(timer)
      try {
        watcher.close()
      } catch {
        /* already gone */
      }
    }
    pageWatches.clear()
  }

  /** Announce a page, once, whichever half of the detection found it. */
  const announcePage = (sessionId: string, absPath: string): void => {
    const nodeId = sessions.get(sessionId)?.nodeId ?? ''
    log(`[preview] ${nodeTitles.get(nodeId) ?? 'an agent'} wrote ${path.basename(absPath)}`)
    emit({
      type: 'preview-detected',
      sessionId,
      nodeId,
      url: pathToFileURL(absPath).href,
      port: 0,
      kind: 'file'
    })
    // From here on the window follows the file rather than freezing on the
    // version that happened to exist when it opened.
    watchPage(absPath)
  }

  // Every chunk feeds four tracks: the prompt watcher (permissions + idle), the
  // router (turn transcript + structured events), dev-server detection, and the
  // static pages an agent says it wrote.
  manager.onData((sessionId, chunk) => {
    const meta = sessions.get(sessionId)
    meta?.watcher?.push(chunk)

    const hit = devServers.push(sessionId, chunk)
    if (hit) {
      const nodeId = meta?.nodeId ?? ''
      log(`[preview] ${nodeTitles.get(nodeId) ?? 'an agent'} started a server on ${hit.url}`)
      emit({
        type: 'preview-detected',
        sessionId,
        nodeId,
        url: hit.url,
        port: hit.port,
        kind: 'server'
      })
    }

    /**
     * A printed path may be relative to where the agent is running, or already
     * absolute. Resolving against the session's own cwd is what makes
     * `Write(index.html)` land on the right file when two agents are working in
     * different folders.
     *
     * Anything that resolves OUTSIDE that folder is refused. Terminal output is
     * untrusted — it contains whatever the agent read, including file names from
     * other people's documents — and `path.resolve` will happily follow a
     * `../../..` out of the project and into the rest of the disk. The policy
     * layer's own harvest already enforces this rule; the stream detector has to
     * enforce it too, or it becomes the softer way in.
     */
    const base = meta?.cwd || meta?.projectRoot || ''
    if (base) {
      const contained = (p: string): string => {
        const abs = path.resolve(base, p)
        const rel = path.relative(base, abs)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error('outside the working directory')
        }
        return abs
      }
      for (const abs of pages.push(sessionId, chunk, contained)) {
        announcePage(sessionId, abs)
      }
    }

    for (const event of router.observe(sessionId, chunk)) {
      emit({ type: 'agent-event', sessionId, event })
      // A CLI that reports its own session id makes `--resume` possible later.
      if (event.type === 'session' && event.agentSessionId) {
        manager.setAgentSessionId(sessionId, event.agentSessionId)
      }
    }
  })

  manager.onStatus((sessionId, status) => {
    router.onStatus(sessionId, status)
    // The mission dispatches a root step on its agent's first `idle` — the CLI
    // itself saying it has finished booting and is ready to be typed into.
    const nodeId = sessions.get(sessionId)?.nodeId
    if (nodeId) missionForNode(nodeId)?.noteStatus(nodeId, status)
  })

  const teardownSession = (sessionId: string): void => {
    const meta = sessions.get(sessionId)
    if (!meta) return
    meta.watcher?.dispose()
    router.unbind(sessionId)
    journal.forgetSession(sessionId)
    devServers.forget(sessionId)
    pages.forget(sessionId)

    /**
     * Settle everything this session still owns.
     *
     * A hook request is an HTTP call the agent is blocked on. If the session
     * dies mid-decision, leaving the promise for its 25s timeout means the
     * approval card lingers over a terminal that no longer exists. Pattern
     * approvals are worse: answering one later would write a keystroke into a
     * dead session id, or into whatever session reused it.
     */
    for (const [id, entry] of Array.from(pending.entries())) {
      if (entry.sessionId !== sessionId) continue
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.resolve({ decision: 'deny', reason: 'The agent was closed before this was answered.' })
      emit({ type: 'approval-resolved', approvalId: id, granted: false })
    }
    for (const [id, entry] of Array.from(pendingKeys.entries())) {
      if (entry.sessionId !== sessionId) continue
      pendingKeys.delete(id)
      emit({ type: 'approval-resolved', approvalId: id, granted: false })
    }
    if (meta.worktree) {
      const wt = meta.worktree
      // The directory goes; the branch stays, because unmerged commits live on
      // it and deleting those is never recoverable.
      void removeWorktree(wt).then(() => log(`[git] released ${wt.branch} (branch kept)`))
    }
    if (meta.hookInstalled) {
      // Only remove the hook when no other live session shares this folder.
      const stillUsing = Array.from(sessions.entries()).some(
        ([id, m]) => id !== sessionId && m.hookInstalled && m.cwd === meta.cwd
      )
      if (!stillUsing) {
        const res = uninstallClaudeHook(meta.cwd)
        log(
          res.ok
            ? `[policy] hook removed from ${meta.cwd}`
            : `[policy] hook removal failed: ${res.error}`
        )
      }
    }
    sessions.delete(sessionId)
    stopPolicyServerIfIdle()
  }

  /**
   * A terminal died.
   *
   * The mission is told before teardown, because teardown deletes the session
   * meta the node id is looked up through — after it, there is no way left to
   * know which step this was.
   */
  manager.onExit((sessionId, exitCode) => {
    const nodeId = sessions.get(sessionId)?.nodeId
    if (nodeId) missionForNode(nodeId)?.noteExit(nodeId, exitCode)
    teardownSession(sessionId)
  })

  // An agent process must never outlive the window that owns it, and the hooks
  // it installed must not outlive the app.
  /**
   * Shutdown.
   *
   * Hooks and ptys are cleaned synchronously because leaving either behind is
   * visible to the user next time. Worktree removal is asynchronous and may not
   * finish before the process exits — that is acceptable and deliberate: an
   * orphaned worktree directory is harmless and `git worktree prune` reclaims
   * it, whereas blocking quit on git would make the app feel hung.
   */
  app.on('before-quit', () => {
    // Stop routing before tearing down, so nothing tries to deliver into a
    // terminal that is in the middle of being killed.
    flushRecordWrites()
    closePageWatches()
    for (const m of missions.values()) m.abort('Brutus is closing.')
    router.cancelAll('cancelled: quitting')
    for (const id of Array.from(sessions.keys())) teardownSession(id)
    manager.killAll()
    policyServer?.close()
    policyServer = null
  })

  ipcMain.handle('studio-available', async () => {
    const status = ptyAvailable()
    return { ...status, defaultShell: defaultShell(), platform: process.platform }
  })

  ipcMain.handle(
    'studio-spawn',
    async (
      _e,
      opts: {
        kind?: AgentKind
        file?: string
        args?: string[]
        cwd?: string
        runMode?: string
        cols?: number
        rows?: number
        nodeId?: string
      }
    ) => {
      const nodeKey = typeof opts?.nodeId === 'string' && opts.nodeId ? opts.nodeId : ''
      if (nodeKey && spawning.has(nodeKey)) {
        return { ok: false, error: 'That agent is already starting.' }
      }
      if (nodeKey) spawning.add(nodeKey)

      try {
        const chosen = opts?.cwd && fs.existsSync(opts.cwd) ? opts.cwd : app.getPath('home')
        /**
         * Open at the repository root, not at whatever folder was picked.
         *
         * Picking `src/renderer` and having the agent open there would make it
         * a different "project" from an agent opened at the repo root, and the
         * two would share no context. Resolving up to the `.git` folder is what
         * makes "same project" mean the same thing to everyone on the canvas.
         */
        const project = resolveProjectRoot(chosen)
        const cwd = project.root || chosen
        const kind: AgentKind = opts?.kind ?? 'shell'
        const adapter = getAdapter(kind)

        // The adapter decides the binary and its arguments; an explicit
        // file/args override stays available for the shell node and testing.
        let file = opts?.file
        let args = Array.isArray(opts?.args) ? opts.args : undefined
        const runMode = opts?.runMode ?? adapter?.defaultRunMode ?? 'default'

        const cfg = studioConfig()
        // Bypass is honoured only inside an isolated worktree. The store also
        // enforces this, but an agent launching unsupervised in the real tree
        // is bad enough to be worth checking twice.
        const bypass = cfg.skipPermissions && cfg.worktrees
        /**
         * Only a model the adapter itself declared.
         *
         * The value reaches here from a JSON file on disk, which a user can
         * edit by hand. It becomes a `--model` argument, so while it cannot
         * inject a command (argv, never a shell), an arbitrary string would
         * still be passed to the CLI as a flag value. Validating against the
         * declared list means an unrecognised entry falls back to the CLI's own
         * default instead of being forwarded.
         */
        const requested = cfg.models[kind] || ''
        const model = requested && adapter?.models?.some((m) => m.id === requested) ? requested : ''
        if (requested && !model) {
          log(`[studio] ignoring unknown model "${requested}" for ${kind}`)
        }

        if (adapter && !file) {
          const resolved = detectBinary(adapter.bin)
          if (!resolved) {
            // Distinguish "not installed" from "installed but unlaunchable" —
            // suggesting an install to someone who already installed it is the
            // least useful thing this message could do.
            const issue = binaryIssue(adapter.bin)
            return {
              ok: false,
              error:
                issue ??
                `${adapter.label} is not installed or not on PATH.${
                  adapter.install ? ` Install it with: ${adapter.install}` : ''
                }`
            }
          }
          file = resolved
          args = args ?? adapter.interactiveArgs({ runMode, model, bypass })
        }

        // ── Install the permission hook BEFORE the agent starts ─────────────
        // Claude Code reads its settings at launch, so a hook installed after
        // spawn would not take effect until the next session.
        let hooked = false
        if (adapter?.supportsHook) {
          const server = await ensurePolicyServer()
          if (server) {
            const res = installClaudeHook(cwd, server.url, server.token, 'studio')
            hooked = res.ok
            log(
              res.ok
                ? `[policy] hook installed in ${cwd}${res.backedUp ? ' (existing settings backed up)' : ''}`
                : `[policy] hook install failed: ${res.error}`
            )
          }
        }

        /**
         * Give this agent its own branch and directory.
         *
         * Created before the spawn because the agent has to *start* inside it —
         * moving an already-running CLI is not a thing.
         */
        let worktree: Worktree | null = null
        let runDir = cwd
        if (cfg.worktrees && project.isRepo) {
          const wt = await createWorktree(cwd, opts?.nodeId || kind, `${Date.now()}`)
          if (wt.ok) {
            worktree = wt.worktree
            runDir = wt.worktree.dir
            log(`[git] ${kind} isolated on ${wt.worktree.branch}`)
          } else {
            log(`[git] worktree unavailable (${wt.error}) — running in the working tree`)
          }
        }

        const session = manager.spawn({
          kind,
          file: file || defaultShell(),
          args: args ?? [],
          cwd: runDir,
          runMode,
          cols: opts?.cols,
          rows: opts?.rows
        })

        // Every agent gets a watcher, because the router needs idle detection to
        // know a turn ended. Approval matching is only enabled where it is the
        // real permission path — i.e. no working hook. The shell node declares
        // no approval patterns at all, so it can never be auto-answered.
        const watcher = adapter ? attachWatcher(session.id, adapter, cwd, !hooked) : null

        const nodeId = typeof opts?.nodeId === 'string' ? opts.nodeId : ''
        sessions.set(session.id, {
          kind,
          cwd,
          runMode,
          adapter: adapter ?? null,
          watcher,
          hookInstalled: hooked,
          nodeId,
          projectRoot: project.root,
          worktree
        })
        router.bind(session.id, nodeId, adapter ?? null, {
          cols: session.cols,
          rows: session.rows
        })

        const siblings = Array.from(sessions.values()).filter(
          (m) => m.projectRoot === project.root
        ).length
        log(
          `[project] ${project.name}${project.isRepo ? '' : ' (not a repository)'} — ` +
            `${siblings} agent${siblings === 1 ? '' : 's'} working here`
        )

        return { ok: true, session, hooked, project, branch: worktree?.branch }
      } catch (err) {
        const message = String((err as { message?: string })?.message || err)
        // 193 is ERROR_BAD_EXE_FORMAT. On its own it tells the user nothing;
        // in practice it always means a script was handed to CreateProcess.
        if (message.includes('193')) {
          return {
            ok: false,
            error:
              'Windows refused to launch that file because it is a script, not an executable ' +
              '(error 193). An npm-installed CLI needs its .cmd shim — try reinstalling it with npm.'
          }
        }
        return { ok: false, error: message }
      } finally {
        if (nodeKey) spawning.delete(nodeKey)
      }
    }
  )

  ipcMain.handle('studio-write', async (_e, { id, data }: { id?: string; data?: string }) => {
    if (!id || typeof data !== 'string') return { ok: false, error: 'id and data are required.' }
    return { ok: manager.write(id, data) }
  })

  ipcMain.handle(
    'studio-resize',
    async (_e, { id, cols, rows }: { id?: string; cols?: number; rows?: number }) => {
      if (!id || !cols || !rows) return { ok: false }
      manager.resize(id, cols, rows)
      // The reconstruction must wrap where the real terminal wraps.
      router.resize(id, cols, rows)
      return { ok: true }
    }
  )

  ipcMain.handle('studio-kill', async (_e, { id }: { id?: string }) => {
    if (id) {
      // A chain mid-flight may be about to deliver into exactly this terminal.
      router.cancelAll('cancelled: agent closed')
      manager.kill(id)
    }
    return { ok: true }
  })

  ipcMain.handle('studio-scrollback', async (_e, { id }: { id?: string }) => ({
    ok: true,
    data: id ? manager.scrollbackOf(id) : ''
  }))

  /**
   * Every live session, with the canvas node it belongs to.
   *
   * The node id is what makes leaving a workspace non-destructive: agents keep
   * running in main after the canvas unmounts, and on the way back in the
   * renderer matches each restored node against this list to re-adopt the
   * terminal that was already working rather than offering to start a new one.
   */
  ipcMain.handle('studio-sessions', async () => ({
    ok: true,
    sessions: manager.list().map((s) => ({
      ...s,
      nodeId: sessions.get(s.id)?.nodeId ?? '',
      projectRoot: sessions.get(s.id)?.projectRoot ?? ''
    }))
  }))

  /**
   * Stop agents in one go.
   *
   * The counterpart to agents surviving a workspace being closed: something has
   * to be able to end them, and hunting for the window each one lives in is not
   * that.
   *
   * Scoped by the node ids the calling canvas actually owns. Main has no idea
   * which workspace a session belongs to — only which node — so the canvas says.
   * Without that scope, "Stop all" in one workspace killed a crew still working
   * in another, which is the exact work the survive-on-close behaviour exists to
   * protect. Passing nothing keeps the old meaning: stop everything, everywhere.
   */
  ipcMain.handle(
    'studio-stop-all',
    async (_e, { workspaceId, nodeIds }: { workspaceId?: string; nodeIds?: string[] } = {}) => {
      const scope = Array.isArray(nodeIds) && nodeIds.length ? new Set(nodeIds) : null

      if (scope) {
        const key = String(workspaceId ?? '')
        missions.get(key)?.abort('Every agent in this workspace was stopped.')
      } else {
        for (const m of missions.values()) m.abort('Every agent was stopped.')
      }

      // The router does not track cascades per workspace, so this is all-or-
      // nothing. Stopping a chain that was about to type into a terminal being
      // killed is the safer side of that trade.
      router.cancelAll('cancelled: agents stopped')

      const doomed = manager
        .list()
        .filter((s) => !scope || scope.has(sessions.get(s.id)?.nodeId ?? ''))
      for (const s of doomed) manager.kill(s.id)

      log(`[studio] stopped ${doomed.length} agent(s)`)
      return { ok: true, stopped: doomed.length }
    }
  )

  /**
   * What the agent picker renders. Re-detects on each open so installing an
   * agent while Brutus is running is picked up without a restart.
   */
  ipcMain.handle('studio-agents', async (_e, opts?: { refresh?: boolean }) => {
    if (opts?.refresh) clearDetectCache()
    return { ok: true, agents: adapterAvailability() }
  })

  /**
   * The human's answer to a permission request.
   *
   * Both tracks land here. A hook request resolves the HTTP promise the agent
   * is blocked on; a pattern request writes the adapter's yes/no key into the
   * terminal. Either way the agent was genuinely waiting, not racing ahead.
   */
  ipcMain.handle(
    'studio-approve',
    async (_e, { approvalId, granted }: { approvalId?: string; granted?: boolean }) => {
      if (!approvalId) return { ok: false, error: 'approvalId is required.' }
      const allow = Boolean(granted)

      const hookPending = pending.get(approvalId)
      if (hookPending) {
        clearTimeout(hookPending.timer)
        pending.delete(approvalId)
        hookPending.resolve({
          decision: allow ? 'allow' : 'deny',
          reason: allow ? 'Approved by the operator.' : 'Declined by the operator.'
        })
        emit({ type: 'approval-resolved', approvalId, granted: allow })
        log(`[policy] operator ${allow ? 'approved' : 'declined'} ${approvalId}`)
        return { ok: true }
      }

      const keyPending = pendingKeys.get(approvalId)
      if (keyPending) {
        pendingKeys.delete(approvalId)
        manager.write(keyPending.sessionId, allow ? keyPending.yes : keyPending.no)
        sessions.get(keyPending.sessionId)?.watcher?.clearAfterAnswer()
        emit({ type: 'approval-resolved', approvalId, granted: allow })
        log(`[policy] operator ${allow ? 'approved' : 'declined'} ${approvalId}`)
        return { ok: true }
      }

      return { ok: false, error: 'That request is no longer pending.' }
    }
  )

  ipcMain.handle('studio-autonomy', async (_e, opts?: { autonomy?: Autonomy }) => {
    if (opts?.autonomy && ['guarded', 'strict', 'autonomous'].includes(opts.autonomy)) {
      autonomy = opts.autonomy
      log(`[policy] autonomy set to ${autonomy}`)
    }
    return { ok: true, autonomy }
  })

  /**
   * The canvas graph, pushed whenever it changes.
   *
   * The renderer stays the source of truth for layout; main only needs to know
   * what is wired to what, so routing can happen entirely in the main process
   * without a round trip per handoff.
   */
  ipcMain.handle('studio-graph', async (_e, graph: Partial<RouterGraph>) => {
    router.setGraph(graph ?? {})
    /**
     * Rebuilt rather than merged.
     *
     * Merging leaked: every node ever seen, across every workspace opened this
     * run, stayed in the map forever. The graph that just arrived is the whole
     * truth, so replacing the contents is both correct and self-limiting.
     */
    nodeTitles.clear()
    for (const n of graph?.nodes ?? []) if (n?.id) nodeTitles.set(n.id, n.title ?? n.id)
    return { ok: true }
  })

  /**
   * The command bar: English in, canvas edits out.
   *
   * The model only ever proposes. `validateMutations` resolves every node
   * reference against the real graph and drops anything it cannot account for,
   * so a hallucinated id costs one skipped operation instead of a broken
   * canvas. Applying the result is the renderer's job.
   */
  ipcMain.handle(
    'studio-command',
    async (_e, { instruction }: { instruction?: string }): Promise<Record<string, unknown>> => {
      const text = String(instruction ?? '').trim()
      if (!text) return { ok: false, error: 'Say what you want on the canvas.' }

      const model = getSharedModelRouter()
      if (!model) {
        return { ok: false, error: 'No model is configured. Add a key in Settings first.' }
      }

      const graph = router.getGraph()
      const availableKinds = adapterAvailability()
        .filter((a) => a.available)
        .map((a) => a.kind)

      if (!availableKinds.length) {
        return { ok: false, error: 'No agent CLIs are installed, so there is nothing to add.' }
      }

      try {
        const { data } = await model.completeJson<unknown>({
          role: 'plan',
          system: COMMAND_SYSTEM,
          messages: [
            { role: 'user', content: commandPrompt(text, graph.nodes, graph.edges, availableKinds) }
          ],
          temperature: 0.1,
          maxTokens: 1200
        })

        const { mutations, skipped } = validateMutations(data, {
          nodes: graph.nodes,
          availableKinds
        })

        for (const note of skipped) log(`[command] ${note}`)
        log(`[command] "${text.slice(0, 80)}" → ${mutations.length} change(s)`)

        return { ok: true, mutations, skipped }
      } catch (err) {
        return { ok: false, error: String((err as { message?: string })?.message || err) }
      }
    }
  )

  // ── Dashboard: one request, a crew that runs it ───────────────────────────

  /**
   * Plan only. Nothing is spawned, nothing is typed, no canvas is touched.
   *
   * Split from `studio-mission-start` on purpose: this is about to launch
   * several real CLI processes against the user's repository, so the plan is
   * shown first and the human presses the button. `validateMission` has already
   * removed anything unrunnable by the time it is displayed, so what is on
   * screen is exactly what will happen.
   */
  ipcMain.handle(
    'studio-mission-plan',
    async (_e, { task, workspaceId }: { task?: string; workspaceId?: string }) => {
      const text = String(task ?? '').trim()
      if (!text) return { ok: false, error: 'Say what you want done.' }

      const model = getSharedModelRouter()
      if (!model) {
        return { ok: false, error: 'No model is configured. Add a key in Settings first.' }
      }

      const availableKinds = adapterAvailability()
        .filter((a) => a.available)
        .map((a) => a.kind)
      if (!availableKinds.length) {
        return { ok: false, error: 'No agent CLIs are installed, so there is no crew to assemble.' }
      }

      // Any live session tells us which project the canvas is pointed at, which
      // is worth far more to the planner than the folder name alone.
      const anySession = Array.from(sessions.values())[0]
      const projectRoot = anySession?.projectRoot || ''

      /**
       * Measured before the model is asked, and passed to it.
       *
       * The user never says how many agents to open, so something has to decide.
       * Doing it here rather than leaving it to the model's mood means the crew
       * size has an inspectable reason behind it, and the same request twice
       * lands in the same bracket.
       */
      const complexity = estimateComplexity(text)

      const span = telemetry.startSpan('mission', 'plan', {
        task: text.slice(0, 120),
        complexity: complexity.tier,
        crew: `${complexity.crew.min}-${complexity.crew.max}`
      })
      try {
        const { data } = await model.completeJson<unknown>({
          role: 'plan',
          system: MISSION_SYSTEM,
          messages: [
            {
              role: 'user',
              content: missionPrompt(text, availableKinds, {
                projectName: projectRoot ? path.basename(projectRoot) : undefined,
                rootDir: projectRoot || undefined,
                complexity
              })
            }
          ],
          temperature: 0.2,
          maxTokens: 2000
        })

        const { plan, skipped } = validateMission(data, {
          availableKinds,
          task: text,
          workspaceId: String(workspaceId ?? '')
        })
        for (const note of skipped) log(`[mission] ${note}`)

        if (!plan) {
          span.end('empty')
          return {
            ok: false,
            error: 'That could not be turned into work for coding agents.',
            skipped
          }
        }

        log(
          `[mission] ${complexity.tier} request → ${plan.steps.length} agent(s): ` +
            plan.steps.map((s) => `${s.title} (${s.agentKind})`).join(', ')
        )
        span.end('ok', { steps: plan.steps.length })
        /**
         * The source checklist, derived here rather than asked of the model.
         *
         * `estimateComplexity` has already worked out which areas the request
         * touches; turning each into the input that area needs is a lookup, not
         * a judgement, so it costs nothing and cannot hallucinate a requirement.
         * Returned with the plan so the user can see what the task still needs
         * BEFORE anything runs, which is the whole point of it.
         */
        const checklist = deriveChecklist(text, plan.steps)

        return { ok: true, plan, edges: missionEdges(plan), skipped, complexity, checklist }
      } catch (err) {
        span.fail(err)
        return { ok: false, error: String((err as { message?: string })?.message || err) }
      }
    }
  )

  /**
   * Begin tracking a plan the renderer has already laid out on the canvas.
   *
   * `bindings` map each step's plan-local ref to the real node id the canvas
   * created for it. Root briefs are not typed here — they go out when each
   * agent's CLI first reports idle, which is the only moment it is safe.
   */
  ipcMain.handle(
    'studio-mission-start',
    async (
      _e,
      {
        plan,
        bindings,
        checklist
      }: {
        plan?: MissionPlan
        bindings?: { ref: string; nodeId: string }[]
        checklist?: ChecklistItem[]
      }
    ) => {
      if (!plan?.steps?.length) return { ok: false, error: 'There is no plan to run.' }

      const key = String(plan.workspaceId ?? '')

      /**
       * Only THIS workspace's previous mission is replaced.
       *
       * A crew running on another canvas is untouched: its terminals are alive,
       * its handoffs are in flight, and aborting it because a different
       * workspace started something would silently strand real work.
       */
      const previous = missions.get(key)
      if (previous) previous.abort('Replaced by a new mission in this workspace.')

      /**
       * The record is written before the crew starts.
       *
       * So a run that crashes the app on its first step still leaves something
       * to review — including the checklist the user filled in, which is the
       * part they did work for.
       */
      const record: TaskRecord = {
        id: plan.id,
        workspaceId: key,
        task: plan.task,
        summary: plan.summary,
        complexity: plan.complexity,
        createdAt: Date.now(),
        status: 'running',
        checklist: Array.isArray(checklist) ? checklist : deriveChecklist(plan.task, plan.steps),
        sections: plan.steps.map((step) => ({
          ref: step.ref,
          title: step.title,
          role: step.role,
          agentKind: step.agentKind,
          brief: step.brief,
          status: 'pending' as const
        })),
        notes: ''
      }
      upsertRecord(record)

      /**
       * The tracker reaches its own callback, so it cannot close over itself.
       *
       * `MissionTracker`'s constructor records `mission.start` and dispatches
       * its root steps SYNCHRONOUSLY, which means `deps.record` fires before the
       * constructor returns. A callback closing over `const tracker` therefore
       * touched the binding while it was still in its temporal dead zone, and
       * every single mission start died with:
       *
       *     ReferenceError: Cannot access 'tracker' before initialization
       *
       * A holder assigned immediately afterwards has no dead zone. The
       * constructor's own first events find it empty and skip the record sync —
       * which costs nothing, because the record was written moments ago and is
       * re-synced explicitly below.
       */
      const live: { tracker?: MissionTracker } = {}

      const tracker = new MissionTracker(plan, Array.isArray(bindings) ? bindings : [], {
        sessionForNode: (nodeId) => router.sessionForNode(nodeId),
        deliver: (sessionId, text) => manager.submit(sessionId, text),
        record: (level, event, message, fields) => {
          telemetry.record(level, 'mission', event, message, fields, { traceId: plan.id })
          // Every transition also updates what will be reviewed later.
          if (live.tracker) syncRecord(plan.id, live.tracker)
        }
      })
      live.tracker = tracker
      // Catch up on what the constructor already did — it dispatched the root
      // steps, so they are running, and the record still says pending.
      syncRecord(plan.id, tracker)

      missions.set(key, tracker)

      return { ok: true, mission: tracker.snapshot(), recordId: record.id }
    }
  )

  /**
   * The board for one canvas.
   *
   * Scoped by workspace so re-entering a workspace shows the crew that is
   * actually on it. Without the id this returned whichever mission started most
   * recently, anywhere — which read as the Dashboard "remembering" a run that
   * belonged to a different project.
   */
  ipcMain.handle('studio-mission-state', async (_e, { workspaceId }: { workspaceId?: string }) => {
    const tracker = missions.get(String(workspaceId ?? ''))
    return { ok: true, mission: tracker ? tracker.snapshot() : null }
  })

  /**
   * Stop one workspace's mission and everything it set off.
   *
   * Cancelling the router's cascades matters as much as stopping the tracker: a
   * chain already two agents deep would otherwise keep delivering work for a
   * mission the user has plainly stopped. That cancel is global — the router
   * does not track cascades per workspace — which is why it only runs when there
   * was actually a mission here to stop.
   */
  ipcMain.handle('studio-mission-abort', async (_e, { workspaceId }: { workspaceId?: string }) => {
    const tracker = missions.get(String(workspaceId ?? ''))
    if (!tracker) return { ok: true, mission: null }
    tracker.abort()
    router.cancelAll('cancelled: mission stopped')
    return { ok: true, mission: tracker.snapshot() }
  })

  // ── Agent task records: checklist, search, review packet ──────────────────

  /**
   * Search and filter the records.
   *
   * One channel for both, because they are one operation: an empty query is the
   * unfiltered list, which is also exactly what Reset sends. A second "list all"
   * path could drift from the filtered one, and then Reset would stop agreeing
   * with the thing it resets.
   */
  ipcMain.handle('studio-records', async (_e, query: RecordQuery = {}) => {
    const q = query ?? {}
    const records = allRecords()

    /**
     * `total` counts what is IN scope, not what exists.
     *
     * The panel reads it as "3 of 12" — and 12 meaning "every record on the
     * machine" while 3 means "in this workspace" is a ratio of two different
     * things. Counting the same population for both makes the readout true.
     */
    const inScope =
      q.allWorkspaces || !q.workspaceId
        ? records
        : records.filter((r) => r.workspaceId === q.workspaceId)

    return {
      ok: true,
      hits: searchRecords(records, q),
      total: inScope.length,
      options: filterOptions(inScope)
    }
  })

  /** Tick a checklist item, or write the reviewer's notes. */
  ipcMain.handle(
    'studio-record-update',
    async (
      _e,
      {
        id,
        itemId,
        item,
        notes
      }: {
        id?: string
        itemId?: string
        item?: Partial<ChecklistItem>
        notes?: string
      }
    ) => {
      const recordId = String(id ?? '')
      if (!recordId) return { ok: false, error: 'Which record?' }

      let updated: TaskRecord | null = null
      if (itemId) updated = setChecklistItem(recordId, String(itemId), item ?? {})
      if (typeof notes === 'string') updated = patchRecord(recordId, { notes })

      return updated
        ? { ok: true, record: updated }
        : { ok: false, error: 'That record no longer exists.' }
    }
  )

  /**
   * Build the review packet and save it.
   *
   * The dialog is the whole authorisation: nothing is written until the user has
   * chosen a path, and the extension they pick decides which of the two formats
   * is written.
   */
  ipcMain.handle(
    'studio-record-export',
    async (_e, { id, format }: { id?: string; format?: 'md' | 'json' | 'pdf' }) => {
      const record = getRecord(String(id ?? ''))
      if (!record) return { ok: false, error: 'That record no longer exists.' }

      const packet = buildPacket(record)
      const preferred = format === 'json' ? 'json' : format === 'pdf' ? 'pdf' : 'md'

      const win = getWindow()
      const options = {
        title: 'Save review packet',
        defaultPath: `${packet.filename}.${preferred}`,
        /**
         * The chosen format leads the list.
         *
         * Windows takes the extension from the FIRST filter rather than from
         * `defaultPath`, so a fixed order silently wrote a `.md` when the user
         * pressed the PDF button.
         */
        filters: [
          { name: 'PDF report', extensions: ['pdf'] },
          { name: 'Markdown', extensions: ['md'] },
          { name: 'JSON', extensions: ['json'] }
        ].sort(
          (a, b) => Number(b.extensions[0] === preferred) - Number(a.extensions[0] === preferred)
        )
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)

      if (result.canceled || !result.filePath) return { ok: false, canceled: true }

      try {
        // The extension decides, so renaming inside the dialog does what it
        // looks like it does rather than writing markdown into a .pdf.
        const lower = result.filePath.toLowerCase()
        if (lower.endsWith('.pdf')) {
          fs.writeFileSync(result.filePath, await buildPacketPdf(record))
        } else if (lower.endsWith('.json')) {
          fs.writeFileSync(result.filePath, packet.json, 'utf8')
        } else {
          fs.writeFileSync(result.filePath, packet.markdown, 'utf8')
        }
        log(`[records] exported a review packet to ${path.basename(result.filePath)}`)
        return { ok: true, path: result.filePath }
      } catch (err) {
        return { ok: false, error: String((err as { message?: string })?.message || err) }
      }
    }
  )

  /** Put the demonstration records back, or take them away. */
  ipcMain.handle('studio-records-seed', async (_e, { remove }: { remove?: boolean } = {}) => {
    if (remove) {
      const gone = removeSamples()
      log(`[records] removed ${gone} sample record(s)`)
      return { ok: true, removed: gone }
    }
    const existing = new Set(allRecords().map((r) => r.id))
    let added = 0
    for (const sample of sampleRecords()) {
      if (existing.has(sample.id)) continue
      upsertRecord(sample)
      added++
    }
    log(`[records] added ${added} sample record(s)`)
    return { ok: true, added }
  })

  ipcMain.handle('studio-record-delete', async (_e, { id }: { id?: string }) => ({
    ok: deleteRecord(String(id ?? ''))
  }))

  // ── Dock ──────────────────────────────────────────────────────────────────

  /**
   * A snapshot of everything that could be wrong, in one call.
   *
   * Deliberately cheap and side-effect free: it reads counters and existing
   * state rather than probing anything, so the Settings panel can poll it
   * without perturbing what it is measuring.
   */
  ipcMain.handle('studio-health', async () => {
    const live = manager.list()
    const byStatus: Record<string, number> = {}
    for (const s of live) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1

    return {
      ok: true,
      health: {
        engine: ptyAvailable(),
        sessions: {
          total: live.length,
          byStatus,
          hooked: Array.from(sessions.values()).filter((m) => m.hookInstalled).length,
          isolated: Array.from(sessions.values()).filter((m) => m.worktree).length
        },
        policy: {
          serverRunning: policyServer !== null,
          port: policyServer?.port ?? null,
          autonomy,
          awaitingHuman: pending.size + pendingKeys.size
        },
        git: { reposBusy: busyRepoCount() },
        missions: Array.from(missions.values())
          .filter((m) => m.status === 'running')
          .map((m) => ({ workspaceId: m.workspaceId, ...m.snapshot().totals })),
        projects: journal.projectCount(),
        metrics: telemetry.metrics(),
        spawning: spawning.size,
        agents: adapterAvailability().map((a) => ({
          kind: a.kind,
          available: a.available,
          signedIn: a.signedIn
        }))
      }
    }
  })

  /**
   * Worktrees Brutus left behind, across every workspace with a repository.
   *
   * Read-only. Nothing here removes or merges anything — that is the operator's
   * call, made per item, because a branch can hold work that never merged and
   * deleting it would be unrecoverable.
   */
  ipcMain.handle('studio-orphans', async () => {
    const liveDirs = Array.from(sessions.values())
      .map((m) => m.worktree?.dir)
      .filter((d): d is string => !!d)

    // Every distinct repository referenced by a saved workspace.
    const repos = new Set<string>()
    for (const ws of listWorkspaces()) {
      if (!ws.rootDir) continue
      const project = resolveProjectRoot(ws.rootDir)
      if (project.isRepo) repos.add(project.root)
    }
    for (const m of sessions.values()) if (m.projectRoot) repos.add(m.projectRoot)

    const orphans: (OrphanedWorktree & { repo: string })[] = []
    for (const repo of repos) {
      try {
        for (const o of await listOrphanedWorktrees(repo, liveDirs)) {
          orphans.push({ ...o, repo })
        }
      } catch (err) {
        log(`[git] could not inspect ${repo}: ${err}`)
      }
    }
    return { ok: true, orphans }
  })

  /**
   * Act on one orphan, only when asked.
   *
   * `merge` runs the same conservative path a live agent's turn does, so a
   * conflict aborts and leaves the branch alone. `remove` deletes the directory
   * and never the branch.
   */
  ipcMain.handle(
    'studio-orphan-action',
    async (
      _e,
      {
        repo,
        dir,
        branch,
        action
      }: { repo?: string; dir?: string; branch?: string; action?: string }
    ) => {
      if (!repo || !dir || !branch) return { ok: false, error: 'Missing worktree details.' }

      const base = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)
      const worktree: Worktree = {
        repo,
        dir,
        branch,
        base: base.ok ? base.stdout.trim() || 'main' : 'main'
      }

      if (action === 'merge') {
        const res = await commitAndMerge(worktree, `Reclaimed ${branch}`)
        log(`[git] reclaim merge ${branch}: ${res.status}`)
        return { ok: res.status === 'merged' || res.status === 'nothing-to-do', result: res }
      }

      if (action === 'remove') {
        await removeWorktree(worktree)
        log(`[git] reclaimed ${dir} (branch ${branch} kept)`)
        return { ok: true }
      }

      return { ok: false, error: `Unknown action "${action}".` }
    }
  )

  /** Backfill for a panel that just opened; `since` makes it incremental. */
  ipcMain.handle('studio-activity', async (_e, { since }: { since?: number } = {}) => ({
    ok: true,
    events: telemetry.snapshot(Number(since) || 0),
    metrics: telemetry.metrics()
  }))

  ipcMain.handle('studio-activity-clear', async () => {
    telemetry.clear()
    return { ok: true }
  })

  ipcMain.handle('studio-dock-get', async () => ({ ok: true, dock: getDock() }))

  ipcMain.handle(
    'studio-dock-set',
    async (_e, patch: { onDock?: string[]; backdrop?: string }) => ({
      ok: true,
      dock: setDock(patch ?? {})
    })
  )

  ipcMain.handle('studio-dock-reset', async () => ({ ok: true, dock: resetDock() }))

  // ── Workspaces ────────────────────────────────────────────────────────────

  ipcMain.handle('studio-workspace-list', async () => ({ ok: true, workspaces: listWorkspaces() }))

  ipcMain.handle('studio-workspace-open', async (_e, { id }: { id?: string }) => {
    const workspace = id ? readWorkspace(id) : null
    return workspace ? { ok: true, workspace } : { ok: false, error: 'That workspace is gone.' }
  })

  ipcMain.handle('studio-workspace-create', async (_e, over: Partial<StudioWorkspace>) => ({
    ok: true,
    // A new canvas starts with the scenery chosen in Settings, which is what
    // makes that preference feel like a default rather than a one-off.
    workspace: createWorkspace({ backdrop: getDock().backdrop, ...(over ?? {}) })
  }))

  ipcMain.handle('studio-workspace-save', async (_e, ws: Partial<StudioWorkspace>) => {
    const workspace = saveWorkspace(ws ?? {})
    return workspace ? { ok: true, workspace } : { ok: false, error: 'Unknown workspace.' }
  })

  ipcMain.handle('studio-workspace-delete', async (_e, { id }: { id?: string }) => ({
    ok: deleteWorkspace(id ?? '')
  }))

  ipcMain.handle('studio-workspace-export', async (_e, { id }: { id?: string }) => {
    const data = exportWorkspace(id ?? '')
    return data ? { ok: true, data } : { ok: false, error: 'Unknown workspace.' }
  })

  ipcMain.handle('studio-workspace-import', async (_e, { payload }: { payload?: string }) => {
    const workspace = importWorkspace(String(payload ?? ''))
    return workspace
      ? { ok: true, workspace }
      : { ok: false, error: 'That does not look like a Brutus workspace.' }
  })

  /**
   * Clone a repository, then hand back the folder so a workspace can open on it.
   *
   * Runs `git` directly with an argument array — never through a shell — so a
   * URL containing shell metacharacters is data, not a command. `--` separates
   * the URL from git's own options, which stops a "URL" that begins with a dash
   * being read as a flag.
   */
  ipcMain.handle(
    'studio-clone-repo',
    async (_e, { url, parentDir }: { url?: string; parentDir?: string }) => {
      const repo = String(url ?? '').trim()
      const parent = String(parentDir ?? '').trim()

      if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(repo)) {
        return { ok: false, error: 'Enter an https:// or git@ repository URL.' }
      }
      if (!parent || !fs.existsSync(parent)) {
        return { ok: false, error: 'Choose a folder to clone into.' }
      }

      const name =
        repo
          .replace(/\.git$/i, '')
          .split(/[/:]/)
          .filter(Boolean)
          .pop() ?? 'repo'
      const target = path.join(parent, name)
      if (fs.existsSync(target)) {
        return { ok: false, error: `"${name}" already exists in that folder.` }
      }

      return await new Promise((resolve) => {
        const child = spawn('git', ['clone', '--progress', '--', repo, target], {
          cwd: parent,
          shell: false
        })
        let stderr = ''
        // git reports clone progress on stderr, so it is the useful stream.
        child.stderr?.on('data', (d: Buffer) => {
          const line = d.toString()
          stderr += line
          log(`[clone] ${line.trim().split('\n').pop()}`)
        })
        child.on('error', (err) =>
          resolve({
            ok: false,
            error:
              (err as { code?: string }).code === 'ENOENT'
                ? 'git is not installed or not on PATH.'
                : String(err.message || err)
          })
        )
        child.on('close', (code) => {
          if (code === 0) resolve({ ok: true, path: target, name })
          else
            resolve({
              ok: false,
              error: stderr.trim().split('\n').slice(-2).join(' ') || `git exited with ${code}`
            })
        })
      })
    }
  )

  /** Folder picker for a node's working directory. */
  ipcMain.handle('studio-pick-folder', async () => {
    const win = getWindow()
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths.length) return { ok: false }
    return { ok: true, path: res.filePaths[0] }
  })
}
