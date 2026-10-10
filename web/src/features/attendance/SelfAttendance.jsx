import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Briefcase, Clock, Fingerprint, Home, Inbox } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useMonthAttendance, useMonthCalendar, useMonthlyHours, useMyPayDays } from '../../hooks/useAttendance'
import { useMyWorkplace } from '../../hooks/usePunch'
import { useMyRequests } from '../../hooks/useRequests'
import { useNow } from '../../hooks/useNow'
import DataState from '../../components/DataState'
import Tabs, { TabPanel } from '../../components/ui/Tabs'
import { Card, CardLink, Chip, EmptyState, IconBox } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
import { WEEKDAYS, WEEK_MONDAY_FIRST, dayState, daysOfMonth, formatHours, monthLabel, payDayMaps, toMinutes, weekdayOf } from '../../lib/attendance'
import AbsentAction from './AbsentAction'
import { formatDay, isoInstant, wallClockIn } from '../../lib/dates'
import { WORK_MODES, minutesLabel, statusOf, summaryOf, typeLabel } from '../../lib/requests'
import { REQUEST_TONE, kindOf } from '../../lib/requestKinds'
import PunchCard from './PunchCard'
import MonthNav from './MonthNav'
import MonthCalendar from './MonthCalendar'

/**
 * Attendance for somebody who sees only their own: today (Check In / Check
 * Out), the month in figures, their timings, and the month's log — a line a
 * day, the calendar, and their attendance requests.
 */

/** The requests that are about attendance. */
const ATTENDANCE_REQUESTS = new Set(['attendance_correction', 'work_from_home', 'on_duty', 'overtime'])

export default function SelfAttendance({ monthKey, onMonth, today }) {
  const profile = useAuthStore((state) => state.profile)
  const can = useAuthStore((state) => state.can)
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const [year, month] = monthKey.split('-').map(Number)

  const records = useMonthAttendance(year, month, { enabled: Boolean(profile), employeeId: profile?.id })
  const calendar = useMonthCalendar(year, month)
  // The month's total as the server sums it — the figure the payslip agrees with.
  const totals = useMonthlyHours(year, month)
  const mayPunch = can('attendance:punch')
  const workplace = useMyWorkplace({ enabled: mayPunch && Boolean(profile) })
  // A correction, a day from home, a day on duty — what one asks for oneself (client §28).
  const asks = Boolean(profile) && can('leave:apply')
  const [sub, setSub] = useState('log')
  const now = useNow()
  // The month in pay terms (client, 10 Oct 2026): leave days by type, absent days, days paid and unpaid.
  const payDays = useMyPayDays(year, month, { enabled: Boolean(profile) })
  const { leaveOn, absentOn } = payDayMaps(payDays.data)
  const navigate = useNavigate()
  // An absent day leave can still be asked for: the leave form, on that day.
  const applyFor = asks ? (day) => navigate(`/leave?apply=1&from=${day}&to=${day}`) : null

  if (!profile) {
    return (
      <Card>
        <EmptyState icon={Fingerprint} title="No attendance of your own">
          This login has no employee record, so it does not check in and has no days to show.
        </EmptyState>
      </Card>
    )
  }

  const rows = (records.data ?? []).filter((r) => r.employee_id === profile.id)
  const byDate = new Map(rows.map((r) => [r.date, r]))
  const offOn = new Map((calendar.data?.days_off ?? []).map((d) => [d.date, d]))
  const joinedOn = workplace.data?.date_of_joining ?? null
  // The log: the month's days up to today, from the day they joined, newest first.
  const logDays = daysOfMonth(year, month).filter((d) => d <= today && (!joinedOn || d >= joinedOn)).reverse()
  const nowMinutes = toMinutes(wallClockIn(timezone, isoInstant(now)))
  const clock = (iso) => (iso ? wallClockIn(timezone, iso) : null)

  const tabs = [
    { key: 'log', label: 'Attendance log' },
    { key: 'calendar', label: 'Calendar' },
    ...(asks ? [{ key: 'requests', label: 'Attendance requests' }] : []),
  ]

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 items-start">
        {mayPunch && profile.attendance_mode === 'app' ? <PunchCard link={false} /> : <HowRecorded mode={profile.attendance_mode} mayPunch={mayPunch} />}
        <MonthFigures rows={rows.filter((r) => r.date <= today)} label={monthLabel(year, month)} query={records}
          totals={totals} own={totals.data?.employees?.find((e) => e.employee_uuid === profile.id) ?? null} payDays={payDays} />
        <Timings workplace={workplace} calendar={calendar} today={today} mayPunch={mayPunch} />
      </div>

      <Card bodyClassName="" title="Logs & requests" subtitle="Your days, a line a day"
        action={<MonthNav value={monthKey} onChange={onMonth} />}>
        {asks && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            <Link to="/requests?new=attendance_correction" className={btn.secondarySm}><Clock className="w-3.5 h-3.5" aria-hidden="true" />Request a correction</Link>
            <Link to="/requests?new=work_from_home" className={btn.secondarySm}><Home className="w-3.5 h-3.5" aria-hidden="true" />Work from home</Link>
            <Link to="/requests?new=on_duty" className={btn.secondarySm}><Briefcase className="w-3.5 h-3.5" aria-hidden="true" />On duty</Link>
          </div>
        )}
        <div className="px-4 mt-2 border-b border-gray-100">
          <Tabs items={tabs} value={sub} onChange={setSub} label="Logs and requests" panelId="attendance-log-panel" />
        </div>

        <TabPanel id="attendance-log-panel" tab={sub}>
        {sub === 'log' && (
          // The workplace says when they joined: without it the days before
          // would read as "not marked", so its failure is shown, not guessed past.
          <DataState queries={mayPunch ? [records, calendar, workplace] : [records, calendar]} compact loading="Loading your days…">
            {() => logDays.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-gray-500">
                {daysOfMonth(year, month)[0] > today ? 'This month has not started yet.' : 'You had not joined yet in this month.'}
              </p>
            ) : (
              <>
                {/* A computer: a table with the day drawn on a line. */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-sm" aria-label={`Your days in ${monthLabel(year, month)}`}>
                    <thead>
                      <tr className="text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-100">
                        <th className="px-4 py-2.5">Date</th>
                        <th className="px-4 py-2.5">Arrival</th>
                        <th className="px-4 py-2.5">Departure</th>
                        <th className="px-4 py-2.5">Hours</th>
                        <th className="px-4 py-2.5">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {logDays.map((day) => {
                        const row = byDate.get(day)
                        const off = offOn.get(day)
                        const state = dayState({ date: day, row, dayOff: off, today, leave: leaveOn.get(day) ?? null })
                        const inAt = clock(row?.check_in)
                        const outAt = clock(row?.check_out)
                        return (
                          <tr key={day} className={day === today ? 'bg-brand-50/40' : ''}>
                            <td className="px-4 py-3 font-semibold text-gray-900 whitespace-nowrap">{formatDay(day, { weekday: true, year: false })}</td>
                            <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                              {inAt ?? <span className="text-gray-300">—</span>}
                              {row?.late_minutes > 0 && <span className="ml-1.5 text-xs font-bold text-amber-600">+{minutesLabel(row.late_minutes)}</span>}
                            </td>
                            <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                              {outAt ?? <span className="text-gray-300">—</span>}
                              {row?.early_leaving_minutes > 0 && <span className="ml-1.5 text-xs font-bold text-amber-600">−{minutesLabel(row.early_leaving_minutes)}</span>}
                            </td>
                            <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                              {row?.hours_worked != null ? formatHours(row.hours_worked) : inAt && !outAt && day === today && nowMinutes > toMinutes(inAt) ? <span className="text-gray-500">{minutesLabel(nowMinutes - toMinutes(inAt))} so far</span> : <span className="text-gray-300">—</span>}
                              {row?.overtime_minutes > 0 && <span className="block text-xs font-semibold text-emerald-700">+{minutesLabel(row.overtime_minutes)} overtime</span>}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Chip tone={state.tone}>{state.label}</Chip>
                                {row?.work_mode && row.work_mode !== 'office' && <Chip tone="info" dot={false}>{WORK_MODES[row.work_mode]}</Chip>}
                                <AbsentAction absent={row?.status === 'absent' ? absentOn.get(day) : null} day={day} onApply={applyFor} />
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* A phone: a line a day, the times under the date. */}
                <ul className="md:hidden divide-y divide-gray-100" aria-label={`Your days in ${monthLabel(year, month)}`}>
                  {logDays.map((day) => {
                    const row = byDate.get(day)
                    const state = dayState({ date: day, row, dayOff: offOn.get(day), today, leave: leaveOn.get(day) ?? null })
                    const inAt = clock(row?.check_in)
                    const outAt = clock(row?.check_out)
                    return (
                      <li key={day} className={`px-4 py-3 ${day === today ? 'bg-brand-50/40' : ''}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-gray-900">{formatDay(day, { weekday: true, year: false })}</span>
                          <Chip tone={state.tone}>{state.label}</Chip>
                        </div>
                        <div className="mt-1 empty:hidden"><AbsentAction absent={row?.status === 'absent' ? absentOn.get(day) : null} day={day} onApply={applyFor} /></div>
                        {(inAt || row?.hours_worked != null) && (
                          <p className="text-xs text-gray-500 mt-1 tabular-nums">
                            {[inAt && `In ${inAt}${row?.late_minutes > 0 ? ` (+${minutesLabel(row.late_minutes)})` : ''}`, outAt && `Out ${outAt}`, row?.hours_worked != null && formatHours(row.hours_worked)].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </DataState>
        )}

        {sub === 'calendar' && (
          <div className="p-4">
            <MonthCalendar year={year} month={month} today={today} rows={rows} rowsQuery={records} calendarQuery={calendar} joinedOn={joinedOn}
              leaveOn={leaveOn} absentOn={absentOn} onApply={applyFor} />
            {asks && (
              <p className="mt-3 text-xs text-gray-500">
                A day looks wrong? <Link to="/requests?new=attendance_correction" className="font-semibold text-brand-600 hover:text-brand-800">Request a correction</Link>
              </p>
            )}
          </div>
        )}

        {sub === 'requests' && asks && <MyAttendanceRequests />}
        </TabPanel>
      </Card>
    </div>
  )
}

/** For somebody who does not check in from the app: how their days are recorded. */
function HowRecorded({ mode, mayPunch }) {
  const words = !mayPunch
    ? 'This login does not check in. Checking in is done from your own employee login.'
    : mode === 'biometric'
      ? 'You check in at the biometric machine. Your days show here once HR imports its file.'
      : 'HR marks your attendance. Your days show here as they are marked.'
  return (
    <Card title="Time today">
      <div className="flex items-start gap-3">
        <IconBox icon={Fingerprint} tone="info" size="lg" />
        <p className="text-sm text-gray-600">{words}</p>
      </div>
    </Card>
  )
}

/**
 * The month in figures: the hours as the server totals them, the rest from
 * one's own rows up to today — and the days paid and unpaid as payroll will
 * count them (client, 10 Oct 2026), so far: days still ahead count as paid,
 * and the payslip is final.
 */
function MonthFigures({ rows, label, query, totals, own, payDays }) {
  const count = (status) => rows.filter((r) => r.status === status).length
  const present = count('present')
  const half = count('half_day')
  const worked = rows.filter((r) => r.hours_worked > 0)
  const average = worked.length ? worked.reduce((sum, r) => sum + Number(r.hours_worked), 0) / worked.length : null
  const arrivals = rows.filter((r) => r.check_in)
  const late = arrivals.filter((r) => r.late_minutes > 0).length
  const onTime = arrivals.length ? Math.round(((arrivals.length - late) / arrivals.length) * 100) : null

  const line = (name, value, hint) => (
    <div className="flex items-baseline justify-between gap-3 py-2.5 border-t border-gray-100 first:border-t-0 first:pt-0">
      <dt className="text-sm text-gray-600">{name}</dt>
      <dd className="text-right">
        <span className="text-sm font-bold text-gray-900 tabular-nums">{value}</span>
        {hint && <span className="block text-[11px] text-gray-400">{hint}</span>}
      </dd>
    </div>
  )

  return (
    <Card title="Attendance stats" subtitle={label}>
      <DataState queries={[query, totals]} compact>
        {() => (
          <dl>
            {line('Hours worked', formatHours(own?.total_hours ?? 0), own ? `of ${formatHours(own.expected_hours)} expected for the days worked` : null)}
            {line('Days present', present + half, half ? `${half} of them half days` : null)}
            {line('Average hours a day', average === null ? '—' : formatHours(average))}
            {line('On-time arrival', onTime === null ? '—' : `${onTime}%`, late ? `late on ${late} day${late === 1 ? '' : 's'}` : null)}
            {line('Leave · Absent', `${count('on_leave')} · ${count('absent')}`)}
            <PayDaysLines payDays={payDays} line={line} />
          </dl>
        )}
      </DataState>
    </Card>
  )
}

/**
 * Paid days and unpaid days (loss of pay) for the month, from the server's
 * reckoning — the payroll run's own. Nothing while it loads; a dash where no
 * pay rules were in force; a quiet line if it failed, so the hours above stay.
 */
function PayDaysLines({ payDays, line }) {
  const d = payDays?.data
  if (payDays?.isError) return line('Paid · Unpaid days', '—', 'Could not be worked out just now')
  if (!d || !d.employed) return null
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`
  return (
    <>
      {line('Paid days', d.paid_days === null ? '—' : `${d.paid_days} of ${d.employment_days}`,
        d.not_marked_days > 0 ? `so far · ${days(d.not_marked_days)} not marked yet, counted as paid` : 'so far · the payslip is final')}
      {line('Unpaid days (loss of pay)', d.unpaid_days === null ? '—' : <span className={d.unpaid_days > 0 ? 'text-amber-800' : ''}>{d.unpaid_days}</span>,
        d.unpaid_days > 0 ? 'cut from pay: absent, short days, or unpaid leave' : null)}
    </>
  )
}

/** The working week and the shift: which days are off, and the hours of the ones that are not. */
function Timings({ workplace, calendar, today, mayPunch }) {
  // The week as it is now; the calendar's is the shown month's, which may be an older rule.
  const offs = workplace.data?.weekly_off_days ?? calendar.data?.weekly_off_days ?? null
  const shift = workplace.data?.shift ?? null
  const todayWeekday = weekdayOf(today)

  return (
    <Card title="Timings" subtitle="Your working week">
      <DataState query={calendar} compact>
        {() => (
          <div className="space-y-3">
            <ol className="grid grid-cols-7 gap-1.5" aria-label="The week">
              {WEEK_MONDAY_FIRST.map((d) => {
                const off = offs?.includes(d)
                return (
                  <li key={d} title={`${WEEKDAYS[d]}${off ? ' — weekly off' : ''}`}
                    className={`h-8 rounded-lg grid place-items-center text-[11.5px] font-bold
                      ${d === todayWeekday ? 'bg-logo text-white' : off ? 'bg-gray-100 text-gray-400' : 'bg-brand-50 text-brand-700'}`}>
                    <span aria-hidden="true">{WEEKDAYS[d].slice(0, 1)}</span>
                    <span className="sr-only">{WEEKDAYS[d]}{off ? ', weekly off' : ''}</span>
                  </li>
                )
              })}
            </ol>
            <dl className="text-sm">
              {mayPunch && (
                <div className="flex items-baseline justify-between gap-3 py-2 border-t border-gray-100">
                  <dt className="text-gray-600">Shift</dt>
                  {/* A shift that failed to load is not "no shift". */}
                  <dd className={`font-bold text-right ${workplace.isError ? 'text-amber-700' : 'text-gray-900'}`}>
                    {workplace.isLoading ? '…' : shift ? `${shift.name} · ${shift.start_time} – ${shift.end_time}` : workplace.isError ? 'Could not be loaded' : 'No shift set'}
                  </dd>
                </div>
              )}
              {/* The rule the day is marked by (client, 8 Oct 2026): present from
                  the full-day hours, a half day from the half-day hours, absent below. */}
              {shift?.full_day_hours != null && (
                <div className="flex items-baseline justify-between gap-3 py-2 border-t border-gray-100">
                  <dt className="text-gray-600">Full day</dt>
                  <dd className="font-bold text-gray-900">{minutesLabel(Math.round(shift.full_day_hours * 60))} worked</dd>
                </div>
              )}
              {shift?.half_day_hours != null && (
                <div className="flex items-baseline justify-between gap-3 py-2 border-t border-gray-100">
                  <dt className="text-gray-600">Half day</dt>
                  <dd className="font-bold text-gray-900">{minutesLabel(Math.round(shift.half_day_hours * 60))} worked</dd>
                </div>
              )}
              {shift?.break_minutes > 0 && (
                <div className="flex items-baseline justify-between gap-3 py-2 border-t border-gray-100">
                  <dt className="text-gray-600">Unpaid break</dt>
                  <dd className="font-bold text-gray-900">{shift.break_minutes} min</dd>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3 py-2 border-t border-gray-100">
                <dt className="text-gray-600">Weekly off</dt>
                <dd className="font-bold text-gray-900 text-right">{offs?.length ? WEEK_MONDAY_FIRST.filter((d) => offs.includes(d)).map((d) => WEEKDAYS[d]).join(', ') : 'None'}</dd>
              </div>
              {workplace.data?.work_mode && workplace.data.work_mode !== 'office' && (
                <div className="flex items-baseline justify-between gap-3 py-2 border-t border-gray-100">
                  <dt className="text-gray-600">Today</dt>
                  <dd className="font-bold text-sky-700">{WORK_MODES[workplace.data.work_mode]}</dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </DataState>
    </Card>
  )
}

/** One's own requests about attendance — corrections, days from home, on duty, overtime. */
function MyAttendanceRequests() {
  const mine = useMyRequests()
  return (
    <div className="p-4">
      <DataState query={mine} compact
        isEmpty={(list) => !list.some((r) => ATTENDANCE_REQUESTS.has(r.type))}
        empty={<EmptyState icon={Inbox} title="No attendance requests">A correction, a day from home or a day on duty you ask for shows here.</EmptyState>}>
        {(list) => (
          <ul className="divide-y divide-gray-100">
            {list.filter((r) => ATTENDANCE_REQUESTS.has(r.type)).map((r) => (
              <li key={r.id} className="flex items-start gap-3 py-3 first:pt-0">
                <IconBox icon={kindOf(r.type).icon} tone={kindOf(r.type).tone} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-900">{typeLabel(r.type)}</p>
                  <p className="text-xs text-gray-500 wrap-break-word">{summaryOf(r)}{r.reason ? ` · “${r.reason}”` : ''}</p>
                </div>
                <Chip tone={REQUEST_TONE[r.status] ?? 'gray'}>{statusOf(r.status).label}</Chip>
              </li>
            ))}
          </ul>
        )}
      </DataState>
      <div className="mt-3 text-right"><CardLink to="/requests">All my requests</CardLink></div>
    </div>
  )
}
