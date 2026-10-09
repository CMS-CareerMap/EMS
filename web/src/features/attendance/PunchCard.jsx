import { Link } from 'react-router-dom'
import { LogIn, LogOut, Loader2, MapPin, CheckCircle2, Clock, Flag } from 'lucide-react'
import { useMyToday, useMyWorkplace, usePunchIn, usePunchOut } from '../../hooks/usePunch'
import { useNow } from '../../hooks/useNow'
import { WORK_MODES, minutesLabel } from '../../lib/requests'
import DataState from '../../components/DataState'
import { Card, CardLink, Chip } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
import { useAuthStore } from '../../stores/authStore'
import { calendarDayIn, formatDay, isoInstant, wallClockIn } from '../../lib/dates'
import { formatHours } from '../../lib/attendance'

/**
 * "Time today": Check In / Check Out, for the employee themselves — on the home
 * page and on their Attendance page.
 *
 * Shows one button, decided by today's row: no row means check in, an open row
 * means check out, a closed one means the day is done. Showing both and
 * disabling one invites somebody to wonder which they need.
 *
 * Punch errors are not handled here. Every failure — outside the fence, a vague
 * GPS reading, blocked permission — arrives as a toast from the global handler
 * in main.jsx, carrying the sentence the server wrote. Repeating that logic in
 * the component is how the two versions drift apart.
 */

/** A punch on the company's clock, as the Attendance page shows it — not the device's. */
function time(iso, timezone) {
  return iso ? wallClockIn(timezone, iso) : null
}

const pad = (n) => String(n).padStart(2, '0')

/** Time at work so far, ticking: 2:05:09. */
function elapsedClock(ms) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/** The same, for a screen reader: "2 hours 5 minutes". */
function spokenDuration(ms) {
  const minutes = Math.floor(ms / 60_000)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return [h > 0 && `${h} hour${h === 1 ? '' : 's'}`, `${m} minute${m === 1 ? '' : 's'}`].filter(Boolean).join(' ')
}


/** `link` adds the way to the Attendance page — not wanted on that page itself. */
export default function PunchCard({ link = true }) {
  const myToday = useMyToday()
  const workplace = useMyWorkplace()
  const canSeeAttendance = useAuthStore((state) => state.can('attendance:read'))
  const shift = workplace.data?.shift ?? null
  // How far this device's clock is from the server's: the time at work is counted
  // on the server's, so a phone minutes out neither freezes nor jumps it.
  const skewMs = myToday.data?.server_now ? Date.parse(myToday.data.server_now) - myToday.dataUpdatedAt : 0

  return (
    <Card
      title="Time today"
      subtitle={shift ? `${shift.name} shift · ${shift.start_time} – ${shift.end_time}` : workplace.isLoading ? ' ' : workplace.isError ? 'Your shift could not be loaded' : 'No shift set'}
      action={link && canSeeAttendance ? <CardLink to="/attendance">Attendance</CardLink> : null}
    >
      {/* Which button to show IS today's row. If it could not be read, the card
          says so — offering Check In to somebody already checked in is a guess. */}
      <DataState query={myToday} compact
        loading={
          <span className="inline-flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-brand-600" />
            <span className="text-gray-500">Loading today…</span>
          </span>
        }>
        {(today) => <Today today={today} workplace={workplace} skewMs={skewMs} />}
      </DataState>
    </Card>
  )
}

/** Today's row — null before the first punch — and the one button it calls for. */
function Today({ today, workplace, skewMs }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const punchIn = usePunchIn()
  const punchOut = usePunchOut()
  const mode = today?.work_mode ?? workplace.data?.work_mode ?? 'office'
  const busy = punchIn.isPending || punchOut.isPending
  const checkedIn = Boolean(today?.check_in)
  const checkedOut = Boolean(today?.check_out)
  // Checked in and not out yet: the time at work ticks by the second (the
  // client watched it for ten minutes and saw nothing move) — read twice a
  // second, so no second is skipped or shown twice. Otherwise the clock only
  // needs the minute.
  const atWork = checkedIn && !checkedOut
  const dayDone = checkedIn && checkedOut
  const tick = useNow(atWork ? 500 : 30_000)
  const now = new Date(tick.getTime() + skewMs)
  // Last night's shift, still open this morning, is the day to check out of (client §34).
  const lastNight = today?.date && today.date !== calendarDayIn(timezone)

  const clock = wallClockIn(timezone, isoInstant(now))
  // From the instants, not the wall clock: right across midnight, for a night shift too.
  const atWorkMs = atWork ? Math.max(0, now.getTime() - Date.parse(today.check_in)) : null
  const stayedMs = dayDone ? Math.max(0, Date.parse(today.check_out) - Date.parse(today.check_in)) : null
  // The hours the server stored at check-out (the payslip's, two decimals), and
  // the same in whole minutes read as formatHours reads them — 7.18 is 7h 11m on
  // the screen, so it is "7 hours 11 minutes" to a screen reader too.
  const workedHours = dayDone ? (today.hours_worked ?? Math.round(stayedMs / 36_000) / 100) : null
  const workedMs = dayDone ? (Math.floor(workedHours) * 60 + Math.round((workedHours - Math.floor(workedHours)) * 60)) * 60_000 : null
  // The unpaid break the day's own shift takes off the time at work when it
  // closes — the server's figure for this day, not today's shift (domain/attendance/hours.ts).
  const breakMinutes = today?.break_minutes ?? 0
  const dayLine = lastNight ? `Shift of ${formatDay(today.date, { year: false })}` : formatDay(calendarDayIn(timezone), { weekday: true })

  // How far to a full day, in words — the one thing the person wants to know
  // while at work that the card did not say. It replaced a coloured line of the
  // day whose every part the card already said in words, which nobody could
  // read (Devesh, 9 Oct 2026). The hours a full day needs are the server's: the
  // day's own shift, halved on a half day of leave. "To go" is the time still to
  // stay, the unpaid break included (it comes off at check-out, as the note
  // below says) — so it falls from the first minute, never sits still through
  // the break. Nothing with no shift.
  const fullDayMinutes = atWork && today.full_day_hours != null ? Math.round(today.full_day_hours * 60) : null
  const toGo = fullDayMinutes == null ? null : fullDayMinutes + breakMinutes - Math.floor(atWorkMs / 60_000)

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {/* The big figure is what the person wants at a glance: the clock before
            they check in, the time at work while they are in, the hours worked
            once they are out (client, 8 Oct 2026). */}
        <div>
          {atWork ? (
            <>
              <p role="timer" className="text-[34px] leading-none font-extrabold tracking-tight text-gray-900 tabular-nums" aria-label={`At work for ${spokenDuration(atWorkMs)}`}>
                {elapsedClock(atWorkMs)}
              </p>
              <p className="text-xs text-gray-500 mt-1.5">
                <b className="text-gray-900">At work</b> since {time(today.check_in, timezone)} · {dayLine} · now {clock}
              </p>
            </>
          ) : dayDone ? (
            <>
              <p className="text-[34px] leading-none font-extrabold tracking-tight text-gray-900 tabular-nums">
                <span className="sr-only">Worked {spokenDuration(workedMs)}</span>
                <span aria-hidden="true">{formatHours(workedHours)}</span>
              </p>
              <p className="text-xs text-gray-500 mt-1.5">
                <b className="text-gray-900">Worked</b>{lastNight ? '' : ' today'} · at work {time(today.check_in, timezone)} – {time(today.check_out, timezone)}
                {breakMinutes > 0 && today.hours_worked != null ? `, less a ${minutesLabel(breakMinutes)} unpaid break` : ''}
              </p>
            </>
          ) : (
            <>
              <p className="text-[34px] leading-none font-extrabold tracking-tight text-gray-900 tabular-nums" aria-label={`The time is ${clock}`}>{clock}</p>
              <p className="text-xs text-gray-500 mt-1.5">{dayLine}</p>
            </>
          )}
        </div>

        {!checkedIn && (
          <button onClick={() => punchIn.mutate()} disabled={busy} className={btn.gradient}>
            {punchIn.isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {/* Reading the GPS takes a few seconds, and saying so stops people from tapping again. */}
                {workplace.data?.location_needed === false ? 'Checking in…' : 'Checking your location…'}
              </>
            ) : (
              <><LogIn className="w-4 h-4" />Check In</>
            )}
          </button>
        )}
        {checkedIn && !checkedOut && (
          <button onClick={() => punchOut.mutate()} disabled={busy} className={btn.primary}>
            {punchOut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
            Check Out
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {!checkedIn && <Chip tone="gray">Not checked in yet</Chip>}
        {checkedIn && <Chip tone={today.late_minutes > 0 ? 'warn' : 'ok'}>Checked in at {time(today.check_in, timezone)}{today.late_minutes > 0 ? '' : ' · on time'}</Chip>}
        {checkedOut && <Chip tone="brand">Checked out at {time(today.check_out, timezone)}</Chip>}
        {today?.status && today.status !== 'present' && <Chip tone="info" dot={false}><span className="capitalize">{today.status.replace('_', ' ')}</span></Chip>}
      </div>

      {toGo != null && (toGo > 0 ? (
        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-brand-50 border border-brand-100">
          <Flag className="w-4 h-4 text-brand-600 shrink-0" aria-hidden="true" />
          <span className="text-sm text-gray-700">
            Full day at <b className="text-gray-900">{minutesLabel(fullDayMinutes)}</b> · <b className="text-gray-900">{minutesLabel(toGo)}</b> to go
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-50 border border-emerald-100">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
          <span className="text-sm font-semibold text-emerald-800">Full day done</span>
        </div>
      ))}

      {/*
        The hours the client asked to see — "jitne ghante usne work kiya vo
        dikhe" — are the big figure once checked out: the server's, computed
        and stored at check-out, so this and the payslip cannot disagree. While
        at work, the break that will come off them is said up front.
      */}
      {atWork && breakMinutes > 0 && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-gray-50 border border-gray-100">
          <Clock className="w-4 h-4 text-gray-400 shrink-0" />
          <span className="text-sm text-gray-700">
            Your {minutesLabel(breakMinutes)} unpaid break is taken off when you check out.
          </span>
        </div>
      )}

      {/* Against the shift (client §34–35): late past the grace, and overtime to claim once checked out. */}
      {today?.late_minutes > 0 && (
        <p className="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          Checked in {minutesLabel(today.late_minutes)} after your shift started.
        </p>
      )}
      {checkedOut && today?.overtime_minutes > 0 && workplace.data?.overtime_enabled && (
        <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
          {minutesLabel(today.overtime_minutes)} of overtime recorded today.{' '}
          <Link to={`/requests?new=overtime&date=${today.date}`} className="font-semibold underline">Claim it</Link> — it is paid once approved.
        </p>
      )}

      {/* Away from the office today (client §32–33): said, so nobody wonders why no location is asked. */}
      {mode !== 'office' && (
        <p className="text-xs font-medium text-sky-800 bg-sky-50 border border-sky-100 rounded-lg px-3 py-2">
          {WORK_MODES[mode]} today{workplace.data && !workplace.data.location_needed && !checkedIn ? ' — no office location needed to check in' : ''}
        </p>
      )}

      {today?.geofence?.verified && (
        <div className="flex items-center gap-2 text-xs text-emerald-700">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>
            Location confirmed
            {today.geofence.distance_meters != null && ` — ${today.geofence.distance_meters} m from the office`}
          </span>
        </div>
      )}

      {dayDone && (
        <p className="text-sm text-gray-500 text-center">Your day is recorded. See you tomorrow.</p>
      )}

      {!checkedIn && mode === 'office' && (
        <details className="group text-xs text-gray-500">
          <summary className="flex items-center gap-1.5 cursor-pointer list-none select-none hover:text-gray-700">
            <MapPin className="w-3.5 h-3.5 shrink-0" />
            Your location is checked when you check in
            <span className="text-brand-600 font-semibold group-open:hidden">· more</span>
          </summary>
          <p className="mt-1.5 pl-5">
            Allow location access, and stay near your desk — a reading from outside the office, or one your phone is unsure about, will be refused.
          </p>
        </details>
      )}
    </div>
  )
}
