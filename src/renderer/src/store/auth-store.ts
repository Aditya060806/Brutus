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

interface AuthState {
  accessToken: string | null
  user: AuthUser | null
  isAuthInitialized: boolean

  setAccessToken: (token: string | null) => void
  setUser: (user: AuthUser | null) => void
  setIsAuthInitialized: (value: boolean) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  immer((set) => ({
    accessToken: null,
    user: null,
    isAuthInitialized: false,

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
      set((state) => {
        state.accessToken = null
        state.user = null
        state.isAuthInitialized = true
      })
    }
  }))
)
