/**
 * Attendance in the words and colours every screen uses — the roster, the
 * calendar, the log.
 *
 * The statuses the server has — no more, no fewer. Working from home is not a
 * status (it is an approved request, shown beside the check-in as the day's
 * work mode), and "late" is a measure of a present day, not a status.
 */
export const STATUS = {
  present: { label: 'Present', tone: 'ok', cell: 'bg-emerald-50 text-emerald-800 border-emerald-100', dot: 'bg-emerald-500' },
  half_day: { label: 'Half Day', tone: 'brand', cell: 'bg-violet-50 text-violet-800 border-violet-100', dot: 'bg-violet-500' },
  absent: { label: 'Absent', tone: 'bad', cell: 'bg-red-50 text-red-700 border-red-100', dot: 'bg-red-500' },
  on_leave: { label: 'On Leave', tone: 'leave', cell: 'bg-pink-50 text-pink-800 border-pink-100', dot: 'bg-pink-500' },
  holiday: { label: 'Holiday', tone: 'warn', cell: 'bg-orange-50 text-orange-800 border-orange-100', dot: 'bg-orange-400' },
  weekly_off: { label: 'Weekly Off', tone: 'gray', cell: 'bg-gray-100 text-gray-500 border-gray-200', dot: 'bg-gray-400' },
}

export const statusMeta = (status) => STATUS[status] ?? null

/** The stored figure, from the server — never recomputed here from two clock times. */
export function formatHours(hours) {
  if (hours == null) return '—'
  const whole = Math.floor(hours)
  const minutes = Math.round((hours - whole) * 60)
  return `${whole}h ${minutes}m`
}

/**
 * How far this device's clock is from the server's, from an answer that
 * carries `server_now` and the moment it arrived (a query's dataUpdatedAt).
 * Added to the device's time, it gives the server's: a computer minutes out
 * neither freezes nor jumps the time at work.
 */
export const clockSkew = (serverNow, receivedAt) => (serverNow && receivedAt ? Date.parse(serverNow) - receivedAt : 0)

/**
 * Time at work so far — before check-out, while the stored hours are still to
 * come — in the same shape as the stored figure: "1h 5m". Whole minutes gone
 * by, never rounded up: a minute shows once it has passed (client, 9 Oct 2026).
 */
export function soFarLabel(ms) {
  return formatHours(Math.floor(Math.max(0, ms) / 60_000) / 60)
}

/** "09:30" → 570. */
export const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Monday first, as the calendar draws a week — the server's numbers, Sunday 0. */
export const WEEK_MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0]

/** The days of a month, "2026-10-01" … "2026-10-31". */
export function daysOfMonth(year, month) {
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, '0')
  return Array.from({ length: count }, (_, i) => `${year}-${mm}-${String(i + 1).padStart(2, '0')}`)
}

export const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay()

/** "October 2026". */
export const monthLabel = (year, month) =>
  new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** One month on or back, as "YYYY-MM". */
export function shiftMonth(key, by) {
  const [y, m] = key.split('-').map(Number)
  const index = y * 12 + (m - 1) + by
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** A day of unpaid leave (Loss of Pay) in the calendar: amber, the colour unpaid leave has everywhere. */
export const UNPAID_LEAVE = { label: 'Unpaid leave', tone: 'warn', cell: 'bg-amber-50 text-amber-900 border-amber-200', dot: 'bg-amber-500' }

/**
 * The pay-days answer by date: each day of approved leave (its type, paid or
 * not, half or whole), and each absent day (leave applied for it, or whether
 * it still can be). Empty maps while it loads or if it failed: the days then
 * read as they always did.
 */
export function payDayMaps(data) {
  return {
    leaveOn: new Map((data?.leave_days ?? []).map((l) => [l.date, l])),
    absentOn: new Map((data?.absent_days ?? []).map((a) => [a.date, a])),
  }
}

/** A leave day's words: its type, "(half)" for half a day — said only where a type allows halves and one was taken. */
export const leaveWords = (leave) => `${leave.leave_type_name}${leave.portion === 0.5 ? ' (half)' : ''}`

/**
 * What one of one's own days was, in a word and a tone — from its row, the
 * company's days off, and whether it is today. `leave` is the day's approved
 * leave, when known (the pay-days answer): an on-leave day then says which —
 * "Casual Leave", or "Loss of Pay" in the unpaid colour.
 */
export function dayState({ date, row, dayOff, today, leave = null }) {
  const status = row?.status
  if (status === 'on_leave') return leave ? { label: leaveWords(leave), tone: leave.paid ? 'leave' : 'warn' } : { label: 'On leave', tone: 'leave' }
  if (status === 'absent') return { label: 'Absent', tone: 'bad' }
  if (status === 'holiday') return { label: dayOff?.name ?? 'Holiday', tone: 'warn' }
  if (status === 'weekly_off') return { label: 'Weekly off', tone: 'gray' }
  if (row?.check_in && !row.check_out) return date === today ? { label: 'Checked in', tone: 'info' } : { label: 'No check-out', tone: 'bad' }
  if (status === 'half_day') return { label: 'Half day', tone: 'brand' }
  if (status === 'present') return { label: 'Present', tone: 'ok' }
  if (dayOff?.kind === 'holiday') return { label: dayOff.name ?? 'Holiday', tone: 'warn' }
  if (dayOff?.kind === 'weekly_off') return { label: 'Weekly off', tone: 'gray' }
  if (date === today) return { label: 'Not checked in yet', tone: 'gray' }
  return { label: 'Not marked', tone: 'gray' }
}
