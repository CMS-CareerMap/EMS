/**
 * How many days of leave a date range actually costs.
 *
 * Pure arithmetic over values it is given — no database, no clock, no
 * timezone lookups. The holiday list and the weekly-off pattern are arguments,
 * because both are company settings and neither is a fact about calendars.
 *
 * This is the number that comes off somebody's balance and, eventually, off
 * their salary. Getting it wrong by one day is not a rounding error to anyone.
 */

import { isCalendarDate, fromDateColumn, type CalendarDate } from '../shared/dates'

/** Sunday is 0, matching getUTCDay(). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface WorkingDaysInput {
  from: CalendarDate
  to: CalendarDate
  /**
   * Which weekdays the company does not work.
   *
   * An argument rather than a constant, because it is not the same everywhere:
   * most Indian offices take Sunday, many take Saturday too, and plenty take
   * alternate Saturdays — which this cannot express and is flagged below.
   */
  weeklyOffDays: readonly Weekday[]
  /** Public holidays that fall inside the range, as calendar dates. */
  holidays: readonly CalendarDate[]
  /**
   * Half days, by date. A person leaving at lunch on the Friday of a week's
   * leave costs four and a half days, not five.
   */
  halfDays?: readonly CalendarDate[]
}

export interface WorkingDaysResult {
  /** What comes off the balance. */
  days: number
  /** Every calendar day in the range, with what each one cost and why. */
  breakdown: {
    date: CalendarDate
    counted: number
    reason: 'working' | 'half_day' | 'weekly_off' | 'holiday'
  }[]
}

export class InvalidRangeError extends Error {}

/**
 * Counts the days that are actually charged.
 *
 * Both ends INCLUSIVE, because "leave from Monday to Friday" means five days to
 * every human being who has ever applied for it. An exclusive end would be
 * defensible and would silently short everybody by a day.
 */
export function workingDays(input: WorkingDaysInput): WorkingDaysResult {
  if (!isCalendarDate(input.from)) throw new InvalidRangeError(`"${input.from}" is not a date`)
  if (!isCalendarDate(input.to)) throw new InvalidRangeError(`"${input.to}" is not a date`)
  if (input.to < input.from) {
    throw new InvalidRangeError('The last day of leave cannot be before the first')
  }

  const offDays = new Set<number>(input.weeklyOffDays)
  const holidays = new Set(input.holidays)
  const halfDays = new Set(input.halfDays ?? [])

  const breakdown: WorkingDaysResult['breakdown'] = []
  let days = 0

  const cursor = new Date(`${input.from}T00:00:00Z`)
  const end = new Date(`${input.to}T00:00:00Z`)

  // A guard, not a limit anybody should hit. Two years of leave is a data entry
  // error, and looping to the heat death of the universe is a worse answer.
  const MAX_DAYS = 732
  let guard = 0

  while (cursor <= end) {
    if (++guard > MAX_DAYS) {
      throw new InvalidRangeError('That range is longer than two years')
    }

    const date = fromDateColumn(cursor)

    // ORDER MATTERS. A holiday that falls on a Sunday is not charged twice, and
    // a half day on a public holiday is not charged at all — the day is already
    // free. Checking "is it a working day" before "how much of it" is what
    // keeps those cases from colliding.
    if (offDays.has(cursor.getUTCDay())) {
      breakdown.push({ date, counted: 0, reason: 'weekly_off' })
    } else if (holidays.has(date)) {
      breakdown.push({ date, counted: 0, reason: 'holiday' })
    } else if (halfDays.has(date)) {
      breakdown.push({ date, counted: 0.5, reason: 'half_day' })
      days += 0.5
    } else {
      breakdown.push({ date, counted: 1, reason: 'working' })
      days += 1
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return { days: Math.round(days * 2) / 2, breakdown }
}

/**
 * A balance, from ledger entries.
 *
 * The sum IS the balance — there is no stored number to disagree with it. A
 * wrong balance is fixed by adding a correcting entry, never by editing one,
 * so the question "why does she have 4.5 days?" always has an answer.
 */
export function balanceFrom(entries: readonly { days: number }[]): number {
  return Math.round(entries.reduce((sum, entry) => sum + entry.days, 0) * 2) / 2
}

/**
 * Whether a request fits inside a balance.
 *
 * Returns a reason rather than a boolean, so the caller can say WHICH of the
 * two things is wrong — "you have 3 days left" and "that leave type has no
 * quota" need different answers.
 */
export type BalanceRefusal = 'insufficient' | 'no_quota'

export function checkBalance(
  requested: number,
  available: number,
  quota: number,
): { ok: true } | { ok: false; reason: BalanceRefusal; shortBy: number } {
  if (quota <= 0 && available <= 0) {
    // Comp-off and work-from-home are granted, not accrued: with no quota and
    // nothing granted, there is nothing to take.
    return { ok: false, reason: 'no_quota', shortBy: requested }
  }

  if (requested > available) {
    return {
      ok: false,
      reason: 'insufficient',
      shortBy: Math.round((requested - available) * 2) / 2,
    }
  }

  return { ok: true }
}

/**
 * KNOWN GAP — alternate Saturdays.
 *
 * `weeklyOffDays` can say "every Saturday" or "no Saturday", and cannot say
 * "the second and fourth", which is what a large share of Indian offices
 * actually do. Nobody has asked for it, so it is not built — but a company that
 * works alternate Saturdays would be charged leave for the ones they are off.
 *
 * The fix, when it is asked for, is a rule on OrganizationPolicy rather than a
 * change here: this function would take the resulting list of non-working days.
 */
export const OPEN_QUESTIONS = [
  'Does the company work alternate Saturdays? The weekly-off setting is all-or-nothing today.',
] as const
