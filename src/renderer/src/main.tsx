import './assets/main.css'

import React, { JSX, StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'

import LockScreen from './UI/LockScreen'
import LoginPage from './auth/Login'
import { useAuthStore } from './store/auth-store'
import AxiosInstance from './config/AxiosInstance'
import AuthInitializer from './auth/AuthToken'
import IndexRoot from './IndexRoot'
import Welcome from './views/Welcome'
import { initTheme, useProfileStore } from './store/profile-store'

// Paint the saved accent and motion preference before the first render, so the
// app never flashes the default accent on the way to the chosen one.
initTheme()

const getElectronAPI = () => (window as any).electron?.ipcRenderer

class SystemErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; errorMsg: string }
> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false, errorMsg: '' }
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, errorMsg: error.message }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-canvas flex flex-col items-center justify-center p-6 text-center">
          <h1 className="text-[17px] font-medium text-content mb-1.5">Brutus stopped</h1>
          <p className="text-[13px] text-content-muted mb-5">
            Something crashed on startup. Restarting usually clears it.
          </p>
          <pre className="max-w-xl overflow-x-auto rounded-lg border border-line bg-surface px-3.5 py-2.5 text-left font-mono text-[11px] leading-relaxed text-content-secondary">
            {this.state.errorMsg}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

let isSessionUnlocked = false
const OAUTH_PROTOCOL_PREFIX = 'brutus://'

/**
 * Shown while the session is being verified.
 *
 * Deliberately almost nothing. This used to read "VERIFYING SECURITY
 * CLEARANCE..." in wide-tracked red monospace — a full-screen red flash on
 * every single launch, for a check that usually resolves in well under a
 * second. A quiet line that most people will never consciously see is the
 * correct amount of interface for this.
 */
const CheckingSecurityUI = () => (
  <div className="h-screen w-screen bg-canvas flex items-center justify-center">
    <span className="text-[12px] text-content-faint">Checking your session…</span>
  </div>
)

const getFirstOAuthParam = (params: URLSearchParams, aliases: string[]): string | null => {
  for (const alias of aliases) {
    const value = params.get(alias)?.trim()
    if (value) return value
  }
  return null
}

const parseOAuthCallbackTokens = (rawUrl: string) => {
  const normalizedUrl = rawUrl.startsWith(OAUTH_PROTOCOL_PREFIX)
    ? rawUrl.replace(/^brutus:\/\//i, 'https://oauth.local/')
    : rawUrl

  const parsedUrl = new URL(normalizedUrl)
  let params = parsedUrl.searchParams

  // Some providers return OAuth tokens in the URL fragment instead of query params.
  if (!params.toString() && parsedUrl.hash.includes('=')) {
    const hashRaw = parsedUrl.hash.startsWith('#') ? parsedUrl.hash.slice(1) : parsedUrl.hash
    const hashQuery = hashRaw.startsWith('?') ? hashRaw.slice(1) : hashRaw
    params = new URLSearchParams(hashQuery)
  }

  return {
    accessToken: getFirstOAuthParam(params, ['accessToken', 'access_token', 'token']),
    refreshToken: getFirstOAuthParam(params, ['refreshToken', 'refresh_token'])
  }
}

const ProtectedRoute = ({ children }: { children: JSX.Element }) => {
  const [status, setStatus] = useState<'checking' | 'authorized'>('checking')
  const navigate = useNavigate()
  const location = useLocation()

  const accessToken = useAuthStore((state) => state.accessToken)
  const isAuthInitialized = useAuthStore((state) => state.isAuthInitialized)
  const logout = useAuthStore((state) => state.logout)
  // Subscribed rather than read once: finishing the welcome flow flips this,
  // and the guard has to re-run so it stops redirecting back to /welcome.
  const onboarded = useProfileStore((state) => state.onboarded)
  // Set when the user chose to run without a cloud account.
  const localOnly = useAuthStore((state) => state.localOnly)

  useEffect(() => {
    if (!isAuthInitialized) return

    /** Lock, then first-run, then in. Shared by the cloud and local paths. */
    const proceed = (): void => {
      if (!isSessionUnlocked && location.pathname !== '/lock') {
        navigate('/lock', { replace: true })
        return
      }
      if (isSessionUnlocked && !onboarded && location.pathname !== '/welcome') {
        navigate('/welcome', { replace: true })
        return
      }
      setStatus('authorized')
    }

    const verifyAccess = async () => {
      setStatus('checking')

      /**
       * Local-only: no cloud call at all.
       *
       * Nothing Brutus does needs the account, so a user who chose to skip
       * sign-in goes straight to the lock screen. This is checked before the
       * token so that choosing local-only cannot be undone by a stale token.
       */
      if (localOnly) {
        proceed()
        return
      }

      try {
        if (!accessToken && !localStorage.getItem('brutus_cloud_token')) {
          navigate('/login', { replace: true })
          return
        }

        const userRes = await AxiosInstance.get('/api/v1/auth/me')
        if (userRes.status !== 200) throw new Error('Cloud Auth Failed')

        // Keep the profile. This response was previously fetched on every
        // launch and discarded — only its status code was read — so the app
        // knew who you were and had no way to show it. The Account panel and
        // the top-bar avatar both read it from here.
        const payload = userRes.data?.user ?? userRes.data
        if (payload && typeof payload === 'object') {
          useAuthStore.getState().setUser({
            id: payload.id ?? payload._id,
            name: payload.name ?? payload.displayName,
            email: payload.email,
            picture: payload.picture ?? payload.avatar
          })
        }

        // Lock, then first-run, then in. See `proceed` above.
        proceed()
      } catch (error) {
        /**
         * A rejected token and an unreachable backend are not the same thing.
         *
         * This used to call `logout()` on any failure, which meant losing your
         * network — or the backend being down, or the machine being behind a
         * firewall — signed you out and stranded you on the login screen with a
         * token that was perfectly valid. On a packaged build that is a brick,
         * not a degraded state.
         *
         * So only an explicit 401/403 clears the session. Anything else keeps
         * the token and lets the user in, because every feature that matters is
         * local anyway.
         */
        const status = (error as { response?: { status?: number } })?.response?.status
        const rejected = status === 401 || status === 403

        if (rejected) {
          logout()
          navigate('/login', { replace: true })
          return
        }

        console.warn('[auth] cloud check failed, continuing offline:', error)
        proceed()
      }
    }

    verifyAccess()
  }, [isAuthInitialized, navigate, location.pathname, accessToken, logout, onboarded, localOnly])

  if (!isAuthInitialized || status === 'checking') {
    return <CheckingSecurityUI />
  }

  return children
}

const PublicRoute = ({ children }: { children: JSX.Element }) => {
  const isAuthInitialized = useAuthStore((state) => state.isAuthInitialized)
  const accessToken =
    useAuthStore((state) => state.accessToken) || localStorage.getItem('brutus_cloud_token')

  if (!isAuthInitialized) {
    return <CheckingSecurityUI />
  }

  return accessToken ? <Navigate to="/" replace /> : children
}

const AppRouter = () => {
  const navigate = useNavigate()

  useEffect(() => {
    const processOAuthCallback = (rawUrl: string) => {
      try {
        const { refreshToken, accessToken } = parseOAuthCallbackTokens(rawUrl)

        if (!refreshToken || !accessToken) {
          console.warn('[OAuth] Callback missing required tokens.')
          return
        }

        localStorage.setItem('brutus_cloud_token', refreshToken)
        useAuthStore.getState().setAccessToken(accessToken)
        navigate('/', { replace: true })
      } catch (error) {
        console.error('Failed to parse OAuth URL', error)
      }
    }

    const electronAPI = getElectronAPI()
    if (electronAPI) {
      const disposeOauth = electronAPI.on('oauth-callback', (_event: unknown, url: string) => {
        if (typeof url === 'string' && url.trim()) {
          processOAuthCallback(url)
        }
      })

      electronAPI
        .invoke('oauth-consume-pending-callback')
        .then((pendingUrl: unknown) => {
          if (typeof pendingUrl === 'string' && pendingUrl.trim()) {
            processOAuthCallback(pendingUrl)
          }
        })
        .catch((error: unknown) => {
          console.error('Failed to consume pending OAuth callback', error)
        })

      return () => {
        if (typeof disposeOauth === 'function') {
          disposeOauth()
          return
        }
        electronAPI.removeAllListeners('oauth-callback')
      }
    }

    return undefined
  }, [navigate])

  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />

      <Route
        path="/lock"
        element={
          <ProtectedRoute>
            <LockScreen
              onUnlock={() => {
                isSessionUnlocked = true
                navigate('/')
              }}
            />
          </ProtectedRoute>
        }
      />

      <Route
        path="/welcome"
        element={
          <ProtectedRoute>
            <Welcome />
          </ProtectedRoute>
        }
      />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <IndexRoot />
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

// Safety net: ensure window.electron.ipcRenderer exists even if preload hasn't injected it yet.
// Prevents "Cannot read properties of undefined (reading 'ipcRenderer')" crashes in all components.
if (!window.electron) {
  const noop = () => {}
  const noopPromise = (..._args: any[]) => Promise.resolve(undefined)
  ;(window as any).electron = {
    ipcRenderer: {
      invoke: noopPromise,
      send: noop,
      on: (_channel: string, _fn: (...args: any[]) => void) => noop,
      removeAllListeners: noop
    }
  }
  console.warn('⚠️ window.electron was not injected by preload — using safe no-op stub.')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SystemErrorBoundary>
      <HashRouter>
        <AuthInitializer />
        <AppRouter />
      </HashRouter>
    </SystemErrorBoundary>
  </StrictMode>
)
