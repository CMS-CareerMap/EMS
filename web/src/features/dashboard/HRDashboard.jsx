import { createElement } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts'
import {
  Users, UserCheck, UserMinus, Clock, TrendingUp,
  CheckCircle, XCircle, AlertCircle, CalendarDays, ChevronRight, Coffee,
} from 'lucide-react'
import { useDashboardStats, useApproveLeaveDashboard } from '../../hooks/useDashboard'
import { useAuthStore } from '../../stores/authStore'
import DataState from '../../components/DataState'
import { typeColourOf } from '../../lib/leaveTypes'
import { ROLE_LABELS } from '../../lib/roles'
import { calendarDayIn, formatCalendarDay, formatDayOf } from '../../lib/dates'
import { LifecycleCard, WaitingResignations } from './LifecycleCards'


function initials(name) {
  return (name || '')
    .split(' ')
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase()
}

function formatDate(str) {
  return str ? formatDayOf(str) : ''
}

function AttendanceTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs">
      <p className="font-semibold text-gray-900 mb-2">{label}</p>
      <p className="text-green-600">Present: <span className="font-medium">{payload[0]?.value}</span></p>
      <p className="text-red-500">Absent: <span className="font-medium">{payload[1]?.value}</span></p>
    </div>
  )
}

function DeptLegend({ data }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <ul className="space-y-2 mt-2">
      {data.map((d) => (
        <li key={d.name} className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} />
            <span className="text-gray-600">{d.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900">{d.value}</span>
            <span className="text-gray-400 w-8 text-right">{total ? Math.round(d.value / total * 100) : 0}%</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function StatCard({ label, value, change, icon, iconBg, iconColor }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
      <div className={`${iconBg} rounded-xl p-3 shrink-0`}>
        {createElement(icon, { className: `w-6 h-6 ${iconColor}` })}
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        <p className="text-sm text-gray-500 leading-none mt-0.5">{label}</p>
        {change && (
          <div className="flex items-center gap-1 mt-1.5">
            <TrendingUp className="w-3 h-3 text-green-500" />
            <span className="text-xs text-gray-400 truncate max-w-37.5" title={change}>{change}</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default function HRDashboard() {
  const { role, roleName } = useAuthStore()
  const stats = useDashboardStats()
  const approveLeave = useApproveLeaveDashboard()
  const myEmployeeId = useAuthStore((state) => state.profile?.id ?? null)
  const runsLifecycle = useAuthStore((state) => state.can('employee:lifecycle:manage'))

  const roleTitles = {
    super_admin: 'Admin Dashboard',
    admin: 'Admin Dashboard',
    hr: 'HR Dashboard',
    manager: 'Manager Dashboard',
    rm: 'Manager Dashboard',
    accounts: 'Finance Dashboard',
  }

  // A built-in role still under its own name keeps its usual title; one the
  // Super Admin made, or renamed (Day 21), is called by the name it has now.
  const renamed = roleName && roleName !== ROLE_LABELS[role]
  const dashboardTitle = (!renamed && roleTitles[role]) || (roleName ? `${roleName} Dashboard` : 'Dashboard')

  const timezone = useAuthStore((state) => state.organization?.timezone)
  const today = formatCalendarDay(calendarDayIn(timezone))

  return (
    <div className="space-y-6">

      {/* Page header */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900">{dashboardTitle}</h2>
        <p className="text-sm text-gray-500 mt-0.5">{today} · Overview of your workforce</p>
      </div>

      {/* Resignations whose writers report to the caller — accepted here, as leave is decided. */}
      <WaitingResignations />

      {/* Every card below is drawn from this one answer: one error for all of them, never cards of zeros. */}
      <DataState query={stats}>
        {(data) => <Overview data={data} approveLeave={approveLeave} myEmployeeId={myEmployeeId} />}
      </DataState>

      {/* Joining to exit (client §43): who needs a step from HR. Its own request, so it stands if the overview fails. */}
      {runsLifecycle && <LifecycleCard />}
    </div>
  )
}

function Overview({ data, approveLeave, myEmployeeId }) {
  const {
    totalEmployees, presentToday, onLeaveToday, weeklyOffToday, deptWeeklyOff,
    pendingLeaveCount, pendingForMe, pendingLeaves, deptData, weekData, recentJoiners,
  } = data

  const attendancePct = totalEmployees > 0 ? Math.round(presentToday / totalEmployees * 100) : 0

  // A list of { name, value } per department (empty on a working day).
  const weeklyOffChangeText = (deptWeeklyOff ?? [])
    .map((d) => `${d.name}: ${d.value}`)
    .join(', ') || 'No employees'

  return (
    <>
      {/* ── Stat cards ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-5">
        <StatCard
          label="Total Employees"
          value={totalEmployees}
          change={`${recentJoiners.length} joined recently`}
          icon={Users}
          iconBg="bg-blue-100"
          iconColor="text-blue-600"
        />
        <StatCard
          label="Present Today"
          value={presentToday}
          change={`${attendancePct}% attendance`}
          icon={UserCheck}
          iconBg="bg-green-100"
          iconColor="text-green-600"
        />
        <StatCard
          label="On Leave Today"
          value={onLeaveToday}
          icon={UserMinus}
          iconBg="bg-amber-100"
          iconColor="text-amber-600"
        />
        <StatCard
          label="Weekly Off Today"
          value={weeklyOffToday}
          change={weeklyOffChangeText}
          icon={Coffee}
          iconBg="bg-indigo-100"
          iconColor="text-indigo-600"
        />
        <StatCard
          label="Pending Leave"
          value={pendingLeaveCount}
          // Who decides is the company tree: of the waiting requests, the ones that are the caller's.
          change={`${pendingForMe} waiting for you`}
          icon={Clock}
          iconBg="bg-red-100"
          iconColor="text-red-600"
        />
      </div>

      {/* ── Charts row ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Attendance bar chart — 2/3 width */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-5">
            <div>
              <p className="text-base font-semibold text-gray-900">Weekly Attendance</p>
              <p className="text-xs text-gray-400 mt-0.5">Present vs Absent — this week</p>
            </div>
            <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full">
              {totalEmployees} total
            </span>
          </div>
          {weekData.length === 0 ? (
            <div className="flex items-center justify-center h-55 text-gray-400 text-sm">
              No attendance data for this week yet
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={weekData} barSize={18} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} width={28} />
                  <Tooltip content={<AttendanceTooltip />} cursor={{ fill: '#F8FAFC' }} />
                  <Bar dataKey="present" name="Present" fill="#2563EB" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="absent" name="Absent" fill="#FEE2E2" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-5 mt-3">
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-blue-600" />
                  <span className="text-xs text-gray-500">Present</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-red-100" />
                  <span className="text-xs text-gray-500">Absent</span>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Department donut — 1/3 width */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="mb-4">
            <p className="text-base font-semibold text-gray-900">By Department</p>
            <p className="text-xs text-gray-400 mt-0.5">Headcount distribution</p>
          </div>
          {deptData.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">No data</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie
                    data={deptData}
                    cx="50%"
                    cy="50%"
                    innerRadius={46}
                    outerRadius={72}
                    paddingAngle={3}
                    dataKey="value"
                    strokeWidth={0}
                  >
                    {deptData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(val, name) => [`${val} employees`, name]}
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E2E8F0' }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <DeptLegend data={deptData} />
            </>
          )}
        </div>
      </div>

      {/* ── Bottom row ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Pending approvals — 2/3 */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div>
              <p className="text-base font-semibold text-gray-900">Pending Leave</p>
              <p className="text-xs text-gray-400 mt-0.5">
                {pendingForMe > 0
                  ? `${pendingForMe} waiting for you, first`
                  : pendingLeaveCount > 0
                    ? `${pendingLeaveCount} waiting, none of them yours to decide`
                    : 'Nothing is waiting'}
              </p>
            </div>
          </div>

          {pendingLeaves.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <CheckCircle className="w-8 h-8 mb-2 text-green-400" />
              <p className="text-sm">All caught up — no pending approvals</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {pendingLeaves.map((req) => {
                const name = req.full_name
                const dept = req.department ?? ''
                const typeLabel = req.leave_type_name
                const typeColor = typeColourOf(req.leave_type)
                const from = formatDate(req.from_date)
                const to = req.to_date !== req.from_date ? ` – ${formatDate(req.to_date)}` : ''

                return (
                  <div key={req.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50 transition-colors">
                    <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                      <span className="text-blue-700 text-xs font-semibold">{initials(name)}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-gray-900">{name}</p>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${typeColor}`}>
                          {typeLabel}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-gray-400">{dept}</span>
                        <span className="text-gray-200">·</span>
                        <CalendarDays className="w-3 h-3 text-gray-400" />
                        <span className="text-xs text-gray-500">{from}{to}</span>
                        <span className="text-xs text-gray-400">({req.days}d)</span>
                      </div>
                    </div>
                    {/* Who decides is the company tree (Day 22): the server says, per request,
                        whether it is the caller's. HR sees every request and decides none. */}
                    {!req.can_decide ? (
                      <span className="text-xs text-gray-400 italic shrink-0">
                        {req.employee_id === myEmployeeId ? 'Your own — the person above you decides' : 'Not yours to decide'}
                      </span>
                    ) : (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => approveLeave.mutate({ id: req.id, status: 'approved' })}
                        disabled={approveLeave.isPending}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-green-50 hover:bg-green-100 text-green-700 text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        <CheckCircle className="w-3.5 h-3.5" />
                        Approve
                      </button>
                      <button
                        onClick={() => approveLeave.mutate({ id: req.id, status: 'rejected' })}
                        disabled={approveLeave.isPending}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Reject
                      </button>
                    </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Recent joiners — 1/3 */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div>
              <p className="text-base font-semibold text-gray-900">Recent Joiners</p>
              <p className="text-xs text-gray-400 mt-0.5">Last 60 days</p>
            </div>
          </div>

          {recentJoiners.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-gray-400 text-sm">
              No recent joiners
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {recentJoiners.map((emp) => (
                <div key={emp.id} className="flex items-center gap-3 px-5 py-4 hover:bg-gray-50 transition-colors">
                  <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                    <span className="text-slate-600 text-xs font-semibold">{initials(emp.full_name)}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{emp.full_name}</p>
                    <p className="text-xs text-gray-500 truncate">{emp.designation}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{formatDate(emp.date_of_joining)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {recentJoiners.length > 0 && (
            <div className="mx-4 mb-4 mt-2 p-3 rounded-lg bg-blue-50 border border-blue-100">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-blue-600 shrink-0" />
                <p className="text-xs text-blue-700 font-medium">
                  {recentJoiners.length} new joiner{recentJoiners.length !== 1 ? 's' : ''} recently
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
