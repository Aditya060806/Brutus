/**
 * BRUTUS Studio — screen reconstruction
 * --------------------------------------
 * What did the human actually see?
 *
 * Routing an agent's output into another agent means answering that question
 * exactly. The first attempt cleaned the raw byte stream with regexes — strip
 * ANSI, take the last frame after a carriage return, drop spinner lines. That
 * handles the easy cases and quietly fails the real ones:
 *
 *   • `\x1b[2A\x1b[2K` — the TUI moves the cursor up two rows and rewrites a
 *     line. Byte-order cleaning keeps the draft AND the correction.
 *   • Erase-in-display, scroll regions, and the alternate screen buffer have no
 *     byte-level equivalent at all.
 *   • Wrapped lines look like hard newlines, so a long sentence arrives at the
 *     next agent chopped at 80 columns.
 *
 * The only correct answer is to run the bytes through a terminal emulator and
 * read the resulting screen. This uses `@xterm/headless` — the same engine the
 * renderer displays with — so what Brutus routes and what the user is looking
 * at agree by construction rather than by coincidence.
 *
 * A screen is reset at the start of each turn, which sidesteps absolute line
 * indexing entirely: whatever the emulator holds at the end of a turn IS that
 * turn's output. It also means a full-screen TUI that repaints everything gives
 * us its final rendered state rather than every intermediate frame.
 */
import { Terminal } from '@xterm/headless'

/**
 * Scrollback for a single turn. Generous for real output, bounded so a runaway
 * agent on a canvas of fifteen nodes cannot eat memory.
 */
const TURN_SCROLLBACK = 2000

/** Lines that are pure decoration rather than content. */
const SPINNER_ONLY = /^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✢✳✶✻✽·∴*+]*$/u
const BOX_ONLY = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝▔▁▏▕]*$/u

export class TerminalScreen {
  private term: Terminal
  private cols: number
  private rows: number

  constructor(cols = 100, rows = 30) {
    this.cols = Math.max(20, cols)
    this.rows = Math.max(5, rows)
    this.term = this.create()
  }

  private create(): Terminal {
    return new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: TURN_SCROLLBACK,
      // `buffer` is proposed API; reading it is the entire point of this class.
      allowProposedApi: true
    })
  }

  write(chunk: string): void {
    this.term.write(chunk)
  }

  /**
   * Match the real pty's geometry.
   *
   * Wrapping depends on width, so a screen reconstructed at the wrong width
   * would rejoin lines in the wrong places.
   */
  resize(cols: number, rows: number): void {
    const c = Math.max(20, Math.floor(cols))
    const r = Math.max(5, Math.floor(rows))
    if (c === this.cols && r === this.rows) return
    this.cols = c
    this.rows = r
    try {
      this.term.resize(c, r)
    } catch {
      // A resize that the emulator rejects is not worth losing the screen over.
    }
  }

  /** Start a new turn. Everything before this is no longer our concern. */
  reset(): void {
    const previous = this.term
    this.term = this.create()
    try {
      previous.dispose()
    } catch {
      // Disposal is best-effort; the replacement is already in place.
    }
  }

  /**
   * Wait for the parser to drain.
   *
   * `write` is asynchronous — xterm queues chunks and parses them on its own
   * schedule. Reading the buffer without waiting returns a half-parsed screen,
   * which is exactly the kind of intermittent wrongness that would be blamed on
   * the model instead of on this.
   */
  flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      // A guard: if the callback never fires we return whatever is rendered
      // rather than hanging the handoff forever.
      const timer = setTimeout(done, 500)
      try {
        this.term.write('', () => {
          clearTimeout(timer)
          done()
        })
      } catch {
        clearTimeout(timer)
        done()
      }
    })
  }

  /**
   * The rendered screen as text.
   *
   * Wrapped rows are rejoined into the logical line they came from, because a
   * terminal wrapping at column 100 is a display detail — passing that on as a
   * hard newline would hand the next agent a sentence cut in half.
   */
  read(): string {
    const buffer = this.term.buffer.active
    const lines: string[] = []

    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (!line) continue
      const text = line.translateToString(true)
      if (line.isWrapped && lines.length) {
        lines[lines.length - 1] += text
      } else {
        lines.push(text)
      }
    }

    return lines.join('\n')
  }

  dispose(): void {
    try {
      this.term.dispose()
    } catch {
      // Nothing useful to do if the emulator is already gone.
    }
  }
}

/**
 * Drop the chrome from a rendered screen.
 *
 * The emulator has already resolved redraws, so this only removes what is
 * decoration in the final render: spinner glyphs left on screen, box borders,
 * and runs of blank lines. It deliberately does NOT de-duplicate adjacent
 * identical lines any more — that was a workaround for redraw frames, and now
 * that redraws are handled properly it would only corrupt real output that
 * happens to repeat a line.
 */
export function tidyScreen(screen: string): string {
  return screen
    .split('\n')
    .map((l) => l.replace(/[\t ]+$/g, ''))
    .filter((l) => !SPINNER_ONLY.test(l) && !BOX_ONLY.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
