/**
 * Local preference storage — the canonical key names.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * These `localStorage` keys are not private to the settings screen. They are
 * read directly, as string literals, by **28 other call sites**: the Gemini
 * voice service (`Brutus-voice-ai.ts` reads the voice profile, engine, operator
 * name and API key), every tool in `tools/`, and several widgets. There is no
 * indirection anywhere — each one does `localStorage.getItem('brutus_…')`.
 *
 * That makes the key names a de-facto public contract. Moving the settings UI
 * onto a store with its own persisted JSON blob would have left every one of
 * those readers looking at a key nobody writes any more: the voice engine would
 * silently revert to cloud, the tools would report a missing API key, and
 * nothing would throw. So the settings UI writes THROUGH to these exact keys,
 * and this module is the one place their names are spelled.
 *
 * If a key name ever has to change, grep for it across `src/renderer` first —
 * the readers will not fail loudly.
 */

export const PREF_KEYS = {
  // ── Shared with the voice service, tools and widgets. Do not rename. ────
  userName: 'brutus_user_name',
  voiceProfile: 'brutus_voice_profile',
  voiceEngine: 'brutus_voice_engine',
  geminiKey: 'brutus_custom_api_key',
  groqKey: 'brutus_groq_api_key',
  hfKey: 'brutus_hf_api_key',
  tavilyKey: 'brutus_tailvy_api_key',

  // ── Owned by the settings UI alone. Safe to change. ─────────────────────
  accent: 'brutus_accent',
  avatarColor: 'brutus_avatar_color',
  reducedMotion: 'brutus_reduced_motion',
  onboarded: 'brutus_onboarded',
  lastSettingsPanel: 'brutus_last_settings_panel'
} as const

export type PrefKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS]

/**
 * `localStorage` access can throw — a full quota, or a security policy that
 * denies storage. None of these preferences is important enough to take a view
 * down with it, so every accessor degrades to the fallback instead.
 */
export function readPref(key: PrefKey, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function writePref(key: PrefKey, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* preference is lost for this session; nothing here is worth failing for */
  }
}

export function readBoolPref(key: PrefKey, fallback = false): boolean {
  const raw = readPref(key, fallback ? 'true' : 'false')
  return raw === 'true'
}

export function writeBoolPref(key: PrefKey, value: boolean): void {
  writePref(key, value ? 'true' : 'false')
}

/** Every key this app owns — used by "Clear app data" in the Account panel. */
export function clearAllPrefs(): void {
  try {
    Object.values(PREF_KEYS).forEach((key) => localStorage.removeItem(key))
  } catch {
    /* nothing actionable */
  }
}
