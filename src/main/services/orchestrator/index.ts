/**
 * BRUTUS Multi-Agent Orchestrator — service entry point
 * ------------------------------------------------------
 * Owns run lifecycle and the IPC surface:
 *
 *   orchestrator-run       start a run from a user request
 *   orchestrator-approve   answer a pending approval (grant / deny)
 *   orchestrator-cancel    abort a run
 *   orchestrator-status    current run + key-pool health
 *   orchestrator-history   recent runs
 *   orchestrator-config    read/write keys, models, concurrency, autonomy
 *
 * Progress streams to the renderer on `orchestrator-event`, mirroring the
 * pattern deep-research.ts already uses.
 *
 * Runs are only started by an explicit `/agent` message, never by ordinary
 * chat, so normal conversation keeps its existing single-call latency.
 */
import { IpcMain, BrowserWindow, safeStorage, app } from 'electron'
import fs from 'fs'
import path from 'path'
import Store from 'electron-store'

import {
  bindCapabilityConfig,
  captureCapabilities,
  registerAgentCapabilities
} from './capabilities'
import { revokeApproval } from './capability-bus'
import { AGENTS, AGENT_NAMES } from './agents'
import { ModelRouter } from './model-router'
import { makePlan } from './planner'
import { planToTasks, runPlan } from './scheduler'
import { synthesize } from './synthesizer'
import {
  DEFAULT_CONFIG,
  createCallBudget,
  type ApprovalRequest,
  type OrchestratorConfig,
  type RunEvent,
  type RunState
} from './types'
import type { IpcMainLike } from './capability-bus'

const CONFIG_KEY = 'brutus_orchestrator_config'
const MAX_HISTORY = 20

/** Minimal electron-store surface; the package ships both CJS and ESM shapes. */
interface StoreLike {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
}
let _store: StoreLike | null = null
function getStore(): StoreLike {
  if (!_store) {
    const mod = Store as unknown as { default?: new () => StoreLike }
    const StoreClass = mod.default ?? (Store as unknown as new () => StoreLike)
    _store = new StoreClass()
  }
  return _store
}

/**
 * Groq keys are credentials, so they follow the same encrypted-vault path the
 * rest of the app uses rather than sitting in plain config.
 */
function vaultPath(): string {
  return path.join(app.getPath('userData'), 'brutus_orchestrator_keys.json')
}

function loadKeys(): { groqKeys: string[]; tavilyKey: string; hfKey: string } {
  try {
    if (!fs.existsSync(vaultPath())) return { groqKeys: [], tavilyKey: '', hfKey: '' }
    const raw = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'))
    const decode = (v: string): string => {
      if (!v) return ''
      try {
        return safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(v, 'base64'))
          : Buffer.from(v, 'base64').toString('utf8')
      } catch {
        return ''
      }
    }
    return {
      groqKeys: Array.isArray(raw.groqKeys) ? raw.groqKeys.map(decode).filter(Boolean) : [],
      tavilyKey: decode(raw.tavilyKey || ''),
      hfKey: decode(raw.hfKey || '')
    }
  } catch {
    return { groqKeys: [], tavilyKey: '', hfKey: '' }
  }
}

function saveKeys(keys: { groqKeys: string[]; tavilyKey: string; hfKey: string }): void {
  const encode = (v: string): string => {
    if (!v) return ''
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(v).toString('base64')
      : Buffer.from(v, 'utf8').toString('base64')
  }
  fs.writeFileSync(
    vaultPath(),
    JSON.stringify({
      groqKeys: keys.groqKeys.filter(Boolean).map(encode),
      tavilyKey: encode(keys.tavilyKey),
      hfKey: encode(keys.hfKey)
    })
  )
}

function loadConfig(): OrchestratorConfig {
  let saved: Partial<OrchestratorConfig> = {}
  try {
    saved = (getStore().get(CONFIG_KEY) as Partial<OrchestratorConfig>) || {}
  } catch {
    saved = {}
  }
  const keys = loadKeys()
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    ...keys,
    modelOverrides: saved.modelOverrides ?? {},
    concurrency: Math.min(8, Math.max(1, saved.concurrency ?? DEFAULT_CONFIG.concurrency)),
    autonomy: saved.autonomy ?? DEFAULT_CONFIG.autonomy,
    maxToolIterations: Math.min(
      8,
      Math.max(1, saved.maxToolIterations ?? DEFAULT_CONFIG.maxToolIterations)
    ),
    maxLlmCallsPerRun: Math.min(
      100,
      Math.max(4, saved.maxLlmCallsPerRun ?? DEFAULT_CONFIG.maxLlmCallsPerRun)
    ),
    minKeyIntervalMs: Math.min(
      10_000,
      Math.max(0, saved.minKeyIntervalMs ?? DEFAULT_CONFIG.minKeyIntervalMs)
    )
  }
}

interface RegisterOpts {
  ipcMain: IpcMain
  getWindow: () => BrowserWindow | null
}

/**
 * Wrap ipcMain so the channels named in the capability manifest become
 * agent-callable as they register. Call this ONCE in main/index.ts and pass the
 * result to the service registrars instead of the raw ipcMain.
 */
export function installCapabilityCapture(realIpcMain: IpcMain): IpcMain {
  return captureCapabilities(realIpcMain as unknown as IpcMainLike) as unknown as IpcMain
}

/**
 * The one ModelRouter in the app.
 *
 * BRUTUS Studio reframes agent handoffs through this rather than constructing
 * its own. That is not just tidiness: rate limiting lives in the key pool, so a
 * second router over the same keys would double the real request rate and
 * defeat `minKeyIntervalMs` — exactly the "every api gets over quickly" problem
 * the pacing was added to fix.
 */
let sharedRouter: ModelRouter | null = null

export function getSharedModelRouter(): ModelRouter | null {
  return sharedRouter
}

export default function registerOrchestrator({ ipcMain, getWindow }: RegisterOpts): void {
  let config = loadConfig()
  bindCapabilityConfig(() => config)
  registerAgentCapabilities()

  const router = new ModelRouter(config)
  sharedRouter = router

  let current: RunState | null = null
  let controller: AbortController | null = null
  const history: RunState[] = []
  /** Resolver for the approval the run is currently blocked on. */
  let pendingApproval: { req: ApprovalRequest; resolve: (granted: boolean) => void } | null = null

  const emit = (event: RunEvent): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('orchestrator-event', event)
  }

  const snapshot = (run: RunState): RunState => JSON.parse(JSON.stringify(run))

  const finish = (run: RunState): void => {
    run.finishedAt = Date.now()
    history.unshift(snapshot(run))
    if (history.length > MAX_HISTORY) history.pop()
    emit({ type: 'run-finished', run: snapshot(run) })
    if (current?.id === run.id) {
      current = null
      controller = null
    }
  }

  const execute = async (run: RunState): Promise<void> => {
    const signal = controller!.signal
    try {
      // ── Plan ──────────────────────────────────────────────────────────────
      run.status = 'planning'
      emit({ type: 'run-started', run: snapshot(run) })
      emit({ type: 'log', runId: run.id, line: 'Decomposing the request…' })

      // One budget for the whole run. The planner and the final synthesis are
      // paid for outside it (one call each, both essential); everything the
      // agents and critics spend comes out of this.
      const budget = createCallBudget(config.maxLlmCallsPerRun)

      const { plan, model } = await makePlan(router, run.request, signal)
      run.objective = plan.objective
      run.tasks = planToTasks(plan)
      run.status = 'running'
      emit({ type: 'log', runId: run.id, line: `Planned ${run.tasks.length} task(s) via ${model}` })
      emit({
        type: 'plan-ready',
        runId: run.id,
        objective: plan.objective,
        tasks: snapshot(run).tasks
      })

      // ── Execute ───────────────────────────────────────────────────────────
      // Parallelism is bounded by how many Groq keys there are. Groq rate-limits
      // per key, so running three agents against one key mostly produces 429s
      // and stalls — one key means one task at a time. Adding keys is what buys
      // real parallelism.
      const effectiveConcurrency = Math.max(
        1,
        Math.min(config.concurrency, config.groqKeys.length || 1)
      )
      if (effectiveConcurrency < config.concurrency) {
        emit({
          type: 'log',
          runId: run.id,
          line: `Running ${effectiveConcurrency} task(s) at a time (limited by ${config.groqKeys.length} Groq key(s) — add more keys for more parallelism)`
        })
      }

      await runPlan(
        run,
        router,
        { ...config, concurrency: effectiveConcurrency },
        {
          onTaskUpdate: (task) => {
            emit({ type: 'task-updated', runId: run.id, task: JSON.parse(JSON.stringify(task)) })
          },
          onLog: (line) => emit({ type: 'log', runId: run.id, line }),
          requestApproval: (req) =>
            new Promise<boolean>((resolve) => {
              pendingApproval = { req, resolve }
              run.status = 'awaiting-approval'
              run.pendingApproval = req
              emit({ type: 'approval-required', runId: run.id, approval: req })
            })
        },
        signal,
        budget
      )

      emit({
        type: 'log',
        runId: run.id,
        line: `Used ${budget.used}/${budget.limit} agent LLM calls`
      })

      if (signal.aborted) {
        run.status = 'cancelled'
        finish(run)
        return
      }

      // ── Synthesise ────────────────────────────────────────────────────────
      run.status = 'synthesizing'
      run.pendingApproval = null
      emit({ type: 'log', runId: run.id, line: 'Merging findings…' })
      const { answer } = await synthesize(router, run, signal)
      run.answer = answer
      run.status = 'done'
      finish(run)
    } catch (err) {
      if (signal.aborted) {
        run.status = 'cancelled'
      } else {
        run.status = 'failed'
        run.error = String((err as { message?: string })?.message || err).slice(0, 600)
      }
      finish(run)
    }
  }

  // ── IPC ────────────────────────────────────────────────────────────────────

  ipcMain.handle('orchestrator-run', async (_e, { request }: { request?: string }) => {
    const text = String(request || '').trim()
    if (!text) return { ok: false, error: 'Empty request.' }
    if (current) return { ok: false, error: 'A run is already in progress.' }

    config = loadConfig()
    router.updateConfig(config)

    if (!config.groqKeys.length) {
      return {
        ok: false,
        error:
          'No Groq API keys configured. Add at least one in Settings → API Keys → Agent Orchestration.'
      }
    }

    const run: RunState = {
      id: `run_${Date.now()}`,
      request: text,
      status: 'planning',
      tasks: [],
      startedAt: Date.now(),
      pendingApproval: null
    }
    current = run
    controller = new AbortController()

    // Fire and forget — progress arrives on orchestrator-event.
    void execute(run)
    return { ok: true, runId: run.id }
  })

  ipcMain.handle(
    'orchestrator-approve',
    async (_e, { approvalId, granted }: { approvalId?: string; granted?: boolean }) => {
      if (!pendingApproval) return { ok: false, error: 'Nothing is awaiting approval.' }
      if (pendingApproval.req.id !== approvalId) {
        return { ok: false, error: 'That approval is no longer current.' }
      }
      const ok = Boolean(granted)
      const { resolve, req } = pendingApproval
      pendingApproval = null
      if (current) {
        current.pendingApproval = null
        current.status = 'running'
      }
      if (!ok) revokeApproval(req.id)
      emit({ type: 'approval-resolved', runId: req.runId, approvalId: req.id, granted: ok })
      resolve(ok)
      return { ok: true }
    }
  )

  ipcMain.handle('orchestrator-cancel', async () => {
    if (!current || !controller) return { ok: false, error: 'No run in progress.' }
    controller.abort()
    // Unblock a run parked on an approval so it can observe the abort.
    if (pendingApproval) {
      pendingApproval.resolve(false)
      pendingApproval = null
    }
    return { ok: true }
  })

  ipcMain.handle('orchestrator-status', async () => ({
    run: current ? snapshot(current) : null,
    keyPool: router.keyPoolStatus(),
    agents: AGENT_NAMES.map((n) => ({
      name: n,
      title: AGENTS[n].title,
      charter: AGENTS[n].charter,
      capabilities: AGENTS[n].capabilities
    })),
    config: { ...config, groqKeys: config.groqKeys.map(() => '••••') }
  }))

  ipcMain.handle('orchestrator-history', async () => history)

  ipcMain.handle(
    'orchestrator-config',
    async (_e, patch: Partial<OrchestratorConfig> & { groqKeysRaw?: string }) => {
      if (patch) {
        // Keys go to the encrypted vault; everything else to the plain store.
        const nextKeys = {
          groqKeys:
            patch.groqKeysRaw !== undefined
              ? String(patch.groqKeysRaw)
                  .split(/[\n,]/)
                  .map((k) => k.trim())
                  .filter(Boolean)
              : config.groqKeys,
          tavilyKey: patch.tavilyKey ?? config.tavilyKey,
          hfKey: patch.hfKey ?? config.hfKey
        }
        saveKeys(nextKeys)

        const { groqKeys: _g, tavilyKey: _t, hfKey: _h, ...rest } = patch as Record<string, unknown>
        const storeable = { ...(getStore().get(CONFIG_KEY) || {}), ...rest }
        delete (storeable as Record<string, unknown>).groqKeysRaw
        getStore().set(CONFIG_KEY, storeable)
      }
      config = loadConfig()
      router.updateConfig(config)
      return {
        ok: true,
        config: { ...config, groqKeys: config.groqKeys.map(() => '••••') },
        keyPool: router.keyPoolStatus()
      }
    }
  )
}
