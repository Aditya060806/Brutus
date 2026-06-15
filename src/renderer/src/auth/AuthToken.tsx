import { useEffect } from 'react'
import { useAuthStore } from '../store/auth-store'
import AxiosInstance from '../config/AxiosInstance'

export default function AuthInitializer() {
  const setAccessToken = useAuthStore((s) => s.setAccessToken)
  const setIsAuthInitialized = useAuthStore((s) => s.setIsAuthInitialized)

  useEffect(() => {
    const init = async () => {
      try {
        const storedRefreshToken = localStorage.getItem('brutus_cloud_token')

        if (!storedRefreshToken) {
          setAccessToken(null)
          return
        }

        const res = await AxiosInstance.post('/api/v1/auth/refresh-token', {
          refreshToken: storedRefreshToken
        })

        const accessToken =
          typeof res.data?.accessToken === 'string' ? res.data.accessToken.trim() : ''

        if (!accessToken) {
          throw new Error('Refresh token response missing access token.')
        }

        setAccessToken(accessToken)

        if (typeof res.data?.refreshToken === 'string' && res.data.refreshToken.trim()) {
          localStorage.setItem('brutus_cloud_token', res.data.refreshToken)
        }
      } catch (err) {
        setAccessToken(null)
        localStorage.removeItem('brutus_cloud_token')
      } finally {
        setIsAuthInitialized(true)
      }
    }

    init()
  }, [setAccessToken, setIsAuthInitialized])

  return null
}
