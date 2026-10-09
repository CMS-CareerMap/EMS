import { addCalendarDays, parseWallClock, zonedMinutes, zonedToday, type CalendarDate } from '../shared/dates'
import { classifyDay, dayMinimums, type DayClassification } from './hours'

/**
 * A day measured against its shift's rules (client §34–35): how late, how
 * early, how much overtime — and what that does to the day's status.
 *
 * Pure, like hours.ts: the times arrive as minutes from the start of the
 * attendance date on the company's clock, so an overnight shift's check-out
 * the next morning is simply past 1440.
 */

export interface ShiftRules {
  startTime: string
  endTime: string
  expectedHours: number
  graceMinutes: number
  lateThresholdMinutes: number | null
  earlyLeavingMinutes: number | null
  minFullDayHours: number | null
  minHalfDayHours: number | null
  overtimeAfterMinutes: number
}

/** The rules as the database keeps them — Decimals and all. */
export interface ShiftRow {
  startTime: string
  endTime: string
  expectedHours: unknown
  graceMinutes: number
  lateThresholdMinutes: number | null
  earlyLeavingMinutes: number | null
  minFullDayHours: unknown
  minHalfDayHours: unknown
  overtimeAfterMinutes: number
}

export function shiftRulesOf(shift: ShiftRow | null | undefined): ShiftRules | null {
  if (!shift) return null
  return {
    startTime: shift.startTime,
    endTime: shift.endTime,
    expectedHours: Number(shift.expectedHours),
    graceMinutes: shift.graceMinutes,
    lateThresholdMinutes: shift.lateThresholdMinutes,
    earlyLeavingMinutes: shift.earlyLeavingMinutes,
    minFullDayHours: shift.minFullDayHours == null ? null : Number(shift.minFullDayHours),
    minHalfDayHours: shift.minHalfDayHours == null ? null : Number(shift.minHalfDayHours),
    overtimeAfterMinutes: shift.overtimeAfterMinutes,
  }
}

export interface DayMeasure {
  /** Minutes after the start, when beyond the grace; 0 on time; null when there is nothing to measure. */
  lateMinutes: number | null
  /** Minutes short of the end, when beyond the grace; 0 when not; null without a check-out. */
  earlyLeavingMinutes: number | null
  /** Minutes past the expected hours, once past the threshold; 0 when not; null without hours. */
  overtimeMinutes: number | null
  /** Null without hours worked: nothing to classify. */
  classification: DayClassification | null
  /** Why the day is a half day although its hours were enough. */
  reason: 'late' | 'early' | null
}

/**
 * Further than this from the shift, a time is not measured against it: a
 * check-in fourteen hours "late" is a night shift's next morning, or a typo,
 * and calling either late helps nobody.
 */
const FAR_MINUTES = 12 * 60

export function measureDay(input: {
  rules: ShiftRules | null
  /** Minutes from the start of the attendance date, company clock. */
  checkIn: number | null
  checkOut: number | null
  hoursWorked: number | null
}): DayMeasure {
  const { rules } = input
  const empty: DayMeasure = { lateMinutes: null, earlyLeavingMinutes: null, overtimeMinutes: null, classification: null, reason: null }
  if (!rules) return empty

  const start = parseWallClock(rules.startTime)
  const endClock = parseWallClock(rules.endTime)
  // A shift whose times cannot be read measures nothing — better than measuring against midnight.
  if (start === null || endClock === null) return empty
  const end = endClock <= start ? endClock + 1440 : endClock

  let lateMinutes: number | null = null
  if (input.checkIn !== null && Math.abs(input.checkIn - start) <= FAR_MINUTES) {
    const late = input.checkIn - start
    lateMinutes = late > rules.graceMinutes ? late : 0
  }

  let earlyLeavingMinutes: number | null = null
  if (input.checkOut !== null && Math.abs(end - input.checkOut) <= FAR_MINUTES) {
    const early = end - input.checkOut
    earlyLeavingMinutes = early > rules.graceMinutes ? early : 0
  }

  if (input.hoursWorked === null) {
    return { ...empty, lateMinutes, earlyLeavingMinutes }
  }

  const extra = Math.round(input.hoursWorked * 60 - rules.expectedHours * 60)
  const overtimeMinutes = rules.expectedHours > 0 && extra > 0 && extra >= rules.overtimeAfterMinutes ? extra : 0

  let classification = rules.expectedHours > 0
    ? classifyDay(input.hoursWorked, rules.expectedHours, { full: rules.minFullDayHours, half: rules.minHalfDayHours })
    : null
  let reason: DayMeasure['reason'] = null
  // Late or early past the company's threshold costs half the day, however long it was.
  if (classification?.status === 'present') {
    if (rules.lateThresholdMinutes !== null && lateMinutes !== null && lateMinutes > rules.lateThresholdMinutes) reason = 'late'
    else if (rules.earlyLeavingMinutes !== null && earlyLeavingMinutes !== null && earlyLeavingMinutes > rules.earlyLeavingMinutes) reason = 'early'
    if (reason) classification = { ...classification, status: 'half_day' }
  }

  return { lateMinutes, earlyLeavingMinutes, overtimeMinutes, classification, reason }
}

/**
 * The clock time of an instant in the company's zone, as minutes from the
 * start of `date` — past 1440 for the next morning. The clock, not the
 * minutes elapsed since midnight: on a day the clocks change, 09:00 is still
 * 09:00, as it is for a time HR types or a machine exports.
 */
export function clockMinutes(instant: Date, date: CalendarDate, timezone: string): number {
  const day = zonedToday(instant, timezone)
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000)
  return zonedMinutes(instant, timezone) + days * 1440
}

/** `measureDay` for a row's instants: the day's date and the company's zone read them. */
export function measureInstants(input: {
  rules: ShiftRules | null
  date: CalendarDate
  timezone: string
  checkIn: Date | null
  checkOut: Date | null
  hoursWorked: number | null
}): DayMeasure {
  return measureDay({
    rules: input.rules,
    checkIn: input.checkIn ? clockMinutes(input.checkIn, input.date, input.timezone) : null,
    checkOut: input.checkOut ? clockMinutes(input.checkOut, input.date, input.timezone) : null,
    hoursWorked: input.hoursWorked,
  })
}

type ShiftWithBreak = ShiftRow & { breakMinutes: number }

/**
 * What a day is graded against: the shift it was recorded on, with the hours
 * expected then — as a check-out is — or, for a day not yet recorded, the
 * person's shift now. Only the shift link and its hours are kept on the day;
 * its break and rules are read as the shift stands, so a day marked or
 * corrected later is graded by the shift as it is then. Nothing regrades a
 * day on its own.
 */
export function gradedBy(
  existing: { shiftId: string | null; expectedHours: unknown; shift: ShiftWithBreak | null } | null | undefined,
  employee: { shiftId: string | null; shift: ShiftWithBreak | null },
) {
  const recorded = existing?.shift ? existing : null
  const shift = recorded ? recorded.shift : employee.shift
  const expectedHours = recorded?.expectedHours != null ? Number(recorded.expectedHours) : employee.shift ? Number(employee.shift.expectedHours) : null
  const rules = shiftRulesOf(shift)
  return {
    rules: rules && expectedHours !== null ? { ...rules, expectedHours } : rules,
    expectedHours,
    breakMinutes: shift?.breakMinutes ?? 0,
    shiftId: recorded ? recorded.shiftId : employee.shiftId,
  }
}

/**
 * The rules for the half of a day that is not on approved leave: half the
 * hours, half the minimums. Graded against the whole shift, the 4½ hours of a
 * worked half fall short of a full day's half-day mark and the day came out
 * absent — a half day's pay lost for a half that was worked.
 */
export function forWorkedHalf(rules: ShiftRules | null, leaveHalf: 'first_half' | 'second_half' | null = null): ShiftRules | null {
  if (!rules) return null
  const halved = {
    ...rules,
    expectedHours: rules.expectedHours / 2,
    minFullDayHours: rules.minFullDayHours === null ? null : rules.minFullDayHours / 2,
    minHalfDayHours: rules.minHalfDayHours === null ? null : rules.minHalfDayHours / 2,
  }
  // The worked half starts at the middle when the morning is on leave, and
  // ends there when the afternoon is — or arriving after a morning's leave
  // would be marked hours late.
  const start = parseWallClock(rules.startTime)
  const endClock = parseWallClock(rules.endTime)
  if (!leaveHalf || start === null || endClock === null) return halved
  const end = endClock <= start ? endClock + 1440 : endClock
  const middle = (start + Math.round((end - start) / 2)) % 1440
  const clock = `${String(Math.floor(middle / 60)).padStart(2, '0')}:${String(middle % 60).padStart(2, '0')}`
  return leaveHalf === 'first_half' ? { ...halved, startTime: clock } : { ...halved, endTime: clock }
}

/**
 * A day half on approved leave is at most a half day worked: enough for the
 * half (a half day or better against `forWorkedHalf`) is a half day, too little
 * is absent — payroll then pays the leave half and docks the other.
 */
export function withHalfDayLeave(classification: DayClassification | null): DayClassification | null {
  if (!classification) return null
  return { ...classification, status: classification.status === 'absent' ? 'absent' : 'half_day' }
}

/** A shift whose end comes at or before its start runs past midnight. */
export function isOvernight(rules: ShiftRules | null): boolean {
  if (!rules) return false
  const start = parseWallClock(rules.startTime)
  const end = parseWallClock(rules.endTime)
  return start !== null && end !== null && end <= start
}

/**
 * A check-in between midnight and an overnight shift's end belongs to the
 * shift that began the evening before: somebody on 22:00–06:00 arriving at
 * 00:15 is late for last night, not early for tonight.
 */
export function arrivingForLastNight(input: { rules: ShiftRules | null; today: CalendarDate; timezone: string; now: Date }): boolean {
  if (!isOvernight(input.rules)) return false
  const end = parseWallClock(input.rules!.endTime)!
  return clockMinutes(input.now, input.today, input.timezone) < end
}

/**
 * Whether a day begun on an overnight shift (22:00–06:00: its end is at or
 * before its start) is still that shift at `now`. Its check-out falls on the
 * next calendar day, so "today" has moved on while the day it belongs to has
 * not. It stays the current day until FAR_MINUTES past the shift's end, the
 * distance measureDay still measures; after that it is a day somebody forgot
 * to close, and the next one starts afresh. A day shift is never carried over.
 */
export function overnightDayOpen(input: { rules: ShiftRules | null; date: CalendarDate; timezone: string; now: Date }): boolean {
  const ends = overnightWindowEnds(input.rules)
  if (ends === null) return false
  const now = clockMinutes(input.now, input.date, input.timezone)
  return now >= 1440 && now < ends
}

/** How early before a shift starts somebody may check in for it. */
const EARLY_ARRIVAL_MINUTES = 2 * 60

/**
 * Minutes from the night's date where its day stops being "today": 12 hours
 * past the shift's end, or two hours before the next night's start, whichever
 * comes first — so even a 12-hour night can be checked into on time.
 */
function overnightWindowEnds(rules: ShiftRules | null): number | null {
  if (!rules || !isOvernight(rules)) return null
  const start = parseWallClock(rules.startTime)!
  const end = parseWallClock(rules.endTime)! + 1440
  return Math.min(end + FAR_MINUTES, start + 1440 - EARLY_ARRIVAL_MINUTES)
}

/** When a night shift's day stops being "today" — and the next check-in opens — as "18:00". Null for any other shift. */
export function nextCheckInOpens(rules: ShiftRules | null): string | null {
  const ends = overnightWindowEnds(rules)
  if (ends === null) return null
  const at = ends % 1440
  return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`
}

/**
 * Whether yesterday's day, still OPEN, is still the day to check out of.
 * A night shift: until its window ends (above). Any other shift — or none —
 * only through the small hours, for somebody who worked past midnight: until
 * three hours before the shift starts again (06:00 with no shift). After that
 * it is a day somebody forgot to close, and today starts afresh.
 */
export function openDayCarries(input: { rules: ShiftRules | null; date: CalendarDate; timezone: string; now: Date }): boolean {
  if (isOvernight(input.rules)) return overnightDayOpen(input)
  const start = input.rules ? parseWallClock(input.rules.startTime) : null
  const until = start === null ? 6 * 60 : Math.max(0, start - 3 * 60)
  const now = clockMinutes(input.now, input.date, input.timezone) - 1440
  return now >= 0 && now < until
}

/**
 * The hours worked a day needs to be a full day, as its check-out grades it:
 * the day's own shift, against the hours expected when it began — half of them
 * on a day half on leave. Null with no shift: nothing grades the day. For the
 * card's "Full day at 8h · 2h 15m to go" (client, 9 Oct 2026).
 */
export function fullDayHoursFor(rules: ShiftRules | null, expectedHours: number | null, halfLeave: 'first_half' | 'second_half' | null): number | null {
  if (!rules || !expectedHours) return null
  const asBegun = { ...rules, expectedHours }
  const graded = halfLeave ? forWorkedHalf(asBegun, halfLeave) : asBegun
  if (!graded) return null
  return dayMinimums(graded.expectedHours, { full: graded.minFullDayHours, half: graded.minHalfDayHours }).full
}

/** The longest one stretch of work can be: an open check-in older than this is a day somebody forgot to close. */
const LONGEST_DAY_MS = 20 * 60 * 60_000

/**
 * Whether a day checked into and not out of is still somebody's day at `now` —
 * the one their own card counts as "at work": today's; or yesterday's while it
 * carries (openDayCarries), never past twenty hours, and only while they have
 * not checked in today. Otherwise the check-out was forgotten. One rule for
 * their card and for whoever watches the roster (client, 9 Oct 2026).
 */
export function stillAtWork(input: {
  date: CalendarDate
  today: CalendarDate
  checkIn: Date | null
  checkOut: Date | null
  rules: ShiftRules | null
  timezone: string
  now: Date
  /** Whether they have checked in on `today` — a new day begun leaves yesterday's behind. */
  checkedInToday: boolean
}): boolean {
  if (!input.checkIn || input.checkOut) return false
  // A check-in typed for later in the day has not happened yet.
  if (input.checkIn.getTime() > input.now.getTime()) return false
  if (input.date === input.today) return true
  if (input.date !== addCalendarDays(input.today, -1) || input.checkedInToday) return false
  return input.now.getTime() - input.checkIn.getTime() <= LONGEST_DAY_MS &&
    openDayCarries({ rules: input.rules, date: input.date, timezone: input.timezone, now: input.now })
}

/** What a measure adds to a day's note: why a long enough day is still a half day. */
export function halfDayReason(measure: DayMeasure): string | null {
  if (measure.reason === 'late') return `Half day: arrived ${minutesLabel(measure.lateMinutes ?? 0)} after the shift start`
  if (measure.reason === 'early') return `Half day: left ${minutesLabel(measure.earlyLeavingMinutes ?? 0)} before the shift end`
  return null
}

/** The three marks, as a row stores them. */
export function marksOf(measure: DayMeasure) {
  return {
    lateMinutes: measure.lateMinutes,
    earlyLeavingMinutes: measure.earlyLeavingMinutes,
    overtimeMinutes: measure.overtimeMinutes,
  }
}

/** "1h 30m", "45m" — for messages and notes. */
export function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`
}
