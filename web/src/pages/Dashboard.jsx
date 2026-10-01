import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { NAV_GROUPS } from '../config/navigation'
import HRDashboard from '../features/dashboard/HRDashboard'
import EmployeeDashboard from '../features/dashboard/EmployeeDashboard'

/**
 * The company view for whoever the server will show it to — it answers
 * GET /dashboard/summary only with employee:read. Asking "is this an employee"
 * instead sent Accounts to the company view, which refused them every time.
 *
 * Since Day 21 a role can be made without "Open the dashboard". Everybody signs
 * in to here, so such a person goes on to the first area their role opens,
 * instead of a dashboard that answers them only with "no permission".
 */
export default function Dashboard() {
  const permissions = useAuthStore((state) => state.permissions)
  const holds = (p) => (Array.isArray(p) ? p : [p]).some((one) => permissions.includes(one))

  if (holds('employee:read')) return <HRDashboard />
  if (holds('dashboard:read')) return <EmployeeDashboard />

  const first = NAV_GROUPS.flatMap((group) => group.items).find((item) => item.to !== '/dashboard' && holds(item.permission))
  if (first) return <Navigate to={first.to} replace />
  return (
    <div className="max-w-md mx-auto mt-16 text-center space-y-2">
      <h1 className="text-lg font-semibold text-gray-900">Nothing to open yet</h1>
      <p className="text-sm text-gray-500">Your role does not open any part of EMS yet. Ask the Super Admin to give it what you need.</p>
    </div>
  )
}
