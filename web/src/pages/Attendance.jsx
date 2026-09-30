import { createElement, useState, useMemo } from 'react'
import {
  UserCheck, UserX, Clock, CalendarDays, CircleDashed, Search,
  ChevronLeft, ChevronRight, Download, Edit2, Calendar, Loader2,
} from 'lucide-react'
import MarkAttendanceModal from '../features/attendance/MarkAttendanceModal'
import { useDayRoster, useMonthAttendance, useMarkAttendance } from '../hooks/useAttendance'
import { useAuthStore } from '../stores/authStore'
import { saveFromApi } from '../api/http'
import { useDownload } from '../hooks/useDownload'
import { calendarDayIn, addDays, wallClockIn, formatCalendarDay } from '../lib/dates'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The statuses the server has — no more, no fewer. The old list had `late` and
 * `wfh`, which do not exist (WFH is a leave type, applied for like any other),
 * and lacked `on_leave` and `holiday`, which do — so leave days rendered as
 * blank and a Late card counted nothing, for ever.
 */
const STATUS_META = {
  present:    { label: 'Present',    cls: 'bg-green-100 text-green-700',    dot: 'bg-green-500' },
  half_day:   { label: 'Half Day',   cls: 'bg-purple-100 text-purple-700',  dot: 'bg-purple-500' },
  absent:     { label: 'Absent',     cls: 'bg-red-100 text-red-600',        dot: 'bg-red-500' },
  on_leave:   { label: 'On Leave',   cls: 'bg-amber-100 text-amber-700',    dot: 'bg-amber-500' },
  holiday:    { label: 'Holiday',    cls: 'bg-sky-100 text-sky-700',        dot: 'bg-sky-500' },
  weekly_off: { label: 'Weekly Off', cls: 'bg-indigo-100 text-indigo-700',  dot: 'bg-indigo-500' },
}

/** `unmarked` is not a status — it is the absence of one, and a tab of its own. */
const STATUS_TABS = ['all', 'present', 'half_day', 'absent', 'on_leave', 'weekly_off', 'unmarked']
const TAB_LABELS  = {
  all: 'All', present: 'Present', half_day: 'Half Day', absent: 'Absent',
  on_leave: 'On Leave', weekly_off: 'Weekly Off', unmarked: 'Not Marked',
}

/** The stored figure, from the server — never recomputed here from two clock times. */
function formatHours(hours) {
  if (hours == null) return '—'
  const whole = Math.floor(hours)
  const minutes = Math.round((hours - whole) * 60)
  return `${whole}h ${minutes}m`
}

function initials(name) {
  return (name || '').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
}

/** A CSV cell. Quotes inside a value are doubled, or one note breaks every column after it. */
// ─── Monthly calendar ─────────────────────────────────────────────────────────

function MonthlyCalendar({ attendanceMap, year, month, today }) {
  const daysInMonth = new Date(year, month, 0).getDate()
  const firstDay    = new Date(year, month - 1, 1).getDay()
  const monthLabel  = new Date(year, month - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' })

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <p className="text-base font-semibold text-gray-900">{monthLabel} — My Attendance</p>
        <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
          {Object.entries(STATUS_META).map(([k, v]) => (
            <div key={k} className="flex items-center gap-1.5 font-medium">
              <span className={`w-2.5 h-2.5 rounded-full ${v.dot}`} />
              {v.label}
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-7 mb-1">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
          <div key={d} className="text-center text-xs font-semibold text-gray-400 py-1">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: firstDay }).map((_, i) => <div key={`e-${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1
          const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const status = attendanceMap[key]
          const meta = STATUS_META[status]
          const isToday = key === today
          return (
            <div key={key}
              className={`aspect-square flex items-center justify-center rounded-lg text-xs font-semibold transition-all duration-100
                ${isToday ? 'ring-2 ring-blue-500 font-bold' : ''}
                ${meta ? meta.cls : 'text-gray-400 bg-gray-50'}`}>
              {day}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Attendance() {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  // The caller's EMPLOYEE id — attendance rows belong to employees. The old
  // page compared them with the USER id, a different table's key, so the
  // "My Attendance" calendar never matched a single row.
  const myEmployeeId = useAuthStore((state) => state.profile?.id ?? null)
  // Who may mark or correct a day is a permission. The role list this replaced
  // decided it by name.
  const canMark = useAuthStore((state) => state.can('attendance:mark'))

  // The company's today. From UTC it was yesterday until 05:30 in India.
  const today = calendarDayIn(timezone)

  const [viewChoice, setViewChoice] = useState(null)
  const [date, setDate]             = useState(today)
  const [tab, setTab]               = useState('all')
  const [deptFilter, setDeptFilter] = useState('All')
  const [search, setSearch]         = useState('')
  const [modalEmp, setModalEmp]     = useState(null)
  const { busy: exporting, start: startExport } = useDownload()

  const { data: roster, isLoading } = useDayRoster(date)
  const markAttendance              = useMarkAttendance()

  // For the personal monthly calendar
  const [calYear, calMonth] = date.split('-').map(Number)
  const { data: monthRecords = [] } = useMonthAttendance(calYear, calMonth)

  const records = useMemo(() => (roster?.employees ?? []).map((emp) => ({
    id: emp.employee_id,
    employee_code: emp.employee_code,
    full_name: emp.full_name,
    department: emp.department,
    designation: emp.designation,
    status: emp.attendance?.status ?? null,
    // Shown, and handed to the edit form, as the company's wall clock.
    check_in: wallClockIn(timezone, emp.attendance?.check_in),
    check_out: wallClockIn(timezone, emp.attendance?.check_out),
    hours_worked: emp.attendance?.hours_worked ?? null,
    note: emp.attendance?.note ?? '',
  })), [roster, timezone])

  // Whether this person sees anybody but themselves decides the default view:
  // somebody with a team starts on the roster, somebody without starts on their
  // own calendar. Decided by what the server returned — the scope it applied —
  // rather than by guessing from a role name.
  const seesOthers = records.some((r) => r.id !== myEmployeeId)
  // Until the roster arrives nobody knows which view is right, and guessing
  // flashes the wrong one at HR on every page load.
  const ready = Boolean(roster)
  const view = viewChoice ?? (seesOthers ? 'daily' : 'monthly')

  const departments = useMemo(
    () => ['All', ...[...new Set(records.map((r) => r.department).filter(Boolean))].sort()],
    [records],
  )

  const stats = useMemo(() => {
    const count = (status) => records.filter((r) => r.status === status).length
    return {
      present: count('present'),
      half_day: count('half_day'),
      absent: count('absent'),
      on_leave: count('on_leave'),
      weekly_off: count('weekly_off'),
      unmarked: records.filter((r) => r.status === null).length,
    }
  }, [records])

  const filtered = useMemo(() => records.filter((r) => {
    if (tab === 'unmarked' ? r.status !== null : tab !== 'all' && r.status !== tab) return false
    if (deptFilter !== 'All' && r.department !== deptFilter) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      if (!r.full_name.toLowerCase().includes(q) && !(r.employee_code ?? '').toLowerCase().includes(q)) return false
    }
    return true
  }), [records, tab, deptFilter, search])

  async function handleSave(updated) {
    // An absence has no clock times; the form may still be holding the
    // default check-in it filled in before the status was changed.
    const timed = updated.status !== 'absent'

    // Closed only once saved, so a refusal does not lose what was entered.
    const saved = await markAttendance.mutateAsync({
      employee_uuid: updated.id,
      date,
      status: updated.status,
      check_in: timed ? updated.check_in || null : null,
      check_out: timed ? updated.check_out || null : null,
      note: updated.note || null,
    }).then(() => true, () => false)

    if (saved) setModalEmp(null)
  }

  // The file is made on the server from the same roster and the same filters,
  // through the one CSV writer — BOM, quoting, and no formula can run in Excel.
  function handleExportCSV() {
    const params = new URLSearchParams({ date, status: tab })
    if (deptFilter !== 'All') params.set('department', deptFilter)
    if (search.trim()) params.set('search', search.trim())
    startExport('csv', () => saveFromApi(`/attendance/export?${params}`))
  }

  const marked = records.length - stats.unmarked
  const attPct = records.length ? Math.round((stats.present + stats.half_day) / records.length * 100) : 0

  // Build a date→status map for the signed-in employee's own days
  const attendanceMap = useMemo(() => {
    const map = {}
    monthRecords.forEach((a) => {
      if (a.employee_id === myEmployeeId) {
        map[a.date] = a.status
      }
    })
    return map
  }, [monthRecords, myEmployeeId])

  return (
    <>
      <div className="space-y-5">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Attendance</h2>
            <p className="text-sm text-gray-500 mt-0.5">{formatCalendarDay(date)}</p>
          </div>
          <div className="flex items-center gap-2">
            {seesOthers && (
              <div className="flex items-center bg-gray-100 rounded-lg p-1">
                <button onClick={() => setViewChoice('daily')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                    ${view === 'daily' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                  Daily
                </button>
                <button onClick={() => setViewChoice('monthly')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5
                    ${view === 'monthly' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                  <Calendar className="w-3.5 h-3.5" /> Monthly
                </button>
              </div>
            )}
            <button onClick={handleExportCSV} disabled={exporting === 'csv'}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-sm font-medium text-gray-700 transition-colors disabled:opacity-60">
              {exporting === 'csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Export
            </button>
          </div>
        </div>

        {!ready && (
          <p className="text-sm text-gray-400 py-10 text-center">Loading attendance…</p>
        )}

        {/* Month navigation for somebody who sees only their own days */}
        {ready && !seesOthers && (
          <div className="flex items-center gap-2 border border-gray-200 rounded-lg overflow-hidden shrink-0 w-fit bg-white">
            <button onClick={() => setDate((d) => addDays(`${d.slice(0, 7)}-01`, -1).slice(0, 7) + '-01')}
              className="px-2.5 py-2 hover:bg-gray-50 text-slate-500 hover:text-slate-700 transition-colors border-r border-gray-200">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input
              type="month"
              value={date.slice(0, 7)}
              onChange={(e) => setDate(e.target.value + '-01')}
              className="px-3 py-2 text-sm text-slate-700 focus:outline-none bg-transparent"
            />
            <button onClick={() => setDate((d) => addDays(`${d.slice(0, 7)}-28`, 7).slice(0, 7) + '-01')}
              className="px-2.5 py-2 hover:bg-gray-50 text-slate-500 hover:text-slate-700 transition-colors border-l border-gray-200">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Stat cards for anybody looking at a team */}
        {seesOthers && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {[
              { key: 'present',  icon: UserCheck,    label: 'Present',    iconBg: 'bg-green-100',  iconColor: 'text-green-600' },
              { key: 'half_day', icon: Clock,        label: 'Half Day',   iconBg: 'bg-purple-100', iconColor: 'text-purple-600' },
              { key: 'absent',   icon: UserX,        label: 'Absent',     iconBg: 'bg-red-100',    iconColor: 'text-red-600' },
              { key: 'on_leave', icon: CalendarDays, label: 'On Leave',   iconBg: 'bg-amber-100',  iconColor: 'text-amber-600' },
              { key: 'unmarked', icon: CircleDashed, label: 'Not Marked', iconBg: 'bg-gray-100',   iconColor: 'text-gray-500' },
            ].map(({ key, icon, label, iconBg, iconColor }) => (
              <button key={key} onClick={() => setTab(tab === key ? 'all' : key)}
                className={`bg-white rounded-xl border shadow-sm p-4 flex items-center gap-3 text-left transition-all
                  ${tab === key ? 'border-blue-400 ring-1 ring-blue-400' : 'border-gray-200 hover:border-gray-300'}`}>
                <div className={`${iconBg} rounded-lg p-2 shrink-0`}>
                  {createElement(icon, { className: `w-5 h-5 ${iconColor}` })}
                </div>
                <div>
                  <p className="text-xl font-bold text-gray-900">{stats[key]}</p>
                  <p className="text-xs text-gray-500">{label}</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {ready && view === 'monthly' && (
          <MonthlyCalendar
            attendanceMap={attendanceMap}
            year={calYear}
            month={calMonth}
            today={today}
          />
        )}

        {view === 'daily' && seesOthers && (
          <>
            {/* Date nav + filters */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 flex flex-wrap gap-3 items-center">
              <div className="flex items-center gap-1 border border-gray-200 rounded-lg overflow-hidden shrink-0">
                <button onClick={() => setDate((d) => addDays(d, -1))}
                  className="px-2.5 py-2 hover:bg-gray-50 text-gray-500 hover:text-gray-700 transition-colors border-r border-gray-200">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)}
                  className="px-3 py-2 text-sm text-gray-700 focus:outline-none bg-transparent" />
                <button onClick={() => setDate((d) => (d < today ? addDays(d, 1) : d))}
                  disabled={date >= today}
                  className="px-2.5 py-2 hover:bg-gray-50 text-gray-500 hover:text-gray-700 disabled:text-gray-300 disabled:hover:bg-transparent transition-colors border-l border-gray-200">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="relative flex-1 min-w-40">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input type="text" placeholder="Search employee…"
                  value={search} onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm
                    focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-gray-400" />
              </div>

              {/* The company's own departments, from the people on the roster —
                  not a list typed into this file that named departments the
                  company does not have. */}
              <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700
                  focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
                {departments.map((d) => <option key={d}>{d}</option>)}
              </select>

              <div className="ml-auto flex items-center gap-2 shrink-0">
                <span className="text-xs text-gray-400">{marked}/{records.length} marked</span>
                <div className="w-32 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${attPct}%` }} />
                </div>
                <span className="text-sm font-semibold text-gray-700">{attPct}%</span>
              </div>
            </div>

            {/* Status tabs */}
            <div className="flex items-center gap-1 flex-wrap">
              {STATUS_TABS.map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                    ${tab === t ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                  {TAB_LABELS[t]}
                  {t !== 'all' && (
                    <span className={`ml-1.5 text-xs ${tab === t ? 'text-blue-200' : 'text-gray-400'}`}>
                      {stats[t]}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px]">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Employee</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Department</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Check-in</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Check-out</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Hours</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                      {canMark && <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Action</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading ? (
                      <tr><td colSpan={canMark ? 7 : 6} className="text-center py-16 text-sm text-gray-400">Loading…</td></tr>
                    ) : filtered.length === 0 ? (
                      <tr><td colSpan={canMark ? 7 : 6} className="text-center py-16 text-sm text-gray-400">No records found.</td></tr>
                    ) : filtered.map((rec) => {
                      const meta = rec.status ? STATUS_META[rec.status] : null
                      return (
                        <tr key={rec.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                                <span className="text-blue-700 text-xs font-semibold">{initials(rec.full_name)}</span>
                              </div>
                              <div>
                                <p className="text-sm font-medium text-gray-900">{rec.full_name}</p>
                                <p className="text-xs text-gray-400 font-mono">{rec.employee_code}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3.5">
                            <p className="text-sm text-gray-700">{rec.department || '—'}</p>
                            <p className="text-xs text-gray-400">{rec.designation || '—'}</p>
                          </td>
                          <td className="px-4 py-3.5">
                            <span className={`text-sm font-medium ${rec.check_in ? 'text-gray-900' : 'text-gray-300'}`}>
                              {rec.check_in || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3.5">
                            <span className={`text-sm ${rec.check_out ? 'text-gray-900' : 'text-gray-300'}`}>
                              {rec.check_out || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3.5">
                            <span className="text-sm text-gray-700">{formatHours(rec.hours_worked)}</span>
                          </td>
                          <td className="px-4 py-3.5">
                            {meta ? (
                              <div className="flex items-center gap-2">
                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${meta.cls}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${meta.dot}`} />
                                  {meta.label}
                                </span>
                                {rec.note && <span className="text-xs text-gray-400 truncate max-w-24" title={rec.note}>{rec.note}</span>}
                              </div>
                            ) : (
                              <span className="text-xs text-gray-300 italic">Not marked</span>
                            )}
                          </td>
                          {canMark && (
                            <td className="px-5 py-3.5 text-right">
                              <button onClick={() => setModalEmp(rec)}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100
                                  text-xs font-semibold transition-colors ml-auto shadow-2xs">
                                <Edit2 className="w-3.5 h-3.5" />
                                {rec.status ? 'Edit' : 'Mark'}
                              </button>
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
                <p className="text-xs text-gray-400">Showing {filtered.length} of {records.length} employees</p>
                <p className="text-xs text-gray-400">{date}</p>
              </div>
            </div>
          </>
        )}
      </div>

      <MarkAttendanceModal
        open={!!modalEmp}
        employee={modalEmp}
        onClose={() => setModalEmp(null)}
        onSave={handleSave}
      />
    </>
  )
}
