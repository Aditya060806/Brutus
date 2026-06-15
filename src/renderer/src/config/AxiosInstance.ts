import { useAuthStore } from '@renderer/store/auth-store'
import axios, { AxiosError, AxiosRequestConfig } from 'axios'

interface CustomAxiosRequestConfig extends AxiosRequestConfig {
  _retry?: boolean
}

type QueueItem = {
  resolve: (token: string) => void
  reject: (err: any) => void
}

const normalizeBackendUrl = (value?: string): string => (value || '').trim().replace(/\/+$/, '')

const BACKEND_BASE_URL = normalizeBackendUrl(
  import.meta.env.VITE_BACKEND_KEY || import.meta.env.VITE_BACKEND_URL
)

const MISSING_BACKEND_URL_ERROR =
  'BRUTUS backend URL is missing. Set VITE_BACKEND_KEY in your renderer environment.'

const getBackendBaseUrl = (): string => {
  if (!BACKEND_BASE_URL) {
    throw new Error(MISSING_BACKEND_URL_ERROR)
  }

  return BACKEND_BASE_URL
}

const AxiosInstance = axios.create({
  baseURL: BACKEND_BASE_URL || undefined
})

AxiosInstance.interceptors.request.use((config) => {
  if (!config.baseURL) {
    config.baseURL = getBackendBaseUrl()
  }

  const accessToken = useAuthStore.getState().accessToken

  if (accessToken) {
    config.headers = config.headers || {}
    config.headers.Authorization = `Bearer ${accessToken}`
  }

  return config
})

let isRefreshing = false
let queue: QueueItem[] = []

const processQueue = (error: any, token: string | null = null) => {
  queue.forEach((prom) => {
    if (error || !token) {
      prom.reject(error)
    } else {
      prom.resolve(token)
    }
  })
  queue = []
}

AxiosInstance.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as CustomAxiosRequestConfig

    if (
      error.response?.status === 401 &&
      !originalRequest?._retry &&
      !originalRequest?.url?.includes('/api/v1/auth/refresh-token') &&
      !originalRequest?.url?.includes('/api/v1/auth/login')
    ) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          queue.push({
            resolve: (token: string) => {
              originalRequest.headers = originalRequest.headers || {}
              originalRequest.headers.Authorization = `Bearer ${token}`
              resolve(AxiosInstance(originalRequest))
            },
            reject: (err: any) => reject(err)
          })
        })
      }

      originalRequest._retry = true
      isRefreshing = true

      try {
        const currentRefreshToken = localStorage.getItem('brutus_cloud_token')

        if (!currentRefreshToken) {
          throw new Error('No refresh token found in local storage.')
        }

        const backendBaseUrl = getBackendBaseUrl()
        const res = await axios.post(backendBaseUrl + '/api/v1/auth/refresh-token', {
          refreshToken: currentRefreshToken
        })

        const newAccessToken =
          typeof res.data?.accessToken === 'string' ? res.data.accessToken.trim() : ''

        if (!newAccessToken) {
          throw new Error('Refresh token response missing access token.')
        }

        if (typeof res.data?.refreshToken === 'string' && res.data.refreshToken.trim()) {
          localStorage.setItem('brutus_cloud_token', res.data.refreshToken)
        }

        useAuthStore.getState().setAccessToken(newAccessToken)

        processQueue(null, newAccessToken)

        originalRequest.headers = originalRequest.headers || {}
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`

        return AxiosInstance(originalRequest)
      } catch (err) {
        processQueue(err, null)

        useAuthStore.getState().logout()
        localStorage.removeItem('brutus_cloud_token')
        window.location.hash = '#/login'

        return Promise.reject(err)
      } finally {
        isRefreshing = false
      }
    }

    return Promise.reject(error)
  }
)

export default AxiosInstance
