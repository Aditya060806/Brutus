import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react'
import { RiAlertLine, RiRefreshLine } from 'react-icons/ri'

/**
 * Contain a render failure to the smallest thing that can fail.
 *
 * Brutus has one `SystemErrorBoundary` at the root of the app. It catches
 * everything, which sounds thorough and is actually the problem: a render error
 * in a single agent window took down voice, the robot link and every other view
 * with it. The blast radius of one bad node should be that node.
 *
 * Used around the Studio view so the canvas cannot take the app, around each
 * agent window so one window cannot take the canvas, and around each settings
 * panel — those talk to thirteen different IPC surfaces, several of which probe
 * external binaries.
 */
interface Props {
  children: ReactNode
  /** Shown in the fallback so you know what died. */
  label: string
  /**
   * The reassurance line under the title.
   *
   * Defaults to the Studio wording. Other hosts pass their own — telling
   * someone their agents are fine when they were changing an API key is
   * confusing rather than reassuring.
   */
  note?: string
  /** Rendered instead of the default card, for tight spaces like a node body. */
  compact?: boolean
  /** Offered as a recovery action when the caller can genuinely retry. */
  onReset?: () => void
}

interface State {
  error: Error | null
}

export default class StudioErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console rather than swallowed: the fallback tells the user
    // what to do, the console tells whoever debugs it what happened.
    console.error(`[Studio] ${this.props.label} crashed:`, error, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const message = error.message || 'Unknown error'

    if (this.props.compact) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center">
          <RiAlertLine className="text-red-400" size={18} />
          <p className="text-[11px] font-medium text-zinc-300">This window crashed</p>
          <p className="max-w-[220px] truncate text-[10px] text-zinc-600" title={message}>
            {message}
          </p>
          <button
            onClick={this.reset}
            className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1 text-[10px] font-semibold text-zinc-300 transition-colors hover:bg-white/[0.12]"
          >
            <RiRefreshLine size={11} /> Reload it
          </button>
        </div>
      )
    }

    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-red-500/25 bg-red-500/10">
          <RiAlertLine className="text-red-400" size={20} />
        </div>
        <p className="text-[14px] font-semibold text-zinc-100">{this.props.label} stopped</p>
        <p className="max-w-[420px] text-[11.5px] leading-relaxed text-zinc-500">
          {this.props.note ??
            'The rest of Brutus is unaffected — your agents are still running in the background.'}
        </p>
        <pre className="max-w-[520px] overflow-x-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-left font-mono text-[10.5px] text-zinc-400">
          {message}
        </pre>
        <button
          onClick={this.reset}
          className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-lg bg-red-500/15 px-3 py-1.5 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-500/25"
        >
          <RiRefreshLine size={12} /> Try again
        </button>
      </div>
    )
  }
}
