import { create } from 'zustand'
import {
  PREF_KEYS,
  readBoolPref,
  readPref,
  writeBoolPref,
  writePref
} from '@renderer/services/preferences'
import { applyAccent, applyReducedMotion, DEFAULT_ACCENT_ID } from '@renderer/services/theme'

export type VoiceProfile = 'MALE' | 'FEMALE'
/**
 * Where speech is recognised and synthesised.
 *
 *   cloud   Gemini Live — real-time, best quality, metered, needs a key
 *   server  Brain Node — your own edge device over the LAN
 *   local   this machine — Whisper for listening, the OS voice for speaking
 */
export type VoiceEngine = 'cloud' | 'server' | 'local'

/**
 * Narrow a stored string to a real engine.
 *
 * Anything unrecognised becomes `cloud` — the engine that needs no local model
 * and no LAN device, so an unknown value degrades to the one that is most
 * likely to work rather than to a silently dead voice loop.
 */
export function coerceEngine(value: string | null | undefined): VoiceEngine {
  return value === 'server' ? 'server' : value === 'local' ? 'local' : 'cloud'
}

/** Avatar tints. Ids are stored, not the colours, so the palette can change. */
export const AVATAR_COLORS = [
  { id: 'crimson', className: 'bg-primary-500' },
  { id: 'ember', className: 'bg-amber-500' },
  { id: 'viridian', className: 'bg-sage-500' },
  { id: 'azure', className: 'bg-[#2e90fa]' },
  { id: 'violet', className: 'bg-[#7a5af8]' },
  { id: 'slate', className: 'bg-zinc-600' }
] as const

export function avatarClass(id: string): string {
  return AVATAR_COLORS.find((c) => c.id === id)?.className ?? AVATAR_COLORS[0].className
}

interface ProfileState {
  displayName: string
  avatarColor: string
  accentId: string
  reducedMotion: boolean
  voiceProfile: VoiceProfile
  voiceEngine: VoiceEngine
  /** Has the first-run customise flow been completed or skipped? */
  onboarded: boolean

  setDisplayName: (value: string) => void
  setAvatarColor: (value: string) => void
  setAccent: (value: string) => void
  setReducedMotion: (value: boolean) => void
  setVoiceProfile: (value: VoiceProfile) => void
  setVoiceEngine: (value: VoiceEngine) => void
  setOnboarded: (value: boolean) => void
  /** Re-read everything from storage — used after "Clear app data". */
  reload: () => void
}

function snapshot(): Omit<
  ProfileState,
  | 'setDisplayName'
  | 'setAvatarColor'
  | 'setAccent'
  | 'setReducedMotion'
  | 'setVoiceProfile'
  | 'setVoiceEngine'
  | 'setOnboarded'
  | 'reload'
> {
  return {
    displayName: readPref(PREF_KEYS.userName, 'Operator'),
    avatarColor: readPref(PREF_KEYS.avatarColor, 'crimson'),
    accentId: readPref(PREF_KEYS.accent, DEFAULT_ACCENT_ID),
    reducedMotion: readBoolPref(PREF_KEYS.reducedMotion, false),
    voiceProfile: readPref(PREF_KEYS.voiceProfile, 'MALE') === 'FEMALE' ? 'FEMALE' : 'MALE',
    voiceEngine: coerceEngine(readPref(PREF_KEYS.voiceEngine, 'cloud')),
    onboarded: readBoolPref(PREF_KEYS.onboarded, false)
  }
}

/**
 * The user's local personalisation.
 *
 * ── WRITE-THROUGH, NOT PERSIST ─────────────────────────────────────────────
 * Zustand's `persist` middleware would keep this state in one JSON blob under a
 * single key. That cannot be used here: `displayName`, `voiceProfile` and
 * `voiceEngine` are read as raw `localStorage` strings by the Gemini voice
 * service and by tools all over `src/renderer` (see `services/preferences.ts`).
 * So each setter writes through to the canonical key AND updates the store —
 * the store gives React reactivity, the keys keep the 28 existing readers
 * working. Neither half is redundant.
 */
export const useProfileStore = create<ProfileState>()((set) => ({
  ...snapshot(),

  setDisplayName: (value) => {
    writePref(PREF_KEYS.userName, value)
    set({ displayName: value })
  },
  setAvatarColor: (value) => {
    writePref(PREF_KEYS.avatarColor, value)
    set({ avatarColor: value })
  },
  setAccent: (value) => {
    writePref(PREF_KEYS.accent, value)
    applyAccent(value)
    set({ accentId: value })
  },
  setReducedMotion: (value) => {
    writeBoolPref(PREF_KEYS.reducedMotion, value)
    applyReducedMotion(value)
    set({ reducedMotion: value })
  },
  setVoiceProfile: (value) => {
    writePref(PREF_KEYS.voiceProfile, value)
    set({ voiceProfile: value })
  },
  setVoiceEngine: (value) => {
    writePref(PREF_KEYS.voiceEngine, value)
    set({ voiceEngine: value })
  },
  setOnboarded: (value) => {
    writeBoolPref(PREF_KEYS.onboarded, value)
    set({ onboarded: value })
  },
  reload: () => set(snapshot())
}))

/**
 * Paint the stored theme onto the document.
 *
 * Called once at startup, before React renders, so the app never shows a frame
 * in the default accent before switching to the chosen one.
 */
export function initTheme(): void {
  const { accentId, reducedMotion } = snapshot()
  applyAccent(accentId)
  applyReducedMotion(reducedMotion)
}
