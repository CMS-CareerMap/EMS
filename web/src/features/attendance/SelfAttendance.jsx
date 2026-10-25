import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Briefcase, Clock, Fingerprint, Home, Inbox } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { usePersonMonth } from '../../hooks/useAttendance'
import { useMyWorkplace } from '../../hooks/usePunch'
import { useMyRequests } from '../../hooks/useRequests'
import DataState from '../../components/DataState'
import Tabs, { TabPanel } from '../../components/ui/Tabs'
import { Card, CardLink, Chip, EmptyState, IconBox } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
import { formatDay } from '../../lib/dates'
import { WEEKDAYS, WEEK_MONDAY_FIRST, openOf, payDayMaps, serverSkew, weekdayOf } from '../../lib/attendance'
import { WORK_MODES, minutesLabel, statusOf, summaryOf, typeLabel } from '../../lib/requests'
import { REQUEST_TONE, kindOf } from '../../lib/requestKinds'
import PunchCard from './PunchCard'
import MonthNav from './MonthNav'
import MonthCalendar from './MonthCalendar'
import MonthFigures from './MonthFigures'
import DayLog from './DayLog'

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
  const [year, month] = monthKey.split('-').map(Number)

  // The month as the server counts it (client, 15 Oct 2026): their days, the company's days off, the
  // month in pay terms and the month so far — the same answer the page HR or their manager opens reads.
  const monthOf = usePersonMonth(profile?.id, year, month, { enabled: Boolean(profile) })
  const mayPunch = can('attendance:punch')
  const workplace = useMyWorkplace({ enabled: mayPunch && Boolean(profile) })
  // A correction, a day from home, a day on duty — what one asks for oneself (client §28).
  const asks = Boolean(profile) && can('leave:apply')
  const [sub, setSub] = useState('log')
  // The month in pay terms (client, 10 Oct 2026): leave days by type, absent days, days paid and unpaid.
  const { leaveOn, absentOn } = payDayMaps(monthOf.data?.pay_days)
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

  const rows = monthOf.data?.days ?? []
  const joinedOn = monthOf.data?.person?.date_of_joining ?? null

  const tabs = [
    { key: 'log', label: 'Attendance log' },
    { key: 'calendar', label: 'Calendar' },
    ...(asks ? [{ key: 'requests', label: 'Attendance requests' }] : []),
  ]

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 items-start">
        {mayPunch && profile.attendance_mode === 'app' ? <PunchCard link={false} /> : <HowRecorded mode={profile.attendance_mode} mayPunch={mayPunch} />}
        <MonthFigures query={monthOf} year={year} month={month} title="Attendance stats" />
        <Timings workplace={workplace} calendar={monthOf} today={today} mayPunch={mayPunch} />
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
          // The month's answer says when they joined: without it the days before
          // would read as "not marked", so its failure is shown, not guessed past.
          <DataState query={monthOf} compact loading="Loading your days…">
            {(d) => (
              <DayLog year={year} month={month} today={today} days={d.days} daysOff={d.days_off} leaveOn={leaveOn} absentOn={absentOn}
                onApply={applyFor} joinedOn={joinedOn} leftOn={d.person.employed_until} open={openOf(d)} skewMs={serverSkew(d)} label="Your days" notJoined="You had not joined yet in this month." />
            )}
          </DataState>
        )}

        {sub === 'calendar' && (
          <div className="p-4">
            <MonthCalendar year={year} month={month} today={today} rows={rows} rowsQuery={monthOf} calendarQuery={monthOf} showUnmarked joinedOn={joinedOn}
              leftOn={monthOf.data?.person?.employed_until ?? null} openDay={monthOf.data?.totals?.open_day ?? null} leaveOn={leaveOn} absentOn={absentOn} onApply={applyFor} />
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

/** The working week and the shift: which days are off, and the hours of the ones that are not. */
function Timings({ workplace, calendar, today, mayPunch }) {
  // The week as it is today (the calendar draws each day by the week in force on it) — from their own
  // month, which every login with a record reads, punching or not (client, 25 Oct 2026).
  const week = calendar.data?.week_today ?? null
  const offs = week?.weekly_off_days ?? null
  // A change saved for a later day: what is coming, said now.
  const nextWeek = week?.next ?? null
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
                <dd className="font-bold text-gray-900 text-right">{offs === null ? '…' : offs.length ? WEEK_MONDAY_FIRST.filter((d) => offs.includes(d)).map((d) => WEEKDAYS[d]).join(', ') : 'None'}</dd>
              </div>
              {nextWeek && (
                <div className="flex items-baseline justify-between gap-3 py-2 border-t border-gray-100">
                  <dt className="text-gray-600">From {formatDay(nextWeek.from)}</dt>
                  <dd className="font-bold text-brand-700 text-right">{nextWeek.weekly_off_days.length ? WEEK_MONDAY_FIRST.filter((d) => nextWeek.weekly_off_days.includes(d)).map((d) => WEEKDAYS[d]).join(', ') : 'No weekly off'}</dd>
                </div>
              )}
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
