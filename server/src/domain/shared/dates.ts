/**
 * Dates, in the company's timezone.
 *
 * NOTHING ELSE IN THE SYSTEM MAY CALL toISOString() TO GET A CALENDAR DAY, and
 * this file is why. The server runs in UTC. An employee punching in at 9am in
 * Pune is doing so at 03:30 UTC — same day, no problem. One punching out at
 * 11:30pm is doing so at 18:00 UTC, also fine. But a night-shift punch at
 * 12:30am IST is 19:00 UTC THE PREVIOUS DAY, and `new Date().toISOString()`
 * would file it under yesterday.
 *
 * That bug is invisible for months. It shows up as one employee whose hours
 * never add up, and it is blamed on them before it is blamed on the code.
 *
 * So every calendar day in this system comes from here, with the organization's
 * timezone passed in explicitly. There is no default and no machine clock.
 *
 * This module imports NOTHING. It is pure arithmetic over values it is given,
 * which is what makes it testable without a database, a request or a clock.
 */

/** A calendar day as YYYY-MM-DD. Not a Date — a Date is an instant. */
export type CalendarDate = string

/**
 * Which calendar day `instant` falls on, in `timezone`.
 *
 * Uses Intl rather than arithmetic on offsets, because offsets change: India
 * does not observe daylight saving but the client's UK payslips will, and a
 * hardcoded +05:30 would be wrong twice a year for anyone outside India.
 */
export function zonedToday(instant: Date, timezone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * The wall-clock time in `timezone`, as minutes since midnight.
 *
 * Used to compare a punch against a shift's start and end, which are stored as
 * wall-clock labels like "09:30" and have no timezone of their own.
 */
export function zonedMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant)

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return get('hour') * 60 + get('minute')
}

/**
 * The instant a calendar day begins in `timezone` — where "from 1 October" in a
 * company's own clock starts on the server's. 1 Oct 2026 in Kolkata begins at
 * 18:30 UTC on 30 Sep.
 *
 * The offset is read at the guessed instant and then again at the answer, so a
 * zone that changed its clocks in between (a UK October) still lands on its
 * midnight.
 */
export function zonedDayStart(day: CalendarDate, timezone: string): Date {
  const utcMidnight = Date.parse(`${day}T00:00:00.000Z`)
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant))
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    return wall - Math.floor(instant / 1000) * 1000
  }
  const first = utcMidnight - offsetAt(utcMidnight)
  return new Date(utcMidnight - offsetAt(first))
}

/**
 * An instant on the company's clock, as a spreadsheet sorts it:
 * "2026-09-30 14:05:12". For exports; the browser formats its own.
 */
export function zonedDateTime(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

/** "09:30" to 570. Returns null for anything that is not a wall-clock label. */
export function parseWallClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null

  return hours * 60 + minutes
}

/** A calendar day as a UTC midnight Date, which is how @db.Date round-trips. */
export function toDateColumn(day: CalendarDate): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

/**
 * The inverse. A @db.Date comes back as UTC midnight; this reads the label off
 * it. A column with no date gives null, so a serializer never needs its own.
 */
export function fromDateColumn(value: Date): CalendarDate
export function fromDateColumn(value: Date | null | undefined): CalendarDate | null
export function fromDateColumn(value: Date | null | undefined): CalendarDate | null {
  return value ? value.toISOString().slice(0, 10) : null
}

/**
 * A moment as the API sends it: ISO 8601 in UTC, "2026-09-14T04:01:00.000Z".
 *
 * Right for an instant — a punch, an approval, when a link expires — and wrong
 * for a calendar day, which is what fromDateColumn and zonedToday are for. The
 * browser turns it back into the company's clock time. Null stays null.
 */
export function isoInstant(value: Date): string
export function isoInstant(value: Date | null | undefined): string | null
export function isoInstant(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

/** True only if the calendar actually has this day. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * A calendar day moved by whole days — the day before a raise takes effect, the
 * end of a notice period. Pure calendar arithmetic, done in UTC where there is
 * no daylight saving to shift the answer.
 */
export function addCalendarDays(day: CalendarDate, days: number): CalendarDate {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The Monday of the week `day` falls in — a week here runs Monday to Sunday. */
export function mondayOf(day: CalendarDate): CalendarDate {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/** A month as a key: 2026, 9 → "2026-09". Sorts as a string. */
export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

/** A month as people say it: 2026, 9 → "September 2026". */
export function monthName(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? month} ${year}`
}

/** A day as people write it: "2026-10-01" → "1 Oct 2026". For messages, not for storage. */
export function dayLabel(day: CalendarDate): string {
  const month = MONTH_NAMES[Number(day.slice(5, 7)) - 1]
  return `${Number(day.slice(8, 10))} ${month ? month.slice(0, 3) : day.slice(5, 7)} ${day.slice(0, 4)}`
}

/** The month a calendar day falls in. */
export function monthOfDay(day: CalendarDate): { year: number; month: number } {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) }
}

/** Every month from one day's to another's, inclusive, in order. */
export function monthsBetween(from: CalendarDate, to: CalendarDate): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = []
  let { year, month } = monthOfDay(from)
  const end = monthOfDay(to)
  while (year < end.year || (year === end.year && month <= end.month)) {
    out.push({ year, month })
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}
