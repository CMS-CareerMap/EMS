import { LogIn, LogOut, Loader2, MapPin, CheckCircle2, Clock } from 'lucide-react'
import { useMyToday, usePunchIn, usePunchOut } from '../../hooks/usePunch'
import DataState from '../../components/DataState'
import { useAuthStore } from '../../stores/authStore'
import { wallClockIn } from '../../lib/dates'

/**
 * Check In / Check Out, for the employee themselves.
 *
 * Shows one button, decided by today's row: no row means check in, an open row
 * means check out, a closed one means the day is done. Showing both and
 * disabling one invites somebody to wonder which they need.
 *
 * Punch errors are not handled here. Every failure — outside the fence, a vague GPS
 * reading, blocked permission — arrives as a toast from the global handler in
 * main.jsx, carrying the sentence the server wrote. Repeating that logic in the
 * component is how the two versions drift apart.
 */

/** A punch on the company's clock, as the Attendance page shows it — not the device's. */
function time(iso, timezone) {
  return iso ? wallClockIn(timezone, iso) : null
}

export default function PunchCard() {
  const myToday = useMyToday()
  const punchIn = usePunchIn()
  const punchOut = usePunchOut()

  // Which button to show IS today's row. If it could not be read, the card
  // says so — offering Check In to somebody already checked in is a guess.
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
      <DataState query={myToday} compact
        loading={
          <span className="inline-flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
            <span className="text-gray-500">Loading today…</span>
          </span>
        }>
        {(today) => <Today today={today} punchIn={punchIn} punchOut={punchOut} />}
      </DataState>
    </div>
  )
}

/** Today's row — null before the first punch — and the one button it calls for. */
function Today({ today, punchIn, punchOut }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const busy = punchIn.isPending || punchOut.isPending
  const checkedIn = Boolean(today?.check_in)
  const checkedOut = Boolean(today?.check_out)

  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Today</h3>
        {today?.status && (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 capitalize">
            {today.status.replace('_', ' ')}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <p className="text-xs text-gray-400">Check in</p>
          <p className="text-2xl font-bold text-gray-900">{time(today?.check_in, timezone) ?? '—'}</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-gray-400">Check out</p>
          <p className="text-2xl font-bold text-gray-900">{time(today?.check_out, timezone) ?? '—'}</p>
        </div>
      </div>

      {/*
        The hours the client explicitly asked to see — "jitne ghante usne work
        kiya vo dikhe". Computed and stored by the server at check-out, not
        recalculated here, so this figure and the payslip cannot disagree.
      */}
      {today?.hours_worked != null && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 border border-gray-200">
          <Clock className="w-4 h-4 text-gray-400 shrink-0" />
          <span className="text-sm text-gray-700">
            <strong className="text-gray-900">{today.hours_worked}</strong> hours worked today
          </span>
        </div>
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

      {!checkedIn && (
        <button
          onClick={() => punchIn.mutate()}
          disabled={busy}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
        >
          {punchIn.isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {/* Reading the GPS takes a few seconds, and saying so stops
                  people from tapping again. */}
              Checking your location…
            </>
          ) : (
            <>
              <LogIn className="w-4 h-4" />
              Check In
            </>
          )}
        </button>
      )}

      {checkedIn && !checkedOut && (
        <button
          onClick={() => punchOut.mutate()}
          disabled={busy}
          className="w-full bg-gray-900 hover:bg-gray-800 disabled:bg-gray-400 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
        >
          {punchOut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
          Check Out
        </button>
      )}

      {checkedOut && (
        <p className="text-sm text-gray-500 text-center py-1">Your day is recorded. See you tomorrow.</p>
      )}

      {!checkedIn && (
        <p className="text-xs text-gray-400 flex items-start gap-1.5">
          <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Your location is checked when you check in. Allow location access, and stay near your
            desk — a reading from outside the office, or one your phone is unsure about, will be
            refused.
          </span>
        </p>
      )}
    </>
  )
}
