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

/** A punch's signs it may not be what it seems (server: domain/attendance/punchSignals.ts), in words. */
export const PUNCH_FLAG_WORDS = {
  frozen_readings: 'Every reading exactly the same — a real phone’s location moves a little',
  repeated_spot: 'The very same point as an earlier day, to the last digit',
  too_precise: 'More precise than a phone indoors manages',
  stale_reading: 'The reading’s time was far from the server’s',
  not_a_phone: 'From a computer, not a phone',
  new_device: 'From a phone not used in the last two months',
  repeated_photo: 'The very same photo as an earlier punch — a camera never gives the same one twice',
  mac_with_touch: 'An iPad — or a computer claiming a touch screen',
  location_vague: 'The location was too vague to say where (over 100 m) — precise location may be off on the phone',
}

/**
 * How an app punch is proved (client, 14 Oct 2026; the server's
 * domain/attendance/punchMethod.ts): the Super Admin's one choice — never
 * none. `steps` is what a check-in asks for, in order; `strength` is said
 * beside it, honestly. Only Location checks the office (`fence`); Location +
 * Selfie reads the location wherever the person is — one of several
 * warehouses — and keeps it with the photo, for HR to see on the map.
 */
export const PUNCH_METHODS = {
  location: {
    label: 'Location',
    needs: { location: true, fence: true, selfie: false },
    steps: [{ icon: 'location', text: 'Inside the office radius, from a phone' }],
    strength: { label: 'Medium', tone: 'warn' },
    said: 'Check-in only inside the office saved below. A fake-location app is not caught by itself: the machine’s file and the flags help.',
  },
  selfie: {
    label: 'Selfie',
    needs: { location: false, fence: false, selfie: true },
    steps: [{ icon: 'camera', text: 'A live photo from the front camera' }],
    strength: { label: 'Low', tone: 'bad' },
    said: 'A photo from anywhere — no office location. The room behind the person is the only proof of where they were.',
  },
  location_selfie: {
    label: 'Location + Selfie',
    needs: { location: true, fence: false, selfie: true },
    steps: [
      { icon: 'location', text: 'Their current location, wherever they are, from a phone' },
      { icon: 'camera', text: 'Then a live photo from the front camera' },
    ],
    strength: { label: 'Good', tone: 'brand' },
    said: 'For several sites — no office needed. Their current location first (no location, no camera), then the photo: both kept, and HR sees where on the map. Nothing is refused for where they stand.',
  },
}

/** A map of where a punch was taken — Google Maps, in a new tab. */
export const mapLink = (latitude, longitude) => `https://www.google.com/maps?q=${latitude},${longitude}`

/** What a method asks of the phone; null for one this page does not know. */
export const methodNeeds = (method) => PUNCH_METHODS[method]?.needs ?? null

/** Why a punch was refused, in words — with how far, when it was the fence. */
export function refusalWords(punch) {
  if (punch.refused_for === 'outside') return `refused — ${punch.distance_meters} m from the office`
  if (punch.refused_for === 'unreliable') return `refused — the location was too vague (about ${punch.accuracy_meters} m)`
  if (punch.refused_for === 'not_phone') return 'refused — from a computer'
  if (punch.refused_for === 'device_waiting') return 'refused — from a phone not approved for them'
  if (punch.refused_for === 'no_photo') return 'refused — no photo was taken'
  return null
}

/** "Android · Chrome" from a browser's description of itself — enough to tell one phone from another. */
export function shortDevice(userAgent) {
  if (!userAgent) return null
  const os = /iPhone|iPad/.test(userAgent) ? 'iPhone/iPad' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Mac OS X|Macintosh/.test(userAgent) ? 'Mac' : /Linux/.test(userAgent) ? 'Linux' : 'Unknown'
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /SamsungBrowser/.test(userAgent) ? 'Samsung Internet' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'a browser'
  return `${os} · ${browser}`
}

/**
 * The fingerprint machine's word on an app day (client, 11 Oct 2026), as a
 * chip: confirmed, its times differ, not on it, or the day filled from it.
 * Null: not matched yet — no chip.
 */
export const MACHINE_MATCH = {
  confirmed: { label: 'Machine ✓', tone: 'ok', said: 'Confirmed by the fingerprint machine' },
  time_differs: { label: 'Machine: time differs', tone: 'warn', said: 'On the machine, at a time further from the app’s than allowed' },
  not_on_machine: { label: 'Not on machine', tone: 'bad', said: 'Checked in on the app, with no scan on the machine that day' },
  from_machine: { label: 'From machine', tone: 'gray', said: 'No app punch: the day is the machine’s' },
}

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

/**
 * How far the server's clock is ahead of this device's, in ms, from a month
 * answer (`server_now`, `received_at`): today's time so far is counted by the
 * server's clock, so a phone minutes out neither adds nor takes away.
 */
export const serverSkew = (d) => (d?.server_now && d?.received_at ? Date.parse(d.server_now) - d.received_at : 0)

/** The day somebody is still at work on, from a month answer: { day, since } — today's, or a night shift's past midnight — or null. */
export const openOf = (d) => (d?.totals?.open_since && d.totals.open_day ? { day: d.totals.open_day, since: d.totals.open_since } : null)

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
