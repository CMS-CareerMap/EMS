import { addCalendarDays, monthKey, type CalendarDate } from '../shared/dates'

/**
 * One person's month "so far" (client, 15 Oct 2026): opened on the 15th, the
 * 1st to the 15th — the days they were here to be counted, and what each was.
 * Pure: the month, today, their days and the company's days off in, the
 * figures out — the ONE count behind their own Attendance page, the page a
 * manager or HR opens for them, and their home page's "My month", so the
 * three never disagree.
 *
 * The window: from the 1st (or the day they joined) to today (or the month's
 * end, or their last day), whichever is first. A month not begun yet, or one
 * they were not employed in, counts nothing.
 */

export interface SoFarRow {
  date: CalendarDate
  status: string | null
  hoursWorked: number | null
  lateMinutes: number | null
  /** Whether the day has a check-in at all. */
  checkedIn: boolean
  /**
   * Typed by HR. Its form fills in a check-in by itself, so "present, a check-in,
   * no check-out" is as HR left it — not a check-out forgotten (as the roster's
   * No out reads it).
   */
  manual?: boolean
}

export interface SoFarDayOff {
  date: CalendarDate
  kind: 'holiday' | 'weekly_off'
}

export interface SoFarInput {
  year: number
  month: number
  today: CalendarDate
  joined: CalendarDate | null
  left: CalendarDate | null
  daysOff: readonly SoFarDayOff[]
  rows: readonly SoFarRow[]
  /** Their shift's hours a day, for the hours expected of the days they worked. Null with no shift. */
  expectedPerDay: number | null
  /** The day they are still at work on, if any — a night shift's is yesterday's past midnight: not a check-out missed. */
  openDay?: CalendarDate | null
}

export interface MonthSoFar {
  /** The days counted; null when there is nothing to count yet. */
  from: CalendarDate | null
  to: CalendarDate | null
  /** The window ends today: the month is still running. */
  ongoing: boolean
  /** Days in the window that are not a holiday or a weekly off. */
  workingDays: number
  present: number
  halfDays: number
  absent: number
  onLeave: number
  /** Working days already past with nothing recorded — not absent: nobody has said. */
  notMarked: number
  weeklyOffs: number
  holidays: number
  /** Hours of the days closed, two decimals — today's open day is added live by the page. */
  hoursWorked: number
  /**
   * What the shift expects of the days present whose hours are known (a half
   * day half). A day checked into and never out has no hours, so it expects
   * none either (25 Oct 2026: "16h 54m of 27h" counted such a day's nine
   * hours against none worked). Null with no shift.
   */
  expectedHours: number | null
  /** Days gone by checked into and never out: no hours, so left out of the hours and of what was expected. */
  withoutCheckOut: number
  daysWorked: number
  averageHours: number | null
  /** Days checked into, and of them the late ones. */
  arrivals: number
  lateDays: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

function lastDayOf(year: number, month: number): CalendarDate {
  return `${monthKey(year, month)}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`
}

export function monthSoFar(input: SoFarInput): MonthSoFar {
  const monthStart: CalendarDate = `${monthKey(input.year, input.month)}-01`
  const monthEnd = lastDayOf(input.year, input.month)
  const from = input.joined && input.joined > monthStart ? input.joined : monthStart
  const ends = [monthEnd, input.today, ...(input.left ? [input.left] : [])].sort()
  const to = ends[0]!

  const empty: MonthSoFar = {
    from: null, to: null, ongoing: false, workingDays: 0, present: 0, halfDays: 0, absent: 0, onLeave: 0, notMarked: 0,
    weeklyOffs: 0, holidays: 0, hoursWorked: 0, expectedHours: input.expectedPerDay === null ? null : 0, withoutCheckOut: 0, daysWorked: 0, averageHours: null, arrivals: 0, lateDays: 0,
  }
  if (from > to) return empty

  const offOn = new Map(input.daysOff.map((d) => [d.date, d.kind]))
  const rowOn = new Map(input.rows.map((r) => [r.date, r]))
  const result = { ...empty, from, to, ongoing: to === input.today }
  let hours = 0
  // Days the shift's hours are expected of: a day present, a half day half — once its hours are known, as they are counted.
  let expectedDays = 0

  for (let day = from; day <= to; day = addCalendarDays(day, 1)) {
    const row = rowOn.get(day)
    // The company's day off — or one marked for this person alone, which payroll pays as a day off too.
    const off = offOn.get(day) ?? (row?.status === 'holiday' || row?.status === 'weekly_off' ? row.status : undefined)
    if (off === 'holiday') result.holidays++
    else if (off === 'weekly_off') result.weeklyOffs++
    else result.workingDays++

    switch (row?.status) {
      case 'present': result.present++; break
      case 'half_day': result.halfDays++; break
      case 'absent': result.absent++; break
      case 'on_leave': result.onLeave++; break
      default:
        // Nothing said of a working day already over: not marked. Today is not over.
        if (!off && day < input.today && !row?.checkedIn) result.notMarked++
    }
    if (row?.hoursWorked != null && row.hoursWorked > 0) {
      hours += row.hoursWorked
      result.daysWorked++
    }
    const worked = row?.status === 'present' ? 1 : row?.status === 'half_day' ? 0.5 : 0
    if (worked > 0 && row?.hoursWorked != null) expectedDays += worked
    // In and never out on a day gone by: no hours to count — said, rather than counted as nothing worked.
    else if (worked > 0 && row?.checkedIn && !row.manual && day < input.today && day !== input.openDay) result.withoutCheckOut++
    if (row?.checkedIn) {
      result.arrivals++
      if ((row.lateMinutes ?? 0) > 0) result.lateDays++
    }
  }

  result.hoursWorked = round2(hours)
  result.averageHours = result.daysWorked ? round2(hours / result.daysWorked) : null
  result.expectedHours = input.expectedPerDay === null ? null : round2(input.expectedPerDay * expectedDays)
  return result
}
