import { useNavigate } from 'react-router-dom'
import { logout } from '../api/auth'
import { useAuthStore } from '../stores/authStore'

/**
 * Signing out, from the header's menu or the phone's.
 *
 * Clear locally whichever way the request goes. A network error is not a
 * reason to leave someone staring at a signed-in screen — and the server call
 * is what revokes the refresh token, so it is attempted first.
 */
export function useSignOut() {
  const navigate = useNavigate()
  const clearAuth = useAuthStore((state) => state.clearAuth)
  return async () => {
    try {
      await logout()
    } finally {
      clearAuth()
      navigate('/signin')
    }
  }
}
