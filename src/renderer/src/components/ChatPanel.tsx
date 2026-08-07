import { useState, useEffect, useRef } from 'react'
import { RiCloseLine, RiSendPlane2Fill, RiChat3Line, RiLoader4Line } from 'react-icons/ri'
import Markdown from '@renderer/components/Markdown'
import { sendTextChat } from '@renderer/tools/text-chat'
import { getHistory } from '@renderer/services/brutus-ai-brain'
import {
  orchestrator,
  isAgentCommand,
  stripAgentCommand,
  AGENT_COMMAND
} from '@renderer/services/orchestrator-client'

interface ChatMessage {
  role: 'user' | 'model'
  text: string
}

interface ChatPanelProps {
  open: boolean
  onClose: () => void
}

export default function ChatPanel({ open, onClose }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Load existing conversation history when opened
  useEffect(() => {
    if (!open) return
    let cancelled = false
    getHistory().then((h) => {
      if (cancelled) return
      const mapped = (h || [])
        .slice(-30)
        .map(
          (m: any): ChatMessage => ({
            role: m.role === 'model' ? 'model' : 'user',
            text: m.parts?.[0]?.text || ''
          })
        )
        .filter((m) => m.text)
      setMessages(mapped)
    })
    setTimeout(() => inputRef.current?.focus(), 100)
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setMessages((m) => [...m, { role: 'user', text }])
    setBusy(true)
    try {
      // `/agent` is the ONLY path into multi-agent orchestration. Everything
      // else takes the normal single-call route, so ordinary chat gains no
      // latency from this feature existing.
      if (isAgentCommand(text)) {
        const request = stripAgentCommand(text)
        if (!request) {
          setMessages((m) => [
            ...m,
            {
              role: 'model',
              text:
                `**Agent mode**\n\nUsage: \`${AGENT_COMMAND} <a complex, multi-step request>\`\n\n` +
                `Brutus plans the work, runs specialists in parallel, and merges the result.\n\n` +
                `Example:\n\`${AGENT_COMMAND} research the top 3 on-device LLM runtimes, compare them, save it as a note and draft me an email about it\`\n\n` +
                `Watch it work in the ORCHESTRATOR tab.`
            }
          ])
          return
        }
        const started = await orchestrator.run(request)
        if (!started.ok) {
          setMessages((m) => [...m, { role: 'model', text: `❌ ${started.error}` }])
          return
        }
        setMessages((m) => [
          ...m,
          { role: 'model', text: '🧠 Agents working. Open the ORCHESTRATOR tab to watch.' }
        ])
        const { answer } = await orchestrator.waitForAnswer()
        setMessages((m) => [...m, { role: 'model', text: answer }])
        return
      }

      const res = await sendTextChat(text)
      const reply =
        res.text && res.text.trim() ? res.text : '⚠️ No response received. Please try again.'
      setMessages((m) => [...m, { role: 'model', text: reply }])
    } catch (err) {
      setMessages((m) => [...m, { role: 'model', text: `❌ System error: ${String(err)}` }])
    } finally {
      setBusy(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  if (!open) return null

  return (
    <div className="fixed bottom-20 right-6 z-[9070] w-[400px] max-w-[90vw] h-[560px] max-h-[80vh] flex flex-col rounded-2xl border border-red-500/30 bg-zinc-950/95 backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.7)] animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <RiChat3Line className="text-red-500" size={18} />
          <span className="text-[11px] font-bold tracking-[0.2em] text-red-400 uppercase">
            BRUTUS // Text Mode
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-zinc-500 hover:text-white rounded-full hover:bg-white/5 transition-all"
        >
          <RiCloseLine size={18} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && !busy && (
          <div className="h-full flex flex-col items-center justify-center text-center text-zinc-600 gap-2">
            <RiChat3Line size={36} />
            <p className="text-xs font-mono tracking-wide">Type to chat with BRUTUS.</p>
            <p className="text-[10px] text-zinc-700">Shift+Enter for a new line.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] px-3.5 py-2.5 rounded-2xl text-sm break-words ${
                m.role === 'user'
                  ? 'bg-red-500/20 border border-red-500/30 text-red-50 rounded-br-sm whitespace-pre-wrap'
                  : 'bg-white/5 border border-white/10 text-zinc-200 rounded-bl-sm'
              }`}
            >
              {/* Only Brutus writes Markdown. What the user typed is shown
                  verbatim so their own asterisks or hashes are never eaten. */}
              {m.role === 'user' ? m.text : <Markdown density="compact">{m.text}</Markdown>}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="px-3.5 py-2.5 rounded-2xl bg-white/5 border border-white/10 text-zinc-400 flex items-center gap-2">
              <RiLoader4Line className="animate-spin" size={16} />
              <span className="text-xs font-mono">thinking…</span>
            </div>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-white/5">
        <div className="flex items-end gap-2 bg-black/40 border border-white/10 rounded-xl px-3 py-2 focus-within:border-red-500/40 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Message BRUTUS…"
            className="flex-1 bg-transparent outline-none resize-none text-sm text-zinc-100 placeholder:text-zinc-600 max-h-28"
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            className="p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-300 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            <RiSendPlane2Fill size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
