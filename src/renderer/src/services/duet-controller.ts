/**
 * BRUTUS — Duet Mode (desktop orchestrator)
 * -----------------------------------------
 * Two paired Brutus instances hold a live, self-aware banter:
 *   • PC-Brutus  — this desktop app: glowing on-screen eyes, all the PC tools.
 *   • Robo-Brutus — the phone: drives the physical robot head (servos/LEDs).
 *
 * The DESKTOP is always the brain: it generates every line via the `llm-chat`
 * IPC (Brain Node → Gemini), alternating personas. Each line is broadcast over
 * the bridge tagged with a `speaker`; the speaker's own device voices it while
 * both devices display it. The phone only reacts (it never generates).
 *
 * Triggers: the desktop Duet button (start here) or a `duet.start` command from
 * the phone. A max-turn cap, per-turn delay and Stop keep it bounded.
 */
import { emotionBus, type FaceExpression } from '@renderer/components/BrutusEyes/emotionBus'
import { onBridgeEvent } from '@renderer/services/bridge-client'

type Speaker = 'host' | 'mobile'

const NAME: Record<Speaker, string> = { host: 'PC-Brutus', mobile: 'Robo-Brutus' }
const MAX_TURNS = 6
const CYCLE: FaceExpression[] = ['happy', 'surprised', 'neutral']

export interface DuetUiEvent {
  kind: 'start' | 'turn' | 'stop'
  speaker?: Speaker
  name?: string
  text?: string
  reason?: string
}

const ipc = (): any => (window as any).electron?.ipcRenderer

function clean(raw: string): string {
  let t = (raw || '').trim()
  // Strip a leading "Name:" prefix and wrapping quotes the model sometimes adds.
  t = t.replace(/^\s*(PC-?Brutus|Robo-?Brutus|Brutus)\s*[:\-–]\s*/i, '')
  t = t.replace(/^["'“”]+|["'“”]+$/g, '').trim()
  // One line only.
  t = t.split('\n')[0].trim()
  if (t.length > 220) t = t.slice(0, 217).trimEnd() + '…'
  return t
}

function persona(me: string, other: string): string {
  return (
    `You are ${me}, one of two instances of the AI "Brutus" having a live, out-loud banter with your other self, ${other}.\n` +
    `• PC-Brutus lives in the desktop app — glowing on-screen eyes, runs every heavy PC tool (files, code, automation). The "brains".\n` +
    `• Robo-Brutus lives in the phone — drives a physical robot head with servos, LEDs and a moving mouth. The "body".\n` +
    `You both KNOW you are the same mind split across two bodies, and you tease each other about it (brains vs body, cloud vs metal).\n` +
    `Write ONLY ${me}'s next line: ONE short, punchy, witty sentence (max ~18 words). ` +
    `No name prefix, no quotes, no stage directions, no emojis.`
  )
}

class DuetController {
  private inited = false
  private active = false
  private runId = 0
  private turn = 0
  private transcript: string[] = []
  private soloVoice = false // true when no phone is paired → desktop voices both
  private listeners = new Set<(e: DuetUiEvent) => void>()

  get isActive(): boolean {
    return this.active
  }

  /** Wire up once — start listening for duet commands coming from the phone. */
  init(): void {
    if (this.inited) return
    this.inited = true
    onBridgeEvent((e) => {
      if (e.type !== 'command') return
      const d = e.payload || {}
      if (d.name !== 'duet') return
      if (d.action === 'start' && !this.active) {
        void this.run('mobile', d.topic)
      } else if (d.action === 'stop') {
        this.halt('remote')
      }
    })
  }

  subscribe(fn: (e: DuetUiEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: DuetUiEvent): void {
    this.listeners.forEach((fn) => {
      try {
        fn(e)
      } catch {
        /* ignore */
      }
    })
    window.dispatchEvent(new CustomEvent('brutus-duet', { detail: e }))
  }

  /** Start from the desktop button. */
  async start(topic?: string): Promise<void> {
    if (this.active) return
    this.broadcast({ name: 'duet', action: 'start', initiator: 'host', maxTurns: MAX_TURNS, topic })
    await this.run('host', topic)
  }

  /** Stop from the desktop button. */
  stop(): void {
    this.broadcast({ name: 'duet', action: 'stop', reason: 'user' })
    this.halt('user')
  }

  /**
   * Inspect a finalized user utterance for a hands-free duet command.
   * Returns true if it matched (so callers can note it was handled).
   * Examples: "talk to each other", "duet", "start a duet", "stop the duet".
   */
  handleUtterance(text: string): boolean {
    const t = (text || '').toLowerCase().trim()
    if (!t) return false
    // Check stop first — "stop the duet" also contains "duet".
    if (
      this.active &&
      /\b(stop|end|quit|enough|cut it out|shut up)\b/.test(t) &&
      /\b(duet|talk)/.test(t)
    ) {
      this.stop()
      return true
    }
    const isStart =
      /\bduet\b/.test(t) ||
      /\btalk(ing)?\s+to\s+(each ?other|yourself|your other self|your ?self|itself|themselves)\b/.test(
        t
      ) ||
      /\btalk\s+amongst\s+yourselves\b/.test(t)
    if (isStart && !this.active) {
      this.start()
      return true
    }
    return false
  }

  private halt(reason: string): void {
    if (!this.active) return
    this.active = false
    this.runId++
    try {
      window.speechSynthesis?.cancel()
    } catch {
      /* ignore */
    }
    emotionBus.setExpression('neutral', 0.6)
    this.emit({ kind: 'stop', reason })
  }

  private broadcast(data: Record<string, unknown>): void {
    try {
      ipc()?.invoke('bridge-send', { type: 'command', data })
    } catch {
      /* bridge optional */
    }
  }

  private async run(initiator: Speaker, topic?: string): Promise<void> {
    this.active = true
    this.turn = 0
    this.transcript = []
    const myRun = ++this.runId

    // If no phone is connected, the desktop voices both characters so a solo
    // demo still works.
    this.soloVoice = await this.detectSolo()

    this.emit({ kind: 'start' })

    let speaker: Speaker = initiator
    while (this.active && this.runId === myRun && this.turn < MAX_TURNS) {
      this.turn++
      const line = await this.generate(speaker, topic)
      if (!this.active || this.runId !== myRun) break
      if (!line) break

      this.transcript.push(`${NAME[speaker]}: ${line}`)
      const emotion = CYCLE[this.turn % CYCLE.length]

      // Tell the phone about this turn (it voices its own lines + displays all).
      this.broadcast({ name: 'duet', action: 'turn', turn: this.turn, text: line, speaker, emotion })

      // Present on the desktop.
      this.emit({ kind: 'turn', speaker, name: NAME[speaker], text: line })
      emotionBus.setExpression(emotion, 0.9)

      const shouldVoice = speaker === 'host' || this.soloVoice
      if (shouldVoice) {
        await this.speak(line, speaker)
      } else {
        // Approximate the phone's speaking time so turns don't stampede.
        await this.delay(900 + line.length * 55)
      }
      if (!this.active || this.runId !== myRun) break
      await this.delay(450)

      speaker = speaker === 'host' ? 'mobile' : 'host'
    }

    if (this.runId === myRun) {
      this.active = false
      emotionBus.setExpression('neutral', 0.6)
      this.emit({ kind: 'stop', reason: 'done' })
    }
  }

  private async generate(speaker: Speaker, topic?: string): Promise<string> {
    const me = NAME[speaker]
    const other = NAME[speaker === 'host' ? 'mobile' : 'host']
    const convo =
      this.transcript.length > 0
        ? this.transcript.join('\n')
        : `(${me} kicks off the banter${topic ? ` about ${topic}` : ''}.)`
    try {
      const res = await ipc()?.invoke('llm-chat', {
        messages: [{ role: 'user', content: `${convo}\n\n${me}:` }],
        systemInstruction: persona(me, other)
      })
      return clean(res?.text || '')
    } catch {
      return ''
    }
  }

  private speak(text: string, speaker: Speaker): Promise<void> {
    return new Promise((resolve) => {
      try {
        const synth = window.speechSynthesis
        if (!synth) {
          resolve()
          return
        }
        const u = new SpeechSynthesisUtterance(text)
        // Give the two selves distinct voices.
        u.rate = speaker === 'host' ? 1.02 : 1.08
        u.pitch = speaker === 'host' ? 0.95 : 1.2
        const voices = synth.getVoices()
        if (voices.length) {
          const pick =
            speaker === 'host'
              ? voices.find((v) => /david|male|google uk english male/i.test(v.name))
              : voices.find((v) => /zira|female|google uk english female/i.test(v.name))
          if (pick) u.voice = pick
        }
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          resolve()
        }
        u.onend = finish
        u.onerror = finish
        // Safety timeout in case onend never fires.
        setTimeout(finish, 1500 + text.length * 90)
        synth.speak(u)
      } catch {
        resolve()
      }
    })
  }

  private async detectSolo(): Promise<boolean> {
    try {
      const status = await ipc()?.invoke('bridge-status')
      const phones = (status?.devices || []).filter((d: any) => d.role === 'mobile')
      return phones.length === 0
    } catch {
      return true
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}

export const duetController = new DuetController()
