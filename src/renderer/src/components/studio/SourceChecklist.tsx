import { useMemo, type ReactElement } from 'react'
import { RiCheckLine, RiInformationLine } from 'react-icons/ri'
import type { ChecklistItem } from '@renderer/services/studio-client'

/**
 * What this task still needs, before anything runs.
 *
 * ── WHY IT SITS IN THE PLAN, NOT IN SETTINGS ───────────────────────────────
 * The moment it is useful is the moment before you press Run: once several CLI
 * processes are editing files, "you never told it which database" is expensive.
 * So it lives directly above the Run button, where it is read by someone who is
 * about to commit to something.
 *
 * ── WHY RUN IS NEVER BLOCKED ───────────────────────────────────────────────
 * An unticked item is a prompt, not a gate. The list is derived from what the
 * request appears to touch, so it is sometimes wrong — asking for a schema on a
 * task that only reads one — and a checklist that can refuse to let you work is
 * a checklist people learn to defeat rather than use. It warns, clearly, and
 * then gets out of the way.
 */

export interface SourceChecklistProps {
  items: ChecklistItem[]
  onToggle: (id: string, done: boolean) => void
  onValue: (id: string, value: string) => void
  /** Compact mode drops the value inputs — used in the record review list. */
  readOnly?: boolean
}

export default function SourceChecklist({
  items,
  onToggle,
  onValue,
  readOnly = false
}: SourceChecklistProps): ReactElement | null {
  const progress = useMemo(() => {
    const required = items.filter((i) => i.required)
    return {
      done: required.filter((i) => i.done).length,
      required: required.length,
      complete: required.every((i) => i.done)
    }
  }, [items])

  if (!items.length) return null

  return (
    <div
      data-tour="dashboard.checklist"
      className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/25 p-3"
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
          Source checklist
        </span>

        {/* The completion indicator. Counts REQUIRED items only, because that
            is what "ready" means — optional ones never hold anything up. */}
        <span
          className={`rounded-md px-1.5 py-0.5 text-[9.5px] font-bold tabular-nums ${
            progress.complete
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'bg-amber-400/15 text-amber-400'
          }`}
        >
          {progress.done}/{progress.required} ready
        </span>

        <span className="ml-auto text-[10px] text-zinc-600">
          {progress.complete ? 'Nothing outstanding' : 'Missing inputs are recorded either way'}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {items.map((item) => {
          const outstanding = item.required && !item.done
          return (
            <div
              key={item.id}
              className={`rounded-lg border px-2.5 py-2 transition-colors ${
                outstanding
                  ? 'border-amber-400/20 bg-amber-400/[0.04]'
                  : 'border-white/[0.06] bg-white/[0.02]'
              }`}
            >
              <label className="flex cursor-pointer items-start gap-2.5">
                {/* A real checkbox rather than a styled div: it is focusable,
                    it is reachable by keyboard, and screen readers announce it
                    as what it is. */}
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={(e) => onToggle(item.id, e.target.checked)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className={`mt-[1px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[5px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-red-500/40 ${
                    item.done
                      ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-400'
                      : 'border-white/20 bg-black/40 text-transparent'
                  }`}
                >
                  <RiCheckLine size={11} />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`text-[11.5px] font-medium ${
                        item.done
                          ? 'text-zinc-400 line-through decoration-zinc-700'
                          : 'text-zinc-200'
                      }`}
                    >
                      {item.label}
                    </span>
                    {!item.required && (
                      <span className="text-[9px] font-medium text-zinc-600">optional</span>
                    )}
                  </span>

                  {/* The hint explains WHY it is being asked, and only while it
                      is still outstanding — once ticked it is noise. */}
                  {item.hint && !item.done && (
                    <span className="mt-0.5 flex items-start gap-1 text-[10px] leading-relaxed text-zinc-600">
                      <RiInformationLine size={10} className="mt-[2px] shrink-0" />
                      {item.hint}
                    </span>
                  )}
                </span>
              </label>

              {/* The answer itself. Optional — ticking is enough — but what is
                  written here ends up in the review packet, which is where it
                  earns its keep. */}
              {!readOnly && (
                <input
                  value={item.value ?? ''}
                  onChange={(e) => onValue(item.id, e.target.value)}
                  placeholder="Add the detail — a path, a link, a sentence"
                  className="mt-1.5 w-full rounded-md border border-white/[0.07] bg-black/40 px-2 py-1 text-[10.5px] text-zinc-300 outline-none transition-colors placeholder:text-zinc-700 focus:border-red-500/30"
                />
              )}
              {readOnly && item.value?.trim() && (
                <p className="mt-1 pl-[25px] text-[10.5px] leading-relaxed text-zinc-500">
                  {item.value}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
