import { useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { UserRound } from 'lucide-react'
import { usePersonMonth } from '../hooks/useAttendance'
import { useAuthStore } from '../stores/authStore'
import PageHeader from '../components/ui/PageHeader'
import { Chip } from '../components/ui/bits'
import { btn } from '../components/ui/styles'
import { calendarDayIn, formatDay } from '../lib/dates'
import PersonMonth from '../features/attendance/PersonMonth'

/**
 * Somebody's attendance (client, 15 Oct 2026): opened by their name on
 * Attendance, as their profile opens from Employees — their calendar and
 * their days, month by month, and the month so far counted to today. For
 * whoever's attendance reach takes them in: HR and the Super Admin, anybody;
 * a manager, their team. The month is in the address (?month=YYYY-MM), so a
 * link opens on the month it was clicked from.
 */
export default function PersonAttendance() {
  const { id } = useParams()
  // Back to where the name was clicked: that day's roster, that month's hours, Suspicious.
  const location = useLocation()
  const [backTo] = useState(() => (typeof location.state?.back === 'string' && location.state.back.startsWith('/attendance') ? location.state.back : '/attendance'))
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const canOpenProfile = useAuthStore((state) => state.can('employee:read'))
  const [params, setParams] = useSearchParams()
  const today = calendarDayIn(timezone)
  const asked = params.get('month')
  const monthKey = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked ?? '') ? asked : today.slice(0, 7)
  const [year, month] = monthKey.split('-').map(Number)
  const query = usePersonMonth(id, year, month)
  const person = query.data?.person ?? null

  return (
    <>
      <PageHeader
        back={{ to: backTo, label: 'Attendance' }}
        title={person ? person.full_name : 'Attendance'}
        subtitle={person && (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{[person.employee_code, person.department, person.designation].filter(Boolean).join(' · ')}</span>
            {person.left
              ? <Chip tone="bad">Left{person.last_working_date ? ` · last day ${formatDay(person.last_working_date)}` : ''}</Chip>
              // Leaving, or gone and their record not yet closed: the day they stop being counted.
              : person.last_working_date && <Chip tone="warn">Last working day {formatDay(person.last_working_date)}</Chip>}
          </span>
        )}
        actions={person && canOpenProfile && (
          <Link to={`/employees/${person.id}`} className={btn.secondary}>
            <UserRound className="w-4 h-4" aria-hidden="true" />Profile
          </Link>
        )}
      />
      <PersonMonth query={query} monthKey={monthKey} onMonth={(next) => setParams({ month: next }, { replace: true })} today={today} />
    </>
  )
}
