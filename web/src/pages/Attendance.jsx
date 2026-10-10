import { useState, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Download, Calendar, CalendarDays, Loader2, Upload } from 'lucide-react'
import MarkAttendanceModal from '../features/attendance/MarkAttendanceModal'
import ImportAttendanceModal from '../features/attendance/ImportAttendanceModal'
import SelfAttendance from '../features/attendance/SelfAttendance'
import TeamDay from '../features/attendance/TeamDay'
import MonthNav from '../features/attendance/MonthNav'
import MonthCalendar from '../features/attendance/MonthCalendar'
import MonthTotals from '../features/attendance/MonthTotals'
import { useDayRoster, useMonthAttendance, useMonthCalendar, useMarkAttendance, useMyPayDays } from '../hooks/useAttendance'
import { useNow } from '../hooks/useNow'
import { useAuthStore } from '../stores/authStore'
import { saveFromApi } from '../api/http'
import { useDownload } from '../hooks/useDownload'
import { addDays, calendarDayIn, wallClockIn, formatCalendarDay } from '../lib/dates'
import { clockSkew, monthLabel, payDayMaps } from '../lib/attendance'
import DataState from '../components/DataState'
import PageHeader from '../components/ui/PageHeader'
import Segmented from '../components/ui/Segmented'
import { Card } from '../components/ui/bits'
import { btn, card, field } from '../components/ui/styles'

/**
 * Attendance.
 *
 * Somebody who sees only themselves gets their own page: today, the month in
 * figures, their timings and the month's log. Somebody whose attendance
 * reaches others — a team, or the company — gets the day's roster, and the
 * month: their own calendar and everybody's hours.
 */
export default function Attendance() {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  // The caller's EMPLOYEE id — attendance rows belong to employees. The old
  // page compared them with the USER id, a different table's key, so the
  // "My Attendance" calendar never matched a single row.
  const myEmployeeId = useAuthStore((state) => state.profile?.id ?? null)
  // Who may mark or correct a day is a permission. The role list this replaced
  // decided it by name.
  const canMark = useAuthStore((state) => state.can('attendance:mark'))
  const now = useNow()

  // The company's today. From UTC it was yesterday until 05:30 in India.
  const today = calendarDayIn(timezone)

  const [viewChoice, setViewChoice] = useState(null)
  const [date, setDate]             = useState(today)
  const [monthKey, setMonthKey]     = useState(today.slice(0, 7))
  const [tab, setTab]               = useState('all')
  const [deptFilter, setDeptFilter] = useState('All')
  const [search, setSearch]         = useState('')
  const [modalEmp, setModalEmp]     = useState(null)
  const [importing, setImporting]   = useState(false)
  const { busy: exporting, start: startExport } = useDownload()

  // Asked again every minute while somebody who sees others watches today's or
  // yesterday's roster (a night shift's day is yesterday's), on the daily view —
  // never for one's own page, whose Check In must not hang on it.
  const attendanceReach = useAuthStore((state) => state.attendanceReach)
  const watching = Boolean(attendanceReach) && attendanceReach !== 'SELF' && (viewChoice ?? 'daily') === 'daily' && (date === today || date === addDays(today, -1))
  const roster         = useDayRoster(date, { live: watching })
  const rosterData     = roster.data
  // Now by the server's clock: the time at work the roster runs is counted on it.
  const serverNow      = new Date(now.getTime() + clockSkew(rosterData?.server_now, roster.dataUpdatedAt))
  const markAttendance = useMarkAttendance()

  const records = useMemo(() => (rosterData?.employees ?? []).map((emp) => ({
    id: emp.employee_id,
    employee_code: emp.employee_code,
    full_name: emp.full_name,
    department: emp.department,
    designation: emp.designation,
    status: emp.attendance?.status ?? null,
    // Shown, and handed to the edit form, as the company's wall clock.
    check_in: wallClockIn(timezone, emp.attendance?.check_in),
    check_out: wallClockIn(timezone, emp.attendance?.check_out),
    // The instant itself, and whether they are still at work (the server's
    // rule, their own card's): the roster runs their time from it (client, 9 Oct 2026).
    check_in_at: emp.attendance?.check_in ?? null,
    at_work: Boolean(emp.at_work),
    // What wrote the day: the app, the machine, or HR by hand.
    source: emp.attendance?.source ?? null,
    hours_worked: emp.attendance?.hours_worked ?? null,
    note: emp.attendance?.note ?? '',
    // Where they worked from (client §33) and what they checked in on — office days say nothing.
    work_mode: emp.attendance?.work_mode ?? null,
    check_in_device: emp.attendance?.check_in_device ?? null,
    // Against the shift (client §34–35): late past the grace, overtime past its threshold.
    late_minutes: emp.attendance?.late_minutes ?? null,
    early_leaving_minutes: emp.attendance?.early_leaving_minutes ?? null,
    overtime_minutes: emp.attendance?.overtime_minutes ?? null,
    // Own work goes up the company tree (Day 22): whom this day goes to, when not the caller.
    mark_goes_to: emp.mark_goes_to ?? null,
  })), [rosterData, timezone])

  // Whether this person sees anybody but themselves decides the page: the
  // roster for somebody with a team, their own page for somebody without.
  // Decided by the attendance reach the server put in the session — and by
  // the roster it returned — never by a role name. Not by the roster alone:
  // on a day before everybody joined it can hold nobody else, and the page
  // turned into the personal one, its date picker gone with no way back.
  const seesOthers = (Boolean(attendanceReach) && attendanceReach !== 'SELF') || records.some((r) => r.id !== myEmployeeId)
  const view = viewChoice ?? 'daily'

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

  // A roster on screen — the last good one too, when a refresh failed (it stays, with a note).
  const ready = roster.data !== undefined
  const self = ready && !seesOthers
  const [year, month] = monthKey.split('-').map(Number)
  const subtitle = self ? formatCalendarDay(today) : view === 'monthly' ? monthLabel(year, month) : formatCalendarDay(date)

  return (
    <>
      <PageHeader
        title="Attendance"
        subtitle={ready ? subtitle : ' '}
        actions={<>
          {seesOthers && (
            <Segmented label="View" value={view} onChange={setViewChoice}
              items={[{ key: 'daily', label: 'Daily', icon: CalendarDays }, { key: 'monthly', label: 'Monthly', icon: Calendar }]} />
          )}
          {/* The biometric machine's file (Day 12): whoever may mark other people's days. */}
          {canMark && (
            <button onClick={() => setImporting(true)} className={btn.secondary}>
              <Upload className="w-4 h-4" aria-hidden="true" /> Import
            </button>
          )}
          <button onClick={handleExportCSV} disabled={exporting === 'csv'} className={btn.secondary}>
            {exporting === 'csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" aria-hidden="true" />} Export
          </button>
        </>}
      />

      {/* A day that could not be loaded still leaves a way to another day:
          the date controls below live inside the roster's view. Not when a
          refresh failed over a roster still on screen — its own controls stay. */}
      {roster.isError && roster.data === undefined && (
        <div className={`${card} mb-4 px-4 py-3 flex flex-wrap items-center gap-3`}>
          <label htmlFor="attendance-other-day" className="text-sm text-gray-600">Choose another day</label>
          <input id="attendance-other-day" type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className={field} />
          {date !== today && (
            <button type="button" onClick={() => setDate(today)} className={btn.softSm}>Today</button>
          )}
        </div>
      )}

      {/* Everything below is drawn from the roster — even which page is right,
          so guessing before it arrives would flash the wrong one at HR. A
          roster that failed shows the error, never an empty team. */}
      <DataState query={roster} loading="Loading attendance…" keepOnRefetchError>
        {() => !seesOthers ? (
          <SelfAttendance monthKey={monthKey} onMonth={setMonthKey} today={today} />
        ) : view === 'monthly' ? (
          <TeamMonth monthKey={monthKey} onMonth={setMonthKey} today={today} myEmployeeId={myEmployeeId} />
        ) : (
          // inert while the next day loads: the rows on screen are the last day's, and
          // editing one would save the old day's entry onto the new date.
          <div className={`transition-opacity ${roster.isPlaceholderData ? 'opacity-60' : ''}`} aria-busy={roster.isPlaceholderData} inert={roster.isPlaceholderData}>
            <TeamDay
              records={records} filtered={filtered} stats={stats}
              date={date} onDate={setDate} today={today}
              tab={tab} onTab={setTab}
              departments={departments} deptFilter={deptFilter} onDept={setDeptFilter}
              search={search} onSearch={setSearch}
              canMark={canMark} onMark={setModalEmp}
              nowMs={serverNow.getTime()}
            />
          </div>
        )}
      </DataState>

      <MarkAttendanceModal
        open={!!modalEmp}
        employee={modalEmp}
        onClose={() => setModalEmp(null)}
        onSave={handleSave}
      />
      {importing && <ImportAttendanceModal onClose={() => setImporting(false)} />}
    </>
  )
}

/**
 * The month, for somebody with a team: their own calendar — when they have an
 * employee record — and everybody's hours.
 */
function TeamMonth({ monthKey, onMonth, today, myEmployeeId }) {
  const onStaff = useAuthStore((state) => Boolean(state.profile) && state.can('leave:apply'))
  const [year, month] = monthKey.split('-').map(Number)
  const records = useMonthAttendance(year, month, { enabled: Boolean(myEmployeeId), employeeId: myEmployeeId })
  const calendar = useMonthCalendar(year, month, { enabled: Boolean(myEmployeeId) })
  const mine = (records.data ?? []).filter((a) => a.employee_id === myEmployeeId)
  // Their own month in pay terms too (client, 10 Oct 2026): leave by type, absent days, days paid and unpaid.
  const payDays = useMyPayDays(year, month, { enabled: Boolean(myEmployeeId) })
  const { leaveOn, absentOn } = payDayMaps(payDays.data)
  const navigate = useNavigate()
  const applyFor = onStaff ? (day) => navigate(`/leave?apply=1&from=${day}&to=${day}`) : null
  const pd = payDays.data

  return (
    <div className="space-y-4 sm:space-y-5">
      <MonthNav value={monthKey} onChange={onMonth} />
      {myEmployeeId && (
        <Card title={`${monthLabel(year, month)} — My attendance`} subtitle="Your own days, holidays and weekly offs">
          {pd?.employed && pd.paid_days !== null && (
            <p className="mb-3 text-sm text-gray-700">
              Paid days <b className="tabular-nums">{pd.paid_days} of {pd.employment_days}</b>
              {' · '}Unpaid days (loss of pay) <b className={`tabular-nums ${pd.unpaid_days > 0 ? 'text-amber-800' : ''}`}>{pd.unpaid_days}</b>
              <span className="text-xs text-gray-400"> · so far; the payslip is final</span>
            </p>
          )}
          <MonthCalendar year={year} month={month} today={today} rows={mine} rowsQuery={records} calendarQuery={calendar}
            leaveOn={leaveOn} absentOn={absentOn} onApply={applyFor} />
          {/* A missed or wrong punch is put right by whoever decides corrections (client §28). */}
          {onStaff && (
            <p className="mt-3 text-xs text-gray-500">
              A day looks wrong? <Link to="/requests?new=attendance_correction" className="font-semibold text-brand-600 hover:text-brand-800">Request a correction</Link>
            </p>
          )}
        </Card>
      )}
      <MonthTotals year={year} month={month} />
    </div>
  )
}
