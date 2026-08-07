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
import { DevServerWatcher } from './dev-server'
import { ProjectJournal, filesFromToolInput, resolveProjectRoot } from './project'
import { COMMAND_SYSTEM, commandPrompt, validateMutations } from './command'
import {
  MISSION_SYSTEM,
  MissionTracker,
  missionEdges,
  missionPrompt,
  validateMission,
  type MissionPlan
} from './mission'
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
    deliver: (sessionId, text) => manager.enqueue(sessionId, text),
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

  // Every chunk feeds three tracks: the prompt watcher (permissions + idle), the
  // router (turn transcript + structured events), and dev-server detection.
  manager.onData((sessionId, chunk) => {
    sessions.get(sessionId)?.watcher?.push(chunk)

    const hit = devServers.push(sessionId, chunk)
    if (hit) {
      const nodeId = sessions.get(sessionId)?.nodeId ?? ''
      log(`[preview] ${nodeTitles.get(nodeId) ?? 'an agent'} started a server on ${hit.url}`)
      emit({ type: 'preview-detected', sessionId, nodeId, url: hit.url, port: hit.port })
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
    mission?.abort('Brutus is closing.')
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
   * Stop every agent at once.
   *
   * The counterpart to agents surviving a workspace being closed: something has
   * to be able to end them, and hunting for the window each one lives in is not
   * that. Offered from the launcher, where the running count is visible.
   */
  ipcMain.handle('studio-stop-all', async () => {
    mission?.abort('Every agent was stopped.')
    router.cancelAll('cancelled: all agents stopped')
    const live = manager.list()
    for (const s of live) manager.kill(s.id)
    log(`[studio] stopped ${live.length} agent(s)`)
    return { ok: true, stopped: live.length }
  })

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
  /**
   * Stop every routing chain, and the mission driving them.
   *
   * NOT called when the canvas unmounts any more. Agents now outlive the
   * workspace being closed, so a cascade in flight is work the user asked for
   * and expects to find finished when they come back — cancelling it on the way
   * out was the old behaviour only because the terminals were about to be
   * killed. This is now the explicit "stop" the user presses.
   */
  ipcMain.handle('studio-cancel-routing', async () => {
    mission?.abort('Routing was stopped.')
    return { ok: true, cancelled: router.cancelAll('cancelled by the operator') }
  })

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
        return { ok: true, plan, edges: missionEdges(plan), skipped, complexity }
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
      { plan, bindings }: { plan?: MissionPlan; bindings?: { ref: string; nodeId: string }[] }
    ) => {
      if (!plan?.steps?.length) return { ok: false, error: 'There is no plan to run.' }

      // A previous mission still running would keep receiving turn events from
      // nodes the new one is about to reuse.
      if (mission) mission.abort('Replaced by a new mission.')

      mission = new MissionTracker(plan, Array.isArray(bindings) ? bindings : [], {
        sessionForNode: (nodeId) => router.sessionForNode(nodeId),
        deliver: (sessionId, text) => manager.enqueue(sessionId, text),
        record: (level, event, message, fields) =>
          telemetry.record(level, 'mission', event, message, fields, { traceId: plan.id })
      })

      return { ok: true, mission: mission.snapshot() }
    }
  )

  ipcMain.handle('studio-mission-state', async () => ({
    ok: true,
    mission: mission ? mission.snapshot() : null
  }))

  /**
   * Stop the mission and everything it set off.
   *
   * Cancelling the router's cascades matters as much as stopping the tracker: a
   * chain already two agents deep would otherwise keep delivering work for a
   * mission the user has plainly stopped.
   */
  ipcMain.handle('studio-mission-abort', async () => {
    if (!mission) return { ok: true, mission: null }
    mission.abort()
    router.cancelAll('cancelled: mission stopped')
    return { ok: true, mission: mission.snapshot() }
  })

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
        mission: mission ? mission.snapshot().totals : null,
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
