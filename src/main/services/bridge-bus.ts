/**
 * BRUTUS Desktop Bridge — internal event bus
 * ------------------------------------------
 * A process-wide EventEmitter that decouples the chat/state producers (the
 * memory-save IPC handler, the renderer via IPC) from the bridge server. This
 * keeps `desktop-bridge.ts` from having to reach into unrelated modules and
 * lets the bridge be added/removed without touching the chat pipeline.
 *
 * Flow:
 *   • `add-message` IPC (a message produced ON the desktop) emits OUTBOUND_MESSAGE
 *     → the bridge broadcasts it to every connected phone.
 *   • The bridge, when it needs to persist a phone/AI message into desktop
 *     history WITHOUT re-broadcasting, emits PERSIST_MESSAGE (handled by
 *     memory-save). This is how loops are avoided.
 */
import { EventEmitter } from 'events'

export const BRIDGE_EVENTS = {
  /** A desktop-originated chat message that should be pushed to phones. */
  OUTBOUND_MESSAGE: 'outbound-message',
  /** Persist a message into desktop history without broadcasting it. */
  PERSIST_MESSAGE: 'persist-message'
} as const

export interface BusMessage {
  /** desktop convention: 'user' | 'model'. */
  role: string
  text: string
}

class BridgeBus extends EventEmitter {}

export const bridgeBus = new BridgeBus()
// Many transient producers may attach; lift the default 10-listener warning.
bridgeBus.setMaxListeners(50)
