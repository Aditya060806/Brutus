/**
 * BRUTUS Orchestrator — capability bus
 * -------------------------------------
 * Agents need to DO things, and everything Brutus can actually do lives behind
 * ~159 `ipcMain.handle` channels in the main process. Electron gives no way to
 * invoke a registered handler internally, and rewriting 159 of them would be a
 * large, risky change to working code.
 *
 * So modules opt in with a one-line wrap that leaves IPC behaviour identical:
 *
 *     ipcMain.handle('read-file', capability(
 *       { name: 'read-file', tags: ['read'], description: 'Read a file' },
 *       readFileHandler
 *     ))
 *
 * `capability()` records the handler in this registry and returns it unchanged,
 * so the renderer path is byte-for-byte what it was. Agents then reach the same
 * function through `runCapability()`.
 *
 * ── THE APPROVAL GATE (the safety-critical part) ───────────────────────────
 * Every capability is tagged. `read` runs freely. Anything tagged `write`,
 * `external` or `destructive` CANNOT execute without a single-use approval
 * token minted by the user answering a prompt in the UI. The check lives here,
 * at the one place calls actually execute, so no agent, prompt injection, or
 * future caller can route around it.
 */
import type { CapabilityResult, CapabilitySpec, CapabilityTag, OrchestratorConfig } from './types'

/** An ipcMain handler, viewed structurally so this file stays Electron-free. */
type Handler = (event: unknown, ...args: never[]) => unknown

interface Entry {
  spec: CapabilitySpec
  handler: Handler
  /**
   * How the agent's flat args object maps onto the handler's positional
   * parameters. IPC handlers vary: some take one object, some take positional
   * values. Without this the bus would have to guess.
   */
  adapt?: (args: Record<string, unknown>) => unknown[]
}

const registry = new Map<string, Entry>()

/** Tags that always require explicit user approval before executing. */
const GATED_TAGS: CapabilityTag[] = ['write', 'external', 'destructive']

export function isGated(tags: CapabilityTag[], autonomy: OrchestratorConfig['autonomy']): boolean {
  if (autonomy === 'autonomous') return false
  if (autonomy === 'strict') return tags.some((t) => t !== 'read')
  // 'guarded' (default): local writes, anything leaving the machine, anything
  // irreversible. Read-only work never prompts.
  return tags.some((t) => GATED_TAGS.includes(t))
}

/**
 * Wrap an ipcMain handler so it is ALSO callable by agents.
 * Returns the handler untouched — existing IPC behaviour does not change.
 */
export function capability(
  spec: CapabilitySpec,
  handler: Handler,
  adapt?: Entry['adapt']
): Handler {
  registry.set(spec.name, { spec, handler, adapt })
  return handler
}

/**
 * Wrap the real `ipcMain` so that any handler registered on a channel named in
 * [manifest] is ALSO recorded in the capability registry.
 *
 * This is why no existing module needed editing: `main/index.ts` passes this
 * proxy to the registrars instead of the raw `ipcMain`, every `.handle()` call
 * still reaches Electron untouched, and the ~25 channels we care about become
 * agent-callable as a side effect.
 */
export function createCapabilityCapture(
  real: IpcMainLike,
  manifest: Record<string, { spec: CapabilitySpec; adapt?: Entry['adapt'] }>
): IpcMainLike {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'handle') {
        return (channel: string, handler: Handler) => {
          const entry = manifest[channel]
          if (entry)
            registry.set(entry.spec.name, { spec: entry.spec, handler, adapt: entry.adapt })
          return (target as IpcMainLike).handle(channel, handler)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as IpcMainLike
}

/** Minimal shape we need from Electron's IpcMain (keeps this file testable). */
export interface IpcMainLike {
  handle: (channel: string, handler: Handler) => void
  [key: string]: unknown
}

/** Register a capability that has no IPC channel (agent-only, e.g. Tavily). */
export function defineCapability(
  spec: CapabilitySpec,
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown
): void {
  registry.set(spec.name, {
    spec,
    handler: (_event: unknown, args: Record<string, unknown>) => run(args),
    adapt: (args) => [args]
  })
}

export function getCapability(name: string): CapabilitySpec | null {
  return registry.get(name)?.spec ?? null
}

export function listCapabilities(names?: string[]): CapabilitySpec[] {
  if (!names) return Array.from(registry.values()).map((e) => e.spec)
  return names.map((n) => registry.get(n)?.spec).filter((s): s is CapabilitySpec => Boolean(s))
}

export function hasCapability(name: string): boolean {
  return registry.has(name)
}

// ── Approval tokens ─────────────────────────────────────────────────────────

interface Token {
  capability: string
  /** Hash of the exact args approved, so a token can't be reused for a
   *  different payload than the one the user actually saw. */
  argsFingerprint: string
  expiresAt: number
}

const tokens = new Map<string, Token>()
const TOKEN_TTL_MS = 10 * 60 * 1000

function fingerprint(args: Record<string, unknown>): string {
  try {
    // Stable key order so {a,b} and {b,a} fingerprint identically.
    return JSON.stringify(args, Object.keys(args).sort())
  } catch {
    return String(args)
  }
}

/** Mint a single-use token for exactly this capability + these arguments. */
export function grantApproval(
  id: string,
  capabilityName: string,
  args: Record<string, unknown>
): void {
  tokens.set(id, {
    capability: capabilityName,
    argsFingerprint: fingerprint(args),
    expiresAt: Date.now() + TOKEN_TTL_MS
  })
}

export function revokeApproval(id: string): void {
  tokens.delete(id)
}

/** Consume a token. Returns false if missing, expired, or for a different call. */
function consumeToken(
  id: string | undefined,
  capabilityName: string,
  args: Record<string, unknown>
): boolean {
  if (!id) return false
  const t = tokens.get(id)
  if (!t) return false
  tokens.delete(id) // single use, consumed even on mismatch
  if (t.expiresAt < Date.now()) return false
  if (t.capability !== capabilityName) return false
  return t.argsFingerprint === fingerprint(args)
}

// ── Execution ───────────────────────────────────────────────────────────────

/** Keep tool output from blowing the model's context window. */
function stringifyOutput(value: unknown, limit = 6000): string {
  let text: string
  if (value === null || value === undefined) text = ''
  else if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  if (text.length > limit) {
    return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`
  }
  return text
}

export interface RunCapabilityOpts {
  autonomy: OrchestratorConfig['autonomy']
  /** Token minted when the user approved this exact call. */
  approvalToken?: string
  signal?: AbortSignal
}

/**
 * Execute a capability on an agent's behalf.
 *
 * Gated capabilities return `{ ok:false, needsApproval:true }` rather than
 * throwing, so the scheduler can pause the task, ask the user, and re-run the
 * identical call with a token.
 */
export async function runCapability(
  name: string,
  args: Record<string, unknown>,
  opts: RunCapabilityOpts
): Promise<CapabilityResult> {
  const entry = registry.get(name)
  if (!entry) {
    return { ok: false, output: '', error: `Unknown capability "${name}".` }
  }

  if (isGated(entry.spec.tags, opts.autonomy)) {
    if (!consumeToken(opts.approvalToken, name, args)) {
      return {
        ok: false,
        output: '',
        needsApproval: true,
        error: `"${name}" requires user approval (${entry.spec.tags.join(', ')}).`
      }
    }
  }

  try {
    const positional = entry.adapt ? entry.adapt(args) : [args]
    // `Handler` declares `never[]` rest args so that any concretely-typed
    // ipcMain handler is assignable to it. Calling therefore needs this one
    // widening cast; the adapters above are what guarantee the shapes match.
    const invoke = entry.handler as (event: unknown, ...args: unknown[]) => unknown
    // The first parameter is the IpcMainInvokeEvent, which none of the wrapped
    // handlers use for agent-initiated calls.
    const value = await invoke(null, ...positional)
    return { ok: true, output: stringifyOutput(value) }
  } catch (err) {
    return {
      ok: false,
      output: '',
      error: String((err as { message?: string })?.message || err).slice(0, 500)
    }
  }
}

/** Test/debug helper — never used by the app itself. */
export function _resetRegistryForTests(): void {
  registry.clear()
  tokens.clear()
}
