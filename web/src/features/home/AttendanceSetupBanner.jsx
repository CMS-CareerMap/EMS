import { Link } from 'react-router-dom'
import { AlertCircle } from 'lucide-react'
import { useAttendanceSecurity } from '../../hooks/useSettings'
import { PUNCH_METHODS } from '../../lib/attendance'

/**
 * A setup not finished, said where the Super Admin looks first (client, 14 Oct
 * 2026): the punch method checks the office location and none is saved, so
 * nobody can check in at the office. Settings cannot be saved into that state,
 * but a new company — or one whose method came over from before — starts in
 * it. Nothing at all while it is fine, loading, or could not be read (the
 * Settings page says that itself).
 */
export default function AttendanceSetupBanner() {
  const security = useAttendanceSecurity()
  const data = security.data
  if (!data || data.office_set || PUNCH_METHODS[data.method]?.needs.fence !== true) return null
  return (
    <div role="alert" className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
      <p>
        <b>Attendance setup is not finished:</b> check-ins are checked against the office location, and none is saved — so nobody can
        check in at the office.{' '}
        <Link to="/settings?tab=attendance-security" className="font-semibold underline">Set it up</Link>
      </p>
    </div>
  )
}
