import { Navigate, Outlet } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

/**
 * Hides a route from someone who lacks the permission it needs.
 *
 * Gated on a permission rather than a list of role names. The old version took
 * `allowedRoles={['super_admin', 'accounts']}`, which meant every change to who
 * may see payroll was a change to this file AND to the sidebar AND to whatever
 * else had its own copy of the list.
 *
 * This is presentation only. It stops a wrong turn from showing an empty,
 * broken page; it is not a security control, because anything it hides is still
 * one fetch away. The server checks every request independently.
 */
export default function ProtectedRoute({ permission }) {
  const { canAny, loading } = useAuthStore()

  // Layout already holds the spinner while the session is being established.
  // Deciding here before the permissions have arrived would bounce a legitimate
  // user to the dashboard on every page refresh.
  if (loading) return null

  if (!canAny(permission)) {
    return <Navigate to="/dashboard" replace />
  }

  return <Outlet />
}
