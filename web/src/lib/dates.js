/**
 * Calendar days, in the COMPANY's time zone.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, and India is five
 * and a half hours ahead of UTC — so from midnight until 05:30 every screen
 * that used it showed yesterday as "today". Attendance marked in that window
 * landed on the wrong day, and a leave calendar opened at 1 a.m. greyed out
 * the day it actually was.
 *
 * The same answer the server's `zonedToday` gives, from the same zone the
 * session carries.
 */

/**
 * YYYY-MM-DD for the given instant, as a calendar in `timeZone` reads it.
 * Before a session has loaded there is no company zone yet; the browser's own
 * is then the best available answer, rather than a city written in here.
 */
export function calendarDayIn(timeZone, instant = new Date()) {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape wanted.
  return new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/**
 * A calendar day moved by whole days. Pure calendar arithmetic, done in UTC
 * where there is no daylight saving and no zone to shift the answer.
 */
export function addDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * "09:31" for an instant, on the company's clock.
 *
 * The server sends check-in and check-out as instants. Shown raw they read as
 * "2026-09-14T04:01:00.000Z"; sent back to the server as-is they fail the
 * HH:MM check, so editing a row that already had times could never be saved.
 */
export function wallClockIn(timeZone, iso) {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-GB', {
    ...(timeZone ? { timeZone } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

/**
 * A moment as the API exchanges it: ISO 8601 in UTC. Right for WHEN something
 * happened — a verification, a payroll step — and wrong for WHICH DAY, which is
 * calendarDayIn's job. The only other place toISOString() is allowed.
 */
export function isoInstant(instant = new Date()) {
  return instant.toISOString()
}

/** "Monday, 14 September 2026" for a calendar day, whatever zone the browser is in. */
export function formatCalendarDay(day) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
