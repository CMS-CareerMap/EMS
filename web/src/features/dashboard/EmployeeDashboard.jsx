import { UserCheck, CalendarDays, Clock, TrendingUp, CheckCircle, XCircle, AlertCircle } from 'lucide-react'
import { useMyDashboardStats } from '../../hooks/useDashboard'
import PunchCard from '../attendance/PunchCard'
import { useAuthStore } from '../../stores/authStore'

const LEAVE_TYPE_LABELS = {
  sick: 'Sick Leave', casual: 'Casual Leave', earned: 'Earned Leave',
  wfh: 'WFH', maternity: 'Maternity Leave', paternity: 'Paternity Leave', comp_off: 'Comp Off',
}

const LEAVE_STATUS_COLORS = {
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

const ATTENDANCE_STATUS = {
  present: { label: 'Present', color: 'bg-green-100 text-green-700' },
  absent: { label: 'Absent', color: 'bg-red-100 text-red-700' },
  wfh: { label: 'WFH', color: 'bg-blue-100 text-blue-700' },
  on_leave: { label: 'On Leave', color: 'bg-amber-100 text-amber-700' },
  weekly_off: { label: 'Weekly Off', color: 'bg-indigo-100 text-indigo-700' },
}

function formatDate(str) {
  if (!str) return ''
  return new Date(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function EmployeeDashboard() {
  const { data, isLoading, error } = useMyDashboardStats()
  // Read before the early returns below — a hook cannot be called conditionally.
  const attendanceMode = useAuthStore((state) => state.profile?.attendance_mode)
  // Accounts, in the client's matrix, has no attendance at all — the card's
  // first request would be refused on every visit.
  const canPunch = useAuthStore((state) => state.can('attendance:punch'))

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  const monthName = new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-red-500 text-sm">
        Failed to load dashboard data.
      </div>
    )
  }

  const { profile, presentDays, absentDays, leaveDays, weeklyOffDays, todayStatus, recentLeaves, leaveBalances } = data

  const totalWorkingDays = presentDays + absentDays + leaveDays
  const attendancePct = totalWorkingDays > 0 ? Math.round(presentDays / totalWorkingDays * 100) : 0

  const todayInfo = ATTENDANCE_STATUS[todayStatus] ?? null

  return (
    <div className="space-y-6">

      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900">My Dashboard</h2>
        <p className="text-sm text-gray-500 mt-0.5">{today}</p>
      </div>

      {/*
        Check In / Check Out, first thing on the page — and only for staff
        whose attendance comes from the app.

        A biometric employee punches at the machine, and a manual one is marked
        by HR. Showing either of them a button they must not use is worse than
        showing nothing: they press it, it works, and now there are two records
        of the same day from two different sources.

        The client asked for the punch to update the dashboard the moment it
        happens; the card invalidates the dashboard query on success, so the
        figures below refresh without a reload.
      */}
      {attendanceMode === 'app' && canPunch && <PunchCard />}

      {/* Profile banner */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-5 text-white flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center shrink-0">
          <span className="text-xl font-bold text-white">
            {(profile?.full_name || 'U').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
          </span>
        </div>
        <div>
          <p className="text-xl font-bold">{profile?.full_name}</p>
          <p className="text-blue-200 text-sm mt-0.5">{profile?.designation} · {profile?.department}</p>
          <p className="text-blue-300 text-xs mt-1">Joined {formatDate(profile?.date_of_joining)}</p>
        </div>
        {todayInfo && (
          <div className="ml-auto shrink-0">
            <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/20 text-white`}>
              <span className="w-2 h-2 rounded-full bg-white" />
              Today: {todayInfo.label}
            </span>
          </div>
        )}
      </div>

      {/* Attendance stats for this month */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
          <div className="bg-green-100 rounded-xl p-3 shrink-0">
            <UserCheck className="w-6 h-6 text-green-600" />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{presentDays}</p>
            <p className="text-sm text-gray-500">Present · {monthName}</p>
            <p className="text-xs text-gray-400 mt-1">{attendancePct}% attendance rate</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
          <div className="bg-amber-100 rounded-xl p-3 shrink-0">
            <CalendarDays className="w-6 h-6 text-amber-600" />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{leaveDays}</p>
            <p className="text-sm text-gray-500">On Leave · {monthName}</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
          <div className="bg-red-100 rounded-xl p-3 shrink-0">
            <Clock className="w-6 h-6 text-red-500" />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{absentDays}</p>
            <p className="text-sm text-gray-500">Absent · {monthName}</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
          <div className="bg-indigo-100 rounded-xl p-3 shrink-0">
            <CalendarDays className="w-6 h-6 text-indigo-600" />
          </div>
          <div>
            <p className="text-2xl font-bold text-gray-900">{weeklyOffDays}</p>
            <p className="text-sm text-gray-500">Weekly Off · {monthName}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Leave balances */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <p className="text-base font-semibold text-gray-900">Leave Balances</p>
            <p className="text-xs text-gray-400 mt-0.5">Available days for this year</p>
          </div>
          {leaveBalances.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-gray-400 text-sm">
              No leave balance data
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {leaveBalances.map((lb) => {
                const pct = lb.total_days > 0 ? Math.round(lb.remaining_days / lb.total_days * 100) : 0
                return (
                  <div key={lb.id} className="px-5 py-3.5 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{LEAVE_TYPE_LABELS[lb.leave_type] ?? lb.leave_type}</p>
                      <div className="mt-1.5 w-full bg-gray-100 rounded-full h-1.5">
                        <div className="bg-blue-600 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-gray-900">{lb.remaining_days}</p>
                      <p className="text-xs text-gray-400">of {lb.total_days}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Recent leave requests */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <p className="text-base font-semibold text-gray-900">My Leave Requests</p>
            <p className="text-xs text-gray-400 mt-0.5">Recent requests</p>
          </div>
          {recentLeaves.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-gray-400">
              <CheckCircle className="w-7 h-7 mb-2 text-gray-300" />
              <p className="text-sm">No leave requests yet</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {recentLeaves.map((req) => (
                <div key={req.id} className="px-5 py-3.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-gray-900">
                        {LEAVE_TYPE_LABELS[req.leave_type] ?? req.leave_type}
                      </p>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${LEAVE_STATUS_COLORS[req.status] ?? 'bg-gray-100 text-gray-700'}`}>
                        {req.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {formatDate(req.from_date)}{req.from_date !== req.to_date ? ` – ${formatDate(req.to_date)}` : ''} · {req.days}d
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
