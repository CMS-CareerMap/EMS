import { useAuthStore } from '../stores/authStore'
import HRDashboard from '../features/dashboard/HRDashboard'
import EmployeeDashboard from '../features/dashboard/EmployeeDashboard'

/**
 * The company view for whoever the server will show it to — it answers
 * GET /dashboard/summary only with employee:read. Asking "is this an employee"
 * instead sent Accounts to the company view, which refused them every time.
 */
export default function Dashboard() {
  const canSeeCompany = useAuthStore((state) => state.can('employee:read'))
  return canSeeCompany ? <HRDashboard /> : <EmployeeDashboard />
}
