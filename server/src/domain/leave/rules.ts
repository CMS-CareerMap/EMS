import { addCalendarDays, dayLabel, type CalendarDate } from '../shared/dates'

/**
 * A leave type's own rules (client §36–37): notice, the longest application,
 * who may use it and from when, and whether it comes in halves. Pure — the
 * leave service hands it the request and the person, and shows what it says.
 */

export interface LeaveTypeRules {
  name: string
  minNoticeDays: number
  maxDaysPerRequest: number | null
  eligibleAfterDays: number
  eligibleGender: 'male' | 'female' | 'other' | null
  halfDayAllowed: boolean
  /** Usable only from the day somebody is confirmed (client, 9 Oct 2026). */
  usableAfterConfirmation?: boolean | undefined
}

export interface RuleProblem {
  reason: 'no_half_days' | 'too_long' | 'not_eligible' | 'short_notice'
  message: string
}

const GENDER_WORDS = { male: 'men', female: 'women', other: 'employees of another gender' } as const

export function ruleProblem(
  rules: LeaveTypeRules,
  input: {
    days: number
    fromDate: CalendarDate
    today: CalendarDate
    /** Notice is asked of somebody applying for themselves — not of a manager recording leave already taken. */
    ownApplication: boolean
    joined: CalendarDate | null
    gender: 'male' | 'female' | 'other' | null
    halfDays: number
    /** The day they were confirmed; null while on probation. */
    confirmedOn?: CalendarDate | null | undefined
  },
): RuleProblem | null {
  if (input.halfDays > 0 && !rules.halfDayAllowed) {
    return { reason: 'no_half_days', message: `${rules.name} is taken in whole days only.` }
  }

  if (rules.eligibleGender) {
    if (!input.gender) {
      return { reason: 'not_eligible', message: `${rules.name} is for ${GENDER_WORDS[rules.eligibleGender]} only, and no gender is recorded on this employee record. Ask HR to record it.` }
    }
    if (input.gender !== rules.eligibleGender) {
      return { reason: 'not_eligible', message: `${rules.name} is for ${GENDER_WORDS[rules.eligibleGender]} only.` }
    }
  }

  if (rules.eligibleAfterDays > 0 && input.joined) {
    const from = addCalendarDays(input.joined, rules.eligibleAfterDays)
    if (input.fromDate < from) {
      return { reason: 'not_eligible', message: `${rules.name} can be used after ${rules.eligibleAfterDays} days of service — from ${dayLabel(from)}.` }
    }
  }

  if (rules.usableAfterConfirmation) {
    if (!input.confirmedOn) {
      return { reason: 'not_eligible', message: `${rules.name} can be used once confirmed, at the end of probation — and the confirmation is not recorded yet.` }
    }
    if (input.fromDate < input.confirmedOn) {
      return { reason: 'not_eligible', message: `${rules.name} can be used from the day of confirmation, ${dayLabel(input.confirmedOn)}.` }
    }
  }

  if (rules.maxDaysPerRequest !== null && input.days > rules.maxDaysPerRequest) {
    return { reason: 'too_long', message: `One application for ${rules.name} covers at most ${rules.maxDaysPerRequest} day${rules.maxDaysPerRequest === 1 ? '' : 's'}.` }
  }

  // A day already begun is leave being recorded (sick leave, applied on
  // return), not leave being planned: notice cannot be given for it.
  if (rules.minNoticeDays > 0 && input.ownApplication && input.fromDate >= input.today) {
    const earliest = addCalendarDays(input.today, rules.minNoticeDays)
    if (input.fromDate < earliest) {
      return { reason: 'short_notice', message: `${rules.name} needs ${rules.minNoticeDays} day${rules.minNoticeDays === 1 ? '' : 's'}’ notice. The earliest it can start, applied for today, is ${dayLabel(earliest)}.` }
    }
  }

  return null
}

export type HalfDaySession = 'first_half' | 'second_half'

/** "Half day (first half)" — what a leave day's attendance note says. */
export function halfDayNote(session: HalfDaySession | undefined): string {
  return session ? `Half day leave (${session === 'first_half' ? 'first half' : 'second half'})` : 'Half day leave'
}
