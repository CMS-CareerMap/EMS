import { dayLabel, type CalendarDate } from '../shared/dates'

/**
 * Granting a leave year: who gets how many days of which type.
 *
 * One function, used by the Leave page's "Grant leave" button and by the
 * `npm run grant-leave` terminal command alike, so the two can never grant
 * by different rules. Pure: it is handed what is already in the ledger and
 * says what to add.
 *
 * The rules, as they have been since Day 13:
 *   - A type with no annual quota (comp off, work from home) is granted case
 *     by case, never here.
 *   - Somebody who joined partway through the year gets the months that are
 *     left, rounded to the nearest half day. Nobody gets twelve days on their
 *     first morning.
 *   - Somebody who has already left gets nothing: their last working day has
 *     passed, or they are marked inactive. Somebody leaving later in the year
 *     is still here, and is granted. Nobody joining after the year ends is.
 *   - Unused days from last year carry in, up to the type's cap, for types
 *     that allow it — but only once last year has ENDED. Granted in advance,
 *     the new year gets its quota now and its carry when it begins (pressing
 *     Grant again then adds it). What is carried is last year's balance less
 *     the days still applied for in it, and the same days are written out of
 *     last year as they are written into this one, so a late application for
 *     a day in last year cannot spend them a second time.
 *   - Nothing is granted twice: an employee who already has this year's grant
 *     (or carry) for a type is left alone. Pressing the button again only
 *     reaches the people added since.
 */

export interface GrantEmployee {
  id: string
  dateOfJoining: CalendarDate | null
  lastWorkingDate: CalendarDate | null
  /** False for somebody marked inactive — no longer working here. */
  active: boolean
}

export interface GrantLeaveType {
  id: string
  annualQuota: number
  carryForward: boolean
  carryForwardCap: number
}

export interface GrantedAlready {
  employeeId: string
  leaveTypeId: string
  reason: 'opening_grant' | 'carry_forward'
}

export interface GrantEntry {
  employeeId: string
  leaveTypeId: string
  /** The year the entry belongs to: this one, or last year for days carried out of it. */
  leaveYear: number
  days: number
  reason: 'opening_grant' | 'carry_forward'
  note: string | null
}

/** Rounded to the nearest half day — the smallest amount of leave anybody can take. */
export const toHalfDays = (days: number): number => Math.round(days * 2) / 2

/** A leave year's first day, and the first day of the next. Leave year 2026 starting in April runs 1 Apr 2026 – 31 Mar 2027. */
export function leaveYearBounds(leaveYear: number, startMonth: number): { from: CalendarDate; nextFrom: CalendarDate } {
  const month = String(startMonth).padStart(2, '0')
  return { from: `${leaveYear}-${month}-01`, nextFrom: `${leaveYear + 1}-${month}-01` }
}

/** "2026–27" for a year starting in April; "2026" for one starting in January. */
export function leaveYearLabel(leaveYear: number, startMonth: number): string {
  return startMonth === 1 ? String(leaveYear) : `${leaveYear}–${String((leaveYear + 1) % 100).padStart(2, '0')}`
}

/** A full year for somebody here for all of it; the months that are left, for somebody who joined partway. */
export function proRatedQuota(quota: number, joined: CalendarDate | null, leaveYear: number, startMonth: number): number {
  const { from, nextFrom } = leaveYearBounds(leaveYear, startMonth)
  if (!joined || joined <= from) return quota
  if (joined >= nextFrom) return 0
  const monthsLeft =
    (Number(nextFrom.slice(0, 4)) - Number(joined.slice(0, 4))) * 12 + (Number(nextFrom.slice(5, 7)) - Number(joined.slice(5, 7)))
  return toHalfDays((quota * monthsLeft) / 12)
}

export function planGrant(input: {
  leaveYear: number
  startMonth: number
  /** Today on the company's clock: somebody whose last day is already behind them has left. */
  today: CalendarDate
  employees: readonly GrantEmployee[]
  leaveTypes: readonly GrantLeaveType[]
  already: readonly GrantedAlready[]
  /** What is left of last year for this employee and type: its ledger less what is still applied for in it. */
  lastYearLeft: (employeeId: string, leaveTypeId: string) => number
}): GrantEntry[] {
  const { from } = leaveYearBounds(input.leaveYear, input.startMonth)
  // Granting next year in advance, somebody leaving before it starts is not
  // part of it; granting this year, somebody already gone is not.
  const stillHereOn = from > input.today ? from : input.today
  // Last year is still open while this one has not begun: nothing is carried yet.
  const lastYearClosed = input.today >= from
  const done = new Set(input.already.map((a) => `${a.employeeId}|${a.leaveTypeId}|${a.reason}`))
  const entries: GrantEntry[] = []

  for (const employee of input.employees) {
    if (!employee.active) continue
    if (employee.lastWorkingDate && employee.lastWorkingDate < stillHereOn) continue

    for (const type of input.leaveTypes) {
      if (type.annualQuota <= 0) continue

      if (!done.has(`${employee.id}|${type.id}|opening_grant`)) {
        const days = proRatedQuota(type.annualQuota, employee.dateOfJoining, input.leaveYear, input.startMonth)
        if (days <= 0) continue
        entries.push({
          employeeId: employee.id,
          leaveTypeId: type.id,
          leaveYear: input.leaveYear,
          days,
          reason: 'opening_grant',
          note: days === type.annualQuota ? null : `Pro-rated from joining on ${dayLabel(employee.dateOfJoining!)}`,
        })
      }

      if (lastYearClosed && type.carryForward && !done.has(`${employee.id}|${type.id}|carry_forward`)) {
        const carried = toHalfDays(Math.max(0, Math.min(input.lastYearLeft(employee.id, type.id), type.carryForwardCap)))
        if (carried > 0) {
          entries.push(
            {
              employeeId: employee.id,
              leaveTypeId: type.id,
              leaveYear: input.leaveYear,
              days: carried,
              reason: 'carry_forward',
              note: `Carried from ${leaveYearLabel(input.leaveYear - 1, input.startMonth)}, up to ${type.carryForwardCap} days`,
            },
            {
              employeeId: employee.id,
              leaveTypeId: type.id,
              leaveYear: input.leaveYear - 1,
              days: -carried,
              reason: 'carry_forward',
              note: `Carried to ${leaveYearLabel(input.leaveYear, input.startMonth)}`,
            },
          )
        }
      }
    }
  }

  return entries
}
