import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

/**
 * The cloud identity, as returned by `GET /api/v1/auth/me`.
 *
 * Every field is optional because the backend's exact response shape is not
 * pinned down here and a missing display name must not blank the account card.
 * Consumers fall back to the local profile.
 */
export interface AuthUser {
  id?: string
  name?: string
  email?: string
  picture?: string
}

/** Persisted so the choice survives a restart. */
const LOCAL_ONLY_KEY = 'brutus_local_only'

const readLocalOnly = (): boolean => {
  try {
    return localStorage.getItem(LOCAL_ONLY_KEY) === '1'
  } catch {
    return false
  }
}

interface AuthState {
  accessToken: string | null
  user: AuthUser | null
  isAuthInitialized: boolean
  /**
   * Using Brutus without a cloud account.
   *
   * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
   * Nothing Brutus actually does requires the cloud account. API keys, Studio
   * workspaces, records, notes and every tool are local; sign-in only supplies a
   * display name and avatar. Yet the route guard demanded a successful
   * `/auth/me` on every launch and called `logout()` on any failure — so a user
   * who was offline, behind a firewall, or simply running after that backend
   * went away could never get past the login screen. On a shipped build that is
   * not a degraded experience, it is a brick.
   *
   * When true, the guard skips cloud verification entirely.
   */
  localOnly: boolean

  setAccessToken: (token: string | null) => void
  setUser: (user: AuthUser | null) => void
  setIsAuthInitialized: (value: boolean) => void
  /** Enter or leave local-only mode. */
  setLocalOnly: (value: boolean) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  immer((set) => ({
    accessToken: null,
    user: null,
    isAuthInitialized: false,
    localOnly: readLocalOnly(),

    setAccessToken: (token) =>
      set((state) => {
        state.accessToken = token
      }),

    /**
     * Capture the profile from `/auth/me`.
     *
     * This response was previously fetched on every launch and discarded —
     * `ProtectedRoute` read its status code and nothing else — so the app knew
     * who you were and had no way to show it.
     */
    setUser: (user) =>
      set((state) => {
        state.user = user
      }),

    setIsAuthInitialized: (value) =>
      set((state) => {
        state.isAuthInitialized = value
      }),

    setLocalOnly: (value) => {
      try {
        if (value) localStorage.setItem(LOCAL_ONLY_KEY, '1')
        else localStorage.removeItem(LOCAL_ONLY_KEY)
      } catch {
        /* In-memory state below still applies for this session. */
      }
      set((state) => {
        state.localOnly = value
        // Local-only is a decided state, not a pending one, so the guard must
        // not sit on the "checking security" screen waiting for a cloud call
        // that is never going to happen.
        state.isAuthInitialized = true
      })
    },

    logout: () => {
      // Clearing the stored refresh token belongs here rather than at each call
      // site. It was previously done in some paths and not others, so signing
      // out from the wrong place left a token behind that silently signed the
      // user back in on the next launch.
      try {
        localStorage.removeItem('brutus_cloud_token')
      } catch {
        /* storage unavailable — the in-memory reset below still applies */
      }
      try {
        localStorage.removeItem(LOCAL_ONLY_KEY)
      } catch {
        /* as above */
      }
      set((state) => {
        state.accessToken = null
        state.user = null
        state.localOnly = false
        state.isAuthInitialized = true
      })
    }
  }))
)
