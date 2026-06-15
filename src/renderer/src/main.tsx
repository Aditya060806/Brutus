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
        <div className="h-screen w-screen bg-[#050505] flex flex-col items-center justify-center text-red-500 font-mono p-6 text-center">
          <h1 className="text-2xl font-bold mb-4">CRITICAL SYSTEM FAILURE</h1>
          <div className="p-4 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300 max-w-2xl wrap-break-word">
            {this.state.errorMsg}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

let isSessionUnlocked = false
const OAUTH_PROTOCOL_PREFIX = 'brutus://'

const CheckingSecurityUI = () => (
  <div className="h-screen w-screen bg-[#050505] flex items-center justify-center text-[#ef4444] font-mono text-sm tracking-widest uppercase">
    Verifying Security Clearance...
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

  useEffect(() => {
    if (!isAuthInitialized) return

    const verifyAccess = async () => {
      setStatus('checking')

      try {
        if (!accessToken && !localStorage.getItem('brutus_cloud_token')) {
          navigate('/login', { replace: true })
          return
        }

        const userRes = await AxiosInstance.get('/api/v1/auth/me')
        if (userRes.status !== 200) throw new Error('Cloud Auth Failed')

        if (!isSessionUnlocked && location.pathname !== '/lock') {
          navigate('/lock', { replace: true })
          return
        }

        setStatus('authorized')
      } catch (error) {
        logout()
        navigate('/login', { replace: true })
      }
    }

    verifyAccess()
  }, [isAuthInitialized, navigate, location.pathname, accessToken, logout])

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
