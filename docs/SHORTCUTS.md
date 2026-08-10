# Brutus — Keyboard shortcuts

## Global

These work anywhere in Windows, even when Brutus is not the focused window.

| Shortcut | Action |
|:--|:--|
| `Ctrl + Shift + I` | Toggle **overlay mode** — shrink Brutus to a floating pill, and back |
| `Ctrl + Alt + Space` | **Phantom** — a floating AI writer at your cursor. Type an instruction, press Enter, and the result is pasted into whatever field you were in |
| `Ctrl + Alt + X` | **ScreenPeeler** — drag-select any region of the screen, and its text is OCR'd to your clipboard. `Esc` cancels |

## Studio canvas

| Shortcut | Action |
|:--|:--|
| `W` `A` `S` `D` | Pan the canvas (`Shift` for larger steps) |
| `Ctrl + 0` | Fit everything on screen |
| Scroll | Zoom |
| Click an edge | Open the edge inspector — change handoff, branch or loop |
| Drag a node edge | Resize a window; the terminal reflows to match |

## Chat and text fields

| Shortcut | Action |
|:--|:--|
| `Enter` | Send |
| `Shift + Enter` | New line |
| `Esc` | Close the open panel or overlay |

## Notes

Anything else you see inside an agent's terminal — `ctrl+shift+P`, `? for shortcuts`, `esc to interrupt` — belongs to **that CLI**, not to Brutus. Studio runs the real binaries, so their own key bindings are live while their window has focus.

Brutus registers exactly three global shortcuts. It does not intercept anything else system-wide.
