import { Link } from 'react-router-dom'
import { LogIn, LogOut, Loader2, MapPin, CheckCircle2, Clock } from 'lucide-react'
import { useMyToday, useMyWorkplace, usePunchIn, usePunchOut } from '../../hooks/usePunch'
import { useNow } from '../../hooks/useNow'
import { WORK_MODES, minutesLabel } from '../../lib/requests'
import DataState from '../../components/DataState'
import { Card, CardLink, Chip } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
import { useAuthStore } from '../../stores/authStore'
import { calendarDayIn, formatDay, isoInstant, wallClockIn } from '../../lib/dates'

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

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

/** `link` adds the way to the Attendance page — not wanted on that page itself. */
export default function PunchCard({ link = true }) {
  const myToday = useMyToday()
  const workplace = useMyWorkplace()
  const canSeeAttendance = useAuthStore((state) => state.can('attendance:read'))
  const shift = workplace.data?.shift ?? null

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
        {(today) => <Today today={today} workplace={workplace} shift={shift} />}
      </DataState>
    </Card>
  )
}

/** Today's row — null before the first punch — and the one button it calls for. */
function Today({ today, workplace, shift }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const punchIn = usePunchIn()
  const punchOut = usePunchOut()
  const now = useNow()
  const mode = today?.work_mode ?? workplace.data?.work_mode ?? 'office'
  const busy = punchIn.isPending || punchOut.isPending
  const checkedIn = Boolean(today?.check_in)
  const checkedOut = Boolean(today?.check_out)
  // Last night's shift, still open this morning, is the day to check out of (client §34).
  const lastNight = today?.date && today.date !== calendarDayIn(timezone)

  const clock = wallClockIn(timezone, isoInstant(now))
  const nowMinutes = toMinutes(clock)
  const inMinutes = checkedIn ? toMinutes(time(today.check_in, timezone)) : null
  const outMinutes = checkedOut ? toMinutes(time(today.check_out, timezone)) : null
  const sofar = checkedIn && !checkedOut && !lastNight && nowMinutes >= inMinutes ? nowMinutes - inMinutes : null

  // The day's line, from two hours before the shift to two after (08:00–20:00 with none).
  const from = shift ? Math.max(0, toMinutes(shift.start_time) - 120) : 8 * 60
  const until = shift ? Math.min(24 * 60, toMinutes(shift.end_time) + 120) : 20 * 60
  const span = Math.max(60, until - from)
  const at = (m) => `${Math.min(100, Math.max(0, ((m - from) / span) * 100))}%`
  const overnight = shift && toMinutes(shift.end_time) <= toMinutes(shift.start_time)

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[34px] leading-none font-extrabold tracking-tight text-gray-900 tabular-nums" aria-label={`The time is ${clock}`}>{clock}</p>
          <p className="text-xs text-gray-500 mt-1.5">
            {lastNight ? `Shift of ${formatDay(today.date, { year: false })}` : formatDay(calendarDayIn(timezone), { weekday: true })}
            {sofar !== null && <> · <b className="text-gray-900">{minutesLabel(sofar)}</b> so far</>}
          </p>
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

      {/* The day at a glance: the shift, and the time worked so far. */}
      {!overnight && (
        <div aria-hidden="true">
          <div className="relative h-2.5 rounded-full bg-gray-100 overflow-hidden">
            {shift && <span className="absolute inset-y-0 rounded-full bg-brand-100" style={{ left: at(toMinutes(shift.start_time)), width: `calc(${at(toMinutes(shift.end_time))} - ${at(toMinutes(shift.start_time))})` }} />}
            {inMinutes !== null && !lastNight && (
              <span className="absolute inset-y-0 rounded-full bg-logo" style={{ left: at(inMinutes), width: `calc(${at(outMinutes ?? nowMinutes)} - ${at(inMinutes)})` }} />
            )}
            {!lastNight && <span className="absolute -inset-y-0.5 w-0.5 rounded bg-gray-900" style={{ left: at(nowMinutes) }} />}
          </div>
          <div className="flex justify-between mt-1 text-[11px] font-semibold text-gray-400 tabular-nums">
            <span>{String(Math.floor(from / 60)).padStart(2, '0')}:00</span>
            {shift && <span>Shift {shift.start_time} – {shift.end_time}</span>}
            <span>{String(Math.floor(until / 60) % 24).padStart(2, '0')}:00</span>
          </div>
        </div>
      )}

      {/*
        The hours the client explicitly asked to see — "jitne ghante usne work
        kiya vo dikhe". Computed and stored by the server at check-out, not
        recalculated here, so this figure and the payslip cannot disagree.
      */}
      {today?.hours_worked != null && (
        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-gray-50 border border-gray-100">
          <Clock className="w-4 h-4 text-gray-400 shrink-0" />
          <span className="text-sm text-gray-700">
            <strong className="text-gray-900">{today.hours_worked}</strong> hours worked{lastNight ? '' : ' today'}
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

      {checkedOut && (
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
