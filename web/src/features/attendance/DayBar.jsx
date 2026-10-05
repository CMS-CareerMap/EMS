import { toMinutes } from '../../lib/attendance'

const STRIPES = {
  holiday: 'repeating-linear-gradient(135deg, #FED7AA 0 4px, #FFF7ED 4px 8px)',
  weekly_off: 'repeating-linear-gradient(135deg, #E5E1EC 0 4px, #F6F4F9 4px 8px)',
}

/**
 * A day on one line, 08:00 to 20:00: the time from check-in to check-out — or
 * to now, while still checked in. A day off is drawn striped. An overnight day
 * (out before in) shows only where it began.
 */
export default function DayBar({ checkIn, checkOut, nowMinutes = null, off = null, from = 8 * 60, until = 20 * 60 }) {
  if (off) return <div aria-hidden="true" className="h-2 rounded-full" style={{ background: STRIPES[off] ?? STRIPES.weekly_off }} />

  const at = (m) => Math.min(100, Math.max(0, ((m - from) / (until - from)) * 100))
  const start = checkIn ? toMinutes(checkIn) : null
  const end = checkOut ? toMinutes(checkOut) : nowMinutes
  const spans = start !== null && end !== null && end > start

  return (
    <div aria-hidden="true" className="relative h-2 rounded-full bg-gray-100 overflow-hidden">
      {spans && (
        <span className={`absolute inset-y-0 rounded-full bg-logo ${checkOut ? '' : 'opacity-60'}`}
          style={{ left: `${at(start)}%`, width: `${Math.max(1, at(end) - at(start))}%` }} />
      )}
      {start !== null && !spans && <span className="absolute inset-y-0 w-1.5 rounded-full bg-brand-500" style={{ left: `${at(start)}%` }} />}
    </div>
  )
}
