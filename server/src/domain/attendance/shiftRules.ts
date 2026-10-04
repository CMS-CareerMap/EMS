import { parseWallClock, zonedMinutes, zonedToday, type CalendarDate } from '../shared/dates'
import { classifyDay, type DayClassification } from './hours'

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
