import { workingDays } from '../leave/leaveDays'
import { isWeeklyOff, type WeekInput } from '../shared/workWeek'
import { addCalendarDays } from '../shared/dates'
import type { CalendarDate } from '../shared/dates'

/**
 * The arithmetic the reports share. Pure — every input is passed in.
 *
 * The same `workingDays` that charges leave decides what a working day is
 * here, so a report cannot count Republic Day as a day somebody should have
 * been at work while the leave screen does not.
 */

export interface Calendar {
  /** The working week, day by day (shared/workWeek). */
  weeklyOffDays: WeekInput
  holidays: readonly CalendarDate[]
}

/** The overlap of two inclusive day ranges, or null. */
export function overlap(
  a: { from: CalendarDate; to: CalendarDate },
  b: { from: CalendarDate; to: CalendarDate },
): { from: CalendarDate; to: CalendarDate } | null {
  const from = a.from > b.from ? a.from : b.from
  const to = a.to < b.to ? a.to : b.to
  return from <= to ? { from, to } : null
}

/**
 * Attendance as a share of the days somebody was expected to work and was
 * not on leave: present, and half of each half day, over present + half +
 * absent. Leave, holidays and weekly offs are neither for nor against it.
 * Null when there is nothing to divide by.
 */
export function attendancePercent(present: number, halfDay: number, absent: number): number | null {
  const expected = present + halfDay + absent
  if (expected === 0) return null
  return Math.round(((present + halfDay * 0.5) / expected) * 1000) / 10
}

/**
 * Working days in a window with nothing recorded at all — the days a report
 * must not pass off as present or absent. Days after `upTo` have not happened
 * and are not counted.
 */
export function notMarkedDays(
  window: { from: CalendarDate; to: CalendarDate },
  upTo: CalendarDate,
  calendar: Calendar,
  marked: ReadonlySet<CalendarDate>,
): number {
  const range = overlap(window, { from: window.from, to: upTo })
  if (!range) return 0
  const { breakdown } = workingDays({ from: range.from, to: range.to, weeklyOffDays: calendar.weeklyOffDays, holidays: [...calendar.holidays] })
  return breakdown.filter((d) => d.counted > 0 && !marked.has(d.date)).length
}

/**
 * The weekly offs and holidays of somebody's window, to a day — as their
 * month counts them (domain/attendance/monthSoFar, 25 Oct 2026): the company's
 * days off, by the week in force on each day, a holiday over a weekly off on
 * the same day; and a working day marked off for them alone. The report's
 * columns used to count only the days marked, which nobody marks — so every
 * row read nought, beside a month page saying "4 weekly off · 1 holiday".
 */
export function daysOffWithin(
  window: { from: CalendarDate; to: CalendarDate },
  upTo: CalendarDate,
  calendar: Calendar,
  markedOff: ReadonlyMap<CalendarDate, 'holiday' | 'weekly_off'>,
): { weeklyOff: number; holiday: number } {
  const range = overlap(window, { from: window.from, to: upTo })
  const out = { weeklyOff: 0, holiday: 0 }
  if (!range) return out
  const holidays = new Set(calendar.holidays)
  for (let day = range.from; day <= range.to; day = addCalendarDays(day, 1)) {
    const kind = holidays.has(day) ? 'holiday' : isWeeklyOff(calendar.weeklyOffDays, day) ? 'weekly_off' : markedOff.get(day) ?? null
    if (kind === 'holiday') out.holiday += 1
    else if (kind === 'weekly_off') out.weeklyOff += 1
  }
  return out
}

/** The days of one leave request that fall inside a window — half days as halves. */
export function leaveDaysWithin(
  request: { from: CalendarDate; to: CalendarDate; halfDays: readonly CalendarDate[] },
  window: { from: CalendarDate; to: CalendarDate },
  calendar: Calendar,
): number {
  const range = overlap(request, window)
  if (!range) return 0
  return workingDays({
    from: range.from,
    to: range.to,
    weeklyOffDays: calendar.weeklyOffDays,
    holidays: [...calendar.holidays],
    halfDays: [...request.halfDays],
  }).days
}
