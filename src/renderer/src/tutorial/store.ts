import type { Lang } from './types'

/**
 * What the tutorial remembers between launches.
 *
 * Its own keys rather than the app's `brutus_language`: that one is the
 * assistant's SPOKEN language, read by the voice loop and by text chat, and
 * changing the tutorial to Hindi must not silently change what Brutus speaks
 * back to you. They are two different questions and deserve two answers.
 */
const LANG_KEY = 'brutus_tutorial_lang'
const SEEN_KEY = 'brutus_tutorial_seen'

const read = (key: string, fallback = ''): string => {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* a lost preference is not worth failing a render for */
  }
}

/**
 * The tutorial's language.
 *
 * Defaults from the system locale, so a Hindi machine opens in Hindi without
 * anyone having to find a switch — which is the point of "minimal effort".
 */
export function getLang(): Lang {
  const saved = read(LANG_KEY)
  if (saved === 'en' || saved === 'hi') return saved
  try {
    return navigator.language?.toLowerCase().startsWith('hi') ? 'hi' : 'en'
  } catch {
    return 'en'
  }
}

export function setLang(lang: Lang): void {
  write(LANG_KEY, lang)
}

function seenSet(): Set<string> {
  try {
    const parsed = JSON.parse(read(SEEN_KEY, '[]'))
    return new Set(Array.isArray(parsed) ? parsed.map(String) : [])
  } catch {
    return new Set()
  }
}

/** Has this tour been finished or skipped before? Drives the auto-start. */
export function hasSeen(tourId: string): boolean {
  return seenSet().has(tourId)
}

export function markSeen(tourId: string): void {
  const seen = seenSet()
  seen.add(tourId)
  write(SEEN_KEY, JSON.stringify(Array.from(seen)))
}

/** Offer every tour again. The "replay tutorials" control in Settings. */
export function resetSeen(): void {
  write(SEEN_KEY, '[]')
}
