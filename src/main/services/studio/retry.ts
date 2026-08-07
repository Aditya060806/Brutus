/**
 * BRUTUS Studio — retrying transient failures
 * --------------------------------------------
 * Some failures are worth trying again and most are not, so the interesting
 * part of this module is the predicate, not the loop.
 *
 * Retrying the wrong thing is worse than not retrying at all: re-running a
 * merge that hit a genuine conflict would just produce the same conflict, and
 * re-running a command that partially succeeded can double its side effects.
 * `withRetry` therefore retries **only** what the caller positively identifies
 * as transient, and treats everything else as final on the first attempt.
 *
 * The clock is injectable so the tests exercise real backoff arithmetic without
 * sleeping — a retry suite that actually waits is a retry suite nobody runs.
 */

export interface RetryOptions {
  /** Total attempts including the first. 1 disables retrying. */
  attempts?: number
  /** Delay before the second attempt, in milliseconds. */
  baseDelayMs?: number
  /** Ceiling for any single delay, after growth and jitter. */
  maxDelayMs?: number
  /** Only failures this returns true for are retried. */
  isRetryable: (error: unknown) => boolean
  /** Abort between attempts. An in-flight attempt is the caller's to cancel. */
  signal?: AbortSignal
  /** Called before each wait, for logging and metrics. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injected for tests; must return a value in [0, 1). */
  random?: () => number
}

const DEFAULT_ATTEMPTS = 4
const DEFAULT_BASE_DELAY_MS = 120
const DEFAULT_MAX_DELAY_MS = 2_000

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Delay for a given attempt: exponential, jittered, clamped.
 *
 * Jitter is full-range rather than a fixed fraction. Two agents whose merges
 * collide would otherwise back off by identical amounts and collide again on
 * exactly the same schedule; spreading them apart is the entire point.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  random: () => number = Math.random
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1))
  return Math.round(exponential * (0.5 + random() * 0.5))
}

export class AbortError extends Error {
  constructor(message = 'Operation was cancelled.') {
    super(message)
    this.name = 'AbortError'
  }
}

/**
 * Run an operation, retrying only transient failures.
 *
 * Rethrows the **last** error rather than a wrapper, so callers keep whatever
 * detail the underlying failure carried — the point of retrying is to succeed,
 * and when it does not the original reason is what matters.
 */
export async function withRetry<T>(operation: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS)
  const sleep = opts.sleep ?? realSleep
  const random = opts.random ?? Math.random

  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new AbortError()

    try {
      return await operation()
    } catch (error) {
      lastError = error

      // Cancellation is never a transient failure to sit out and try again.
      if (error instanceof AbortError || opts.signal?.aborted) throw error
      if (attempt === attempts || !opts.isRetryable(error)) throw error

      const delayMs = backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, random)
      opts.onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }

  // Unreachable: the loop either returns or throws. Present so the function has
  // a total return type rather than an implicit undefined.
  throw lastError
}

/**
 * Failures worth retrying when running git.
 *
 * Deliberately narrow, and matched on the message because git reports lock
 * contention as text on stderr rather than as a distinct exit code:
 *
 *   • `index.lock` / `shallow.lock` — another git process holds the index.
 *     On this machine that is not only other agents: editors and shell
 *     integrations run git constantly in the background.
 *   • Windows `EBUSY` / `EPERM` / `EACCES` / `EAGAIN` — antivirus scanners and
 *     the search indexer hold handles on freshly written files, which makes
 *     worktree creation and removal fail in a way that succeeds moments later.
 *
 * A merge conflict is emphatically not here. It is a real answer that needs a
 * human, and retrying it would only produce the same conflict more slowly.
 */
export function isTransientGitFailure(error: unknown): boolean {
  const text =
    typeof error === 'string'
      ? error
      : String((error as { message?: string })?.message ?? error ?? '')

  if (!text) return false
  if (/conflict|CONFLICT/.test(text)) return false

  return (
    /\.lock['"]?:?\s*File exists|Unable to create.*\.lock|another git process|index\.lock/i.test(
      text
    ) || /\b(EBUSY|EPERM|EACCES|EAGAIN)\b/.test(text)
  )
}
