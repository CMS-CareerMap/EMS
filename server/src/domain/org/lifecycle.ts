import { addCalendarDays, type CalendarDate } from '../shared/dates'

/**
 * The employee lifecycle (client §43). Pure.
 *
 *   Joining soon → Onboarding → On probation → Confirmed
 *     → Resigned → Serving notice → Last day passed → Left
 *
 * Transfers and promotions are steps in somebody's history, not places they
 * stand. Where a person stands is worked out from their record and their open
 * resignation every time it is asked — never stored, so it can never disagree
 * with the dates it comes from.
 */

export type LifecycleStage =
  /** Their joining date is still ahead. They may sign in and send documents, not check in. */
  | 'joining_soon'
  /** Joined; HR has not finished onboarding them. */
  | 'onboarding'
  /** Onboarded, not yet confirmed. */
  | 'probation'
  | 'confirmed'
  /** Handed in a resignation that the person above them has not accepted yet. */
  | 'resigned'
  /** Leaving: a last working day is set and still ahead (or today). */
  | 'notice_period'
  /** Their last working day has passed, and their exit is not complete. */
  | 'exit_due'
  /** They have left: logins closed, record archived. */
  | 'left'

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  'joining_soon', 'onboarding', 'probation', 'confirmed', 'resigned', 'notice_period', 'exit_due', 'left',
]

export interface LifecycleFacts {
  dateOfJoining: CalendarDate | null
  onboardedOn: CalendarDate | null
  confirmedOn: CalendarDate | null
  lastWorkingDate: CalendarDate | null
  /** Archived, or marked inactive. */
  left: boolean
  /** Their open resignation, if any. */
  resignation: { status: 'submitted' | 'accepted' } | null
}

export function stageOf(facts: LifecycleFacts, today: CalendarDate): LifecycleStage {
  if (facts.left) return 'left'
  if (facts.lastWorkingDate && facts.lastWorkingDate < today) return 'exit_due'
  if (facts.resignation?.status === 'submitted') return 'resigned'
  // Notice is served on an accepted resignation. A last day set without one —
  // a contract's end date — leaves them where they are until it passes.
  if (facts.resignation?.status === 'accepted') return 'notice_period'
  if (facts.dateOfJoining && facts.dateOfJoining > today) return 'joining_soon'
  if (!facts.onboardedOn) return 'onboarding'
  if (!facts.confirmedOn) return 'probation'
  return 'confirmed'
}

/** Still working here, in any stage: not left, and not past their last day. */
export function isOnRoll(stage: LifecycleStage): boolean {
  return stage !== 'left' && stage !== 'exit_due'
}

/**
 * A calendar date some months on, the day clamped to the end of a shorter
 * month: 31 Aug + 6 months is 28 (or 29) Feb, not 3 Mar.
 */
export function addMonths(day: CalendarDate, months: number): CalendarDate {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const index = y * 12 + (m - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}` as CalendarDate
}

/** When a new joiner's probation ends: the company's probation months from their joining date. */
export function defaultProbationEnd(dateOfJoining: CalendarDate, probationMonths: number): CalendarDate {
  return addMonths(dateOfJoining, probationMonths)
}

/** The last working day a resignation asks for unless somebody says otherwise: the notice period from the day it is handed in. */
export function defaultLastDay(submittedOn: CalendarDate, noticePeriodDays: number): CalendarDate {
  return addCalendarDays(submittedOn, noticePeriodDays)
}

/** The bounds the company settings may take: a probation of up to two years, a notice of up to six months. */
export const PROBATION_MONTHS_MAX = 24
export const NOTICE_DAYS_MAX = 180
