/**
 * BRUTUS Robot Speaker — Mode-2 audio path (desktop → ESP2 voice box)
 * -------------------------------------------------------------------
 * Streams the desktop's TTS PCM (16-bit LE mono @ 24 kHz) to the V2 robot's
 * ESP2 audio board over UDP :8083, so Brutus's actual words come out of the
 * robot instead of only the laptop speakers. Mirrors the phone's
 * `robot_v2_audio_stream.dart`.
 *
 * ── WHY THIS PACES THE SEND (the whole point of this module) ────────────────
 * Gemini's native-audio model streams a reply MUCH faster than real time —
 * several seconds of speech can arrive in under a second. Firing that straight
 * at the ESP32 overruns its jitter buffer, which then drops samples, and the
 * robot plays chopped, sped-up, unintelligible speech. The ESP2 firmware even
 * documents this ("an early build overran it ... made the voice sound fast and
 * garbled"), and on overflow it deliberately drops the NEWEST sample.
 *
 * So we buffer here (the PC has plenty of RAM) and emit audio at exactly the
 * rate the speaker consumes it: 24000 samples/s × 2 bytes = 48000 B/s. The
 * ESP2's buffer then stays shallow and healthy, and the voice comes out at the
 * right speed and fully intelligible.
 *
 * The pacer is drift-corrected: instead of assuming a timer fires exactly every
 * 20 ms (Node timers coalesce and run late), it converts *elapsed wall time*
 * into a byte budget. A late tick sends proportionally more, so playback never
 * falls behind; the budget is clamped and reset while idle so a stall can never
 * turn into a burst that re-overruns the robot.
 *
 * ── ADDRESSING ─────────────────────────────────────────────────────────────
 * ESP2 has its own IP, separate from the ESP1 body controller we command.
 * Rather than discover it, we send to the subnet-directed broadcast derived
 * from the ESP1 IP (192.168.1.50 → 192.168.1.255). ESP2 is the only device
 * listening on :8083, so this needs no handshake.
 */
import { IpcMain, BrowserWindow } from 'electron'
import dgram from 'dgram'

export const ROBOT_AUDIO_UDP_PORT = 8083

/** ESP2 runs its I2S amp at this rate; the PCM we send must match exactly. */
const SAMPLE_RATE = 24000
const BYTES_PER_SAMPLE = 2
const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000 // 48 B/ms

/** Pacer granularity. 20 ms → 960 B datagrams: small, and well under ESP2's 1500 B rx buffer. */
const TICK_MS = 20
const MAX_DATAGRAM = BYTES_PER_MS * TICK_MS // 960

/**
 * Ceiling on how much elapsed time one tick may bank. Without this, a GC pause
 * or a sleeping timer would hand us a huge budget and we'd burst — exactly the
 * overrun this module exists to prevent.
 */
const MAX_TICK_CATCHUP_MS = 60

/** Never hold more than ~8 s of speech; beyond that the reply is stale. */
const MAX_QUEUE_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 8

interface RegisterOpts {
  ipcMain: IpcMain
  getWindow: () => BrowserWindow | null
}

export default function registerRobotAudio({ ipcMain, getWindow }: RegisterOpts): void {
  let socket: dgram.Socket | null = null
  let target: string | null = null
  let pacer: NodeJS.Timeout | null = null

  // Pending PCM, as a list of chunks with a read offset into the head.
  let queue: Buffer[] = []
  let queuedBytes = 0
  let headOffset = 0

  let creditBytes = 0 // byte budget earned from elapsed wall time
  let lastTickAt = 0
  let packetsSent = 0
  let bytesSent = 0

  const log = (m: string): void => console.log(`[RobotAudio] ${m}`)

  const emit = (payload: Record<string, unknown>): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('robot-audio-event', payload)
  }

  const bufferedBytes = (): number => queuedBytes - headOffset
  const bufferedMs = (): number => Math.round(bufferedBytes() / BYTES_PER_MS)

  /** 192.168.1.50 → 192.168.1.255 (ESP2 sits on the same subnet as ESP1). */
  const broadcastFor = (ip: string): string | null => {
    const host = String(ip || '')
      .replace(/^\w+:\/\//, '')
      .split('/')[0]
      .split(':')[0]
      .trim()
    const parts = host.split('.')
    if (parts.length !== 4) return null
    for (const p of parts) {
      const n = Number(p)
      if (!Number.isInteger(n) || n < 0 || n > 255) return null
    }
    return `${parts[0]}.${parts[1]}.${parts[2]}.255`
  }

  const clearQueue = (): void => {
    queue = []
    queuedBytes = 0
    headOffset = 0
    creditBytes = 0
  }

  /** Pull exactly [want] bytes out of the queue, stitching across chunks. */
  const take = (want: number): Buffer | null => {
    if (want <= 0 || bufferedBytes() <= 0) return null
    const out = Buffer.allocUnsafe(Math.min(want, bufferedBytes()))
    let filled = 0
    while (filled < out.length && queue.length > 0) {
      const head = queue[0]
      const avail = head.length - headOffset
      const n = Math.min(avail, out.length - filled)
      head.copy(out, filled, headOffset, headOffset + n)
      filled += n
      headOffset += n
      if (headOffset >= head.length) {
        queue.shift()
        queuedBytes -= head.length
        headOffset = 0
      }
    }
    return filled > 0 ? out.subarray(0, filled) : null
  }

  const tick = (): void => {
    const s = socket
    const t = target
    if (!s || !t) return

    const now = Date.now()
    const dt = Math.min(now - lastTickAt, MAX_TICK_CATCHUP_MS)
    lastTickAt = now

    // Idle: bank nothing, so the first chunk of the next reply starts clean
    // instead of being flushed out in one burst.
    if (bufferedBytes() <= 0) {
      creditBytes = 0
      return
    }

    creditBytes += dt * BYTES_PER_MS
    // Keep PCM16 frame alignment — a half-sample would desync the whole stream.
    let budget = Math.floor(creditBytes / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE
    if (budget <= 0) return

    while (budget > 0) {
      const chunk = take(Math.min(budget, MAX_DATAGRAM))
      if (!chunk) break
      try {
        s.send(chunk, ROBOT_AUDIO_UDP_PORT, t)
        packetsSent++
        bytesSent += chunk.length
      } catch {
        // A dropped datagram is a tiny glitch; keep the stream flowing.
      }
      creditBytes -= chunk.length
      budget -= chunk.length
    }
  }

  const stop = (): void => {
    if (pacer) clearInterval(pacer)
    pacer = null
    clearQueue()
    if (socket) {
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      socket = null
    }
    target = null
    emit({ type: 'state', streaming: false })
  }

  // ── IPC surface ───────────────────────────────────────────────────────────

  ipcMain.handle('robot-audio-start', async (_e, opts: { host?: string }) => {
    const bcast = broadcastFor(opts?.host || '')
    if (!bcast)
      return { ok: false, error: `Cannot derive a broadcast address from "${opts?.host}".` }

    stop()
    return await new Promise<{ ok: boolean; target?: string; error?: string }>((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      sock.once('error', (err) => {
        log(`socket error: ${err.message}`)
        try {
          sock.close()
        } catch {
          /* noop */
        }
        socket = null
        resolve({ ok: false, error: err.message })
      })
      sock.bind(() => {
        try {
          sock.setBroadcast(true)
        } catch (err) {
          log(`setBroadcast failed: ${err}`)
        }
        socket = sock
        target = bcast
        packetsSent = 0
        bytesSent = 0
        clearQueue()
        lastTickAt = Date.now()
        pacer = setInterval(tick, TICK_MS)
        log(`streaming to ${bcast}:${ROBOT_AUDIO_UDP_PORT} (paced ${BYTES_PER_MS * 1000} B/s)`)
        emit({ type: 'state', streaming: true, target: bcast })
        resolve({ ok: true, target: bcast })
      })
    })
  })

  /**
   * Queue one PCM chunk (base64 of 16-bit LE mono @ 24 kHz). Returns
   * immediately — the pacer emits it at playback speed.
   */
  ipcMain.handle('robot-audio-push', async (_e, opts: { base64?: string }) => {
    if (!socket || !opts?.base64) return { ok: false }
    let buf: Buffer
    try {
      buf = Buffer.from(opts.base64, 'base64')
    } catch {
      return { ok: false, error: 'Bad base64 payload.' }
    }
    if (!buf.length) return { ok: false }

    queue.push(buf)
    queuedBytes += buf.length

    // Runaway guard: shed the oldest audio if we somehow fall absurdly behind.
    while (bufferedBytes() > MAX_QUEUE_BYTES && queue.length > 0) {
      const head = queue.shift()!
      queuedBytes -= head.length
      headOffset = 0
    }
    return { ok: true, bufferedMs: bufferedMs() }
  })

  /** Drop everything pending — used on barge-in so the robot stops mid-reply. */
  ipcMain.handle('robot-audio-flush', async () => {
    clearQueue()
    return { ok: true }
  })

  ipcMain.handle('robot-audio-stop', async () => {
    stop()
    return { ok: true }
  })

  ipcMain.handle('robot-audio-status', async () => ({
    streaming: !!socket,
    target,
    bufferedMs: bufferedMs(),
    packetsSent,
    bytesSent
  }))
}
