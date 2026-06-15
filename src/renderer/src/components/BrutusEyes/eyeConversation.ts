import { emotionBus } from './emotionBus'
import type { BrutusEmotion } from '@renderer/services/Brutus-voice-ai'

// ─── Pattern tables ───────────────────────────────────────────────────

const BRUTUS_FAREWELL = /\b(goodbye|bye|farewell|take care|see you|until next time)\b/i
const BRUTUS_SUCCESS  = /\b(done|complete|finished|success|accomplished|all set|there you go)\b/i
const BRUTUS_DUNNO    = /\b(i don'?t know|not sure|i'?m unsure|i cannot|i can'?t tell)\b/i
const BRUTUS_JOKE     = /\b(haha|hehe|lol|:D|joke|funny|hilarious)\b/i
const BRUTUS_LOVE     = /\b(love|amazing|wonderful|great job|proud of you|fantastic|magnificent)\b/i
const BRUTUS_SORRY    = /\b(sorry|unfortunately|failed|my mistake|i apologize|regret)\b/i
const BRUTUS_WOW      = /\b(wow|incredible|really\?!?|amazing!|no way|seriously\?)\b/i
const BRUTUS_WARNING  = /\b(warning|stop|don'?t|dangerous|careful|alert)\b/i
const BRUTUS_THINKING = /\b(hmm|let me think|analyzing|processing|a moment|one second)\b/i

const USER_QUESTION   = /\?$/
const USER_THANK      = /\b(thank you|thanks|thank u|thx|love you|you'?re great|you'?re amazing)\b/i
const USER_WOW        = /\b(wow|amazing|incredible|whoa|awesome|holy)\b/i
const USER_BYE        = /\b(bye|goodbye|see you|cya|later|night|good night)\b/i
const USER_CAPS_WORD  = /\b[A-Z]{6,}\b/  // 6+ consecutive caps = shouting (avoids acronyms like UI, UX, CSS, GSAP)

// ─── Sentiment scan (streaming, called every 400ms on buffering text) ─
export function scanSentiment(text: string): { emotion: BrutusEmotion; gesture: string; duration: number } | null {
  const t = text.toLowerCase()
  if (BRUTUS_LOVE.test(t))    return { emotion: 'love',      gesture: 'heartEyes',          duration: 3500 }
  if (BRUTUS_SORRY.test(t))   return { emotion: 'sad',       gesture: 'sadTearBlink',        duration: 4000 }
  if (BRUTUS_WOW.test(t))     return { emotion: 'happy',     gesture: 'excitedDance',        duration: 2500 }
  if (BRUTUS_WARNING.test(t)) return { emotion: 'angry',     gesture: 'intimidationStare',   duration: 3000 }
  if (BRUTUS_THINKING.test(t))return { emotion: 'neutral',   gesture: 'thinkingLookUpLeft',  duration: 2000 }
  if (BRUTUS_JOKE.test(t))    return { emotion: 'happy',     gesture: 'jokeLaugh',           duration: 2000 }
  return null
}

// ─── Full turn analysis (called on turnComplete) ──────────────────────
export function analyzeAndReact(text: string, role: 'user' | 'brutus'): void {
  if (!text || text.length < 3) return

  if (role === 'brutus') {
    if (BRUTUS_FAREWELL.test(text)) {
      emotionBus.triggerGesture('dismissiveBlink')
      return
    }
    if (BRUTUS_SUCCESS.test(text)) {
      emotionBus.setConversationEmotion('happy', 3000)
      emotionBus.triggerGesture('taskComplete')
      return
    }
    if (BRUTUS_DUNNO.test(text)) {
      emotionBus.setConversationEmotion('sad', 4000)
      emotionBus.triggerGesture('sadTearBlink')
      return
    }
    if (BRUTUS_JOKE.test(text)) {
      emotionBus.setConversationEmotion('happy', 2500)
      emotionBus.triggerGesture('jokeLaugh')
      return
    }
    // Run the full sentiment scan on complete turn
    const result = scanSentiment(text)
    if (result) {
      emotionBus.setConversationEmotion(result.emotion, result.duration)
      emotionBus.triggerGesture(result.gesture)
    }
    return
  }

  // User message reactions
  if (USER_THANK.test(text)) {
    emotionBus.setConversationEmotion('love', 3500)
    emotionBus.triggerGesture('heartEyes')
    return
  }
  if (USER_BYE.test(text)) {
    emotionBus.triggerGesture('shyLookAway')
    return
  }
  if (USER_WOW.test(text)) {
    emotionBus.triggerGesture('startle')
    return
  }
  if (USER_CAPS_WORD.test(text)) {
    emotionBus.triggerGesture('startle')
    return
  }
  if (USER_QUESTION.test(text.trim())) {
    emotionBus.triggerGesture('curiousTilt')
    return
  }
  // Very long conversational message → deep focus
  // Guard: must be >400 chars AND not a pasted block (≤3 newlines)
  const newlineCount = (text.match(/\n/g) || []).length
  if (text.length > 400 && newlineCount <= 3) {
    emotionBus.setConversationEmotion('neutral', 3000)
    emotionBus.triggerGesture('deepFocus')
  }
}
