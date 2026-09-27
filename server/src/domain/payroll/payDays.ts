import { type CalendarDate } from '../shared/dates'
import { workingDays, type Weekday } from '../leave/leaveDays'
import type { EmploymentWindow } from './salary'

/**
 * Which days of a month somebody is paid for, and what one day is worth.
 *
 * THE MOST CONTESTED NUMBER IN INDIAN PAYROLL, so it is defined here once and
 * in words (guide, Day 16):
 *
 *   paidDays = the calendar days of their employment inside the month, less
 *   the days of loss of pay. Weekly offs and declared holidays inside that
 *   window are PAID — unless the sandwich rule is on and they sit between two
 *   days of loss of pay.
 *
 *   One day's pay = monthly gross ÷ X, where X is the company's LOP basis:
 *   the month's calendar days, a flat 30, or its working days.
 *
 * Pure. Attendance, leave, the holiday calendar and "today" all arrive as
 * arguments, so every rule below is tested without a database or a clock.
 */

export type LopBasis = 'calendar_days' | 'fixed_30' | 'working_days'

/** What every month counts as on the fixed basis — February included. */
const FIXED_BASIS_DAYS = 30

/** The statuses an Attendance row can carry. */
export type AttendanceStatus = 'present' | 'half_day' | 'absent' | 'on_leave' | 'holiday' | 'weekly_off'

export type DayKind = 'working' | 'weekly_off' | 'holiday'

export interface MonthCalendar {
  year: number
  month: number
  /** Every day of the month, in order. */
  days: { date: CalendarDate; kind: DayKind }[]
  /** Days that are neither a weekly off nor a declared holiday. */
  workingDays: number
}

/**
 * The month as the company works it.
 *
 * A weekly off wins over a holiday on the same day, as it does for leave — the
 * day is off either way, and it is off once.
 */
export function monthCalendar(input: {
  year: number
  month: number
  weeklyOffDays: readonly Weekday[]
  /** Days off for everybody: public holidays, and weekly offs declared as holidays. */
  holidays: readonly CalendarDate[]
}): MonthCalendar {
  const offDays = new Set<number>(input.weeklyOffDays)
  const holidays = new Set(input.holidays)
  const mm = String(input.month).padStart(2, '0')
  const total = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate()

  const days: MonthCalendar['days'] = []
  let working = 0

  for (let d = 1; d <= total; d++) {
    const date = `${input.year}-${mm}-${String(d).padStart(2, '0')}`
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()

    const kind: DayKind = offDays.has(weekday) ? 'weekly_off' : holidays.has(date) ? 'holiday' : 'working'
    if (kind === 'working') working += 1
    days.push({ date, kind })
  }

  return { year: input.year, month: input.month, days, workingDays: working }
}

/** One day of approved leave, as far as pay is concerned. */
export interface LeaveDay {
  date: CalendarDate
  /** 1 for a whole day, 0.5 for a half. */
  portion: number
  /** From the leave type. Unpaid leave is loss of pay. */
  paid: boolean
}

export interface ApprovedLeave {
  from: CalendarDate
  to: CalendarDate
  halfDays: readonly CalendarDate[]
  paid: boolean
}

/**
 * Approved leave, day by day, for the days of this month it actually charges.
 *
 * Counted by the same function that took the days off the balance, so a leave
 * that cost four and a half days costs four and a half days here too. A range
 * that runs into the next month contributes only its days in this one.
 */
export function leaveDaysIn(
  requests: readonly ApprovedLeave[],
  calendar: MonthCalendar,
  weeklyOffDays: readonly Weekday[],
): LeaveDay[] {
  const first = calendar.days[0]?.date
  const last = calendar.days[calendar.days.length - 1]?.date
  if (!first || !last) return []

  const holidays = calendar.days.filter((d) => d.kind === 'holiday').map((d) => d.date)
  const out: LeaveDay[] = []

  for (const request of requests) {
    const from = request.from > first ? request.from : first
    const to = request.to < last ? request.to : last
    if (from > to) continue

    const counted = workingDays({ from, to, weeklyOffDays, holidays, halfDays: request.halfDays })
    for (const day of counted.breakdown) {
      if (day.counted > 0) out.push({ date: day.date, portion: day.counted, paid: request.paid })
    }
  }

  return out
}

export type PayDayReason =
  /** Present, or present for the half that was not on leave. */
  | 'worked'
  | 'paid_leave'
  | 'unpaid_leave'
  | 'absent'
  /** Half a day worked, the other half neither worked nor on leave. */
  | 'half_day'
  /** A weekly off or holiday, paid. */
  | 'off_day'
  /** A weekly off or holiday between two days of loss of pay, with the sandwich rule on. */
  | 'sandwiched'
  /** A working day HR marked as a holiday or weekly off for this person. */
  | 'marked_off'
  /** Marked "on leave" with no approved leave behind it. Paid, and flagged. */
  | 'marked_leave'
  /** A working day that has passed with no attendance at all. Paid, and flagged. */
  | 'unmarked'
  /** Today or later, with nothing recorded yet. Paid. */
  | 'not_yet'

export interface PayDay {
  date: CalendarDate
  kind: DayKind
  /** 0, 0.5 or 1. */
  lop: number
  reason: PayDayReason
}

export interface LossOfPayInput {
  calendar: MonthCalendar
  /** Their employment inside the month. Days outside it are not theirs to be paid or docked. */
  window: EmploymentWindow
  attendance: readonly { date: CalendarDate; status: AttendanceStatus }[]
  leave: readonly LeaveDay[]
  sandwichRule: boolean
  /** The company's today. Nothing after it has happened. */
  today: CalendarDate
}

export interface LossOfPay {
  lopDays: number
  /** Every day of the employment window, with what it cost and why. */
  days: PayDay[]
  /** Passed working days with no record at all — counted as paid. */
  unmarked: CalendarDate[]
  /** Today and later with nothing recorded — counted as paid. */
  notYet: CalendarDate[]
  /** "On leave" with no approved leave — counted as paid. */
  markedLeave: CalendarDate[]
}

const halfSteps = (n: number) => Math.round(n * 2) / 2

/**
 * Days of loss of pay, from attendance and leave.
 *
 * A working day is paid for what was worked plus what was on paid leave. What
 * is left of it is loss of pay if something says so — unpaid leave, an absence,
 * a half day — and paid if nothing says anything.
 *
 * THE DEFAULT FOR A DAY NOBODY RECORDED IS PAID, and every such day is listed.
 * Docking a day because a punch was missed would take money from somebody who
 * may have worked it; paying it wrongly is recovered next month. Whoever runs
 * payroll sees the list before anything is approved.
 *
 * Attendance beats leave in one direction only: somebody present on a day of
 * approved unpaid leave worked it, and is paid for it. An absence on a day of
 * approved paid leave is the leave — the absence is what the leave was for.
 */
export function lossOfPay(input: LossOfPayInput): LossOfPay {
  const status = new Map(input.attendance.map((row) => [row.date, row.status]))

  const paidLeave = new Map<CalendarDate, number>()
  const unpaidLeave = new Map<CalendarDate, number>()
  for (const day of input.leave) {
    const into = day.paid ? paidLeave : unpaidLeave
    into.set(day.date, (into.get(day.date) ?? 0) + day.portion)
  }

  const days: PayDay[] = []
  const unmarked: CalendarDate[] = []
  const notYet: CalendarDate[] = []
  const markedLeave: CalendarDate[] = []

  for (const { date, kind } of input.calendar.days) {
    if (date < input.window.from || date > input.window.to) continue

    if (kind !== 'working') {
      days.push({ date, kind, lop: 0, reason: 'off_day' })
      continue
    }

    const recorded = status.get(date)
    if (recorded === 'holiday' || recorded === 'weekly_off') {
      days.push({ date, kind, lop: 0, reason: 'marked_off' })
      continue
    }

    const worked = recorded === 'present' ? 1 : recorded === 'half_day' ? 0.5 : 0
    const paid = Math.min(1 - worked, paidLeave.get(date) ?? 0)
    const unpaid = Math.min(1 - worked - paid, unpaidLeave.get(date) ?? 0)
    const gap = 1 - worked - paid - unpaid

    let lop = unpaid
    let reason: PayDayReason = unpaid > 0 ? 'unpaid_leave' : worked > 0 ? 'worked' : 'paid_leave'

    if (gap > 0) {
      if (recorded === 'absent' || recorded === 'half_day') {
        // Marked, and the part that is not covered was not worked.
        lop += gap
        if (unpaid === 0) reason = recorded === 'absent' ? 'absent' : 'half_day'
      } else if (recorded === 'on_leave') {
        // The row leave approval writes, for a whole or a half day. With
        // nothing approved behind it somebody typed it — paid, and flagged.
        // With a half day approved, the other half is the half they worked.
        if (!paidLeave.has(date) && !unpaidLeave.has(date)) {
          markedLeave.push(date)
          reason = 'marked_leave'
        }
      } else if (date >= input.today) {
        notYet.push(date)
        if (worked + paid + unpaid === 0) reason = 'not_yet'
      } else {
        unmarked.push(date)
        if (worked + paid + unpaid === 0) reason = 'unmarked'
      }
    }

    days.push({ date, kind, lop: halfSteps(lop), reason })
  }

  if (input.sandwichRule) applySandwichRule(days)

  return {
    lopDays: halfSteps(days.reduce((sum, day) => sum + day.lop, 0)),
    days,
    unmarked,
    notYet,
    markedLeave,
  }
}

/**
 * Off days between two full days of loss of pay become loss of pay.
 *
 * Only inside the window. An off day at the very start or end of the month
 * has its other neighbour in a month that is either paid already or not yet
 * known, and it is not docked on a guess about either.
 */
function applySandwichRule(days: PayDay[]): void {
  let i = 0
  while (i < days.length) {
    if (days[i]!.kind === 'working') {
      i += 1
      continue
    }

    let end = i
    while (end < days.length && days[end]!.kind !== 'working') end += 1

    const before = days[i - 1]
    const after = days[end]
    if (before && after && before.lop === 1 && after.lop === 1) {
      for (let k = i; k < end; k++) days[k] = { ...days[k]!, lop: 1, reason: 'sandwiched' }
    }

    i = end
  }
}

export interface Proration {
  /** Calendar days of the month inside their employment. */
  employmentDays: number
  /** employmentDays − lopDays: what a payslip says was paid for, on any basis. */
  paidDays: number
  lopBasis: LopBasis
  /** X — what the month's pay is divided into. */
  payBasisDays: number
  /** How many of those are paid. */
  payableDays: number
  /**
   * True when the working-days basis found no working days at all — a month
   * of declared holidays — and calendar days were used instead. Dividing by
   * zero would have paid nothing for a month the company chose to close.
   */
  fellBackToCalendar: boolean
}

/**
 * What fraction of a month's pay is earned: payableDays out of payBasisDays.
 *
 * A WHOLE MONTH IS THE WHOLE SALARY on every basis. On a fixed 30, February
 * counts as 30 days and not 28 — otherwise the basis meant to make every month
 * equal would pay less in the shortest one. Loss of pay then comes off at one
 * day's rate each.
 *
 * A PART MONTH — joined or left during it — is the days employed, counted the
 * basis's way and capped at the basis, less loss of pay. On a fixed 30, joining
 * on the 16th of a 31-day month is 16 days of 30.
 */
export function proration(input: {
  lopBasis: LopBasis
  calendar: MonthCalendar
  window: EmploymentWindow
  lopDays: number
}): Proration {
  const days = input.calendar.days
  const inWindow = days.filter((d) => d.date >= input.window.from && d.date <= input.window.to)
  const wholeMonth = inWindow.length === days.length

  let lopBasis = input.lopBasis
  let fellBackToCalendar = false
  if (lopBasis === 'working_days' && input.calendar.workingDays === 0) {
    lopBasis = 'calendar_days'
    fellBackToCalendar = true
  }

  let basis: number
  let employed: number

  switch (lopBasis) {
    case 'calendar_days':
      basis = days.length
      employed = inWindow.length
      break
    case 'fixed_30':
      basis = FIXED_BASIS_DAYS
      employed = wholeMonth ? FIXED_BASIS_DAYS : Math.min(inWindow.length, FIXED_BASIS_DAYS)
      break
    case 'working_days':
      basis = input.calendar.workingDays
      employed = wholeMonth ? basis : inWindow.filter((d) => d.kind === 'working').length
      break
  }

  const paidDays = Math.max(0, halfSteps(inWindow.length - input.lopDays))

  return {
    employmentDays: inWindow.length,
    paidDays,
    lopBasis,
    payBasisDays: basis,
    // Not a single day paid is nothing paid, on any basis. Without this a
    // February spent entirely on unpaid leave would still earn 2 days of 30.
    payableDays: paidDays === 0 ? 0 : Math.max(0, halfSteps(employed - input.lopDays)),
    fellBackToCalendar,
  }
}
