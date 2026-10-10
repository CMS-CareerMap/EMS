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
 *   - A type with no annual quota (comp off; Loss of Pay, which has no limit)
 *     is granted case by case, or not at all — never here. What is left of
 *     one that carries forward still carries.
 *   - Somebody with days of their own for a type (EmployeeLeaveEntitlement,
 *     client 9 Oct 2026) is granted those, not the type's.
 *   - Somebody who joined partway through the year gets what the type gives a
 *     joiner (client, 9 Oct 2026): the months that are left, the joining month
 *     counted, as always; or the months after the joining month; or the full
 *     year. Rounded to the nearest half day.
 *   - Somebody who has already left gets nothing: their last working day has
 *     passed, or they are marked inactive. Somebody leaving later in the year
 *     is still here, and is granted. Nobody joining after the year ends is.
 *   - Unused days from last year carry in, up to the type's cap, for types
 *     that allow it — but only once last year has ENDED. Granted in advance,
 *     the new year gets its quota now and its carry when it begins (pressing
 *     Grant again then adds it). What is carried is last year's balance less
 *     the days still applied for in it, and the same days are written out of
 *     last year as they are written into this one, so a late application for
 *     a day in last year cannot spend them a second time. Where the caller
 *     says last year still has something of a type waiting, its carry waits
 *     too (10 Oct 2026): carried once, it is never topped up.
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

/** What a leave type grants somebody who joins partway through a leave year. */
export type JoinerGrant = 'months_left' | 'months_after_joining' | 'full_year'

export interface GrantLeaveType {
  id: string
  annualQuota: number
  carryForward: boolean
  carryForwardCap: number
  /** The months left when not given — the rule before there was a choice. */
  joinerGrant?: JoinerGrant
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

/** Whole months from one day's month to another's: 15 Jul → 1 Apr next year is 9. */
const monthsBetween = (a: CalendarDate, b: CalendarDate): number =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)))

/**
 * Whether a joining month is a month of theirs: always under the months-left
 * rule; under months-after-joining only when they joined on its first day — a
 * part month is what that rule leaves out, and somebody here from the 1st has
 * the whole month.
 */
const joiningMonthCounts = (joined: CalendarDate, joiner: JoinerGrant) => joiner !== 'months_after_joining' || joined.slice(8, 10) === '01'

/**
 * A year's days of a type for one person: the whole of them for somebody here
 * since before the year began; for somebody who joined in it, what the type
 * gives a joiner — the months left with the joining month counted (the rule
 * before there was a choice), the whole months left (a part month at joining
 * not counted), or the whole year. Nothing for somebody joining after it ends.
 */
export function proRatedQuota(
  quota: number,
  joined: CalendarDate | null,
  leaveYear: number,
  startMonth: number,
  joiner: JoinerGrant = 'months_left',
): number {
  const { from, nextFrom } = leaveYearBounds(leaveYear, startMonth)
  if (!joined || joined < from) return quota
  if (joined >= nextFrom) return 0
  if (joiner === 'full_year') return quota
  const months = monthsBetween(joined, nextFrom) - (joiningMonthCounts(joined, joiner) ? 0 : 1)
  // Joined on the year's first day: the whole year, as given.
  if (months >= 12) return quota
  return toHalfDays((quota * Math.max(0, months)) / 12)
}

/**
 * What part of a leave year somebody's grant covers, by the type's joiner
 * rule: 1 for the whole year, 0 for none, 6/12 for October to March. What a
 * corrected joining date changes is the share — the days it is a share of
 * stay what they were given.
 */
export function yearShare(joined: CalendarDate | null, leaveYear: number, startMonth: number, joiner: JoinerGrant = 'months_left'): number {
  const { from, nextFrom } = leaveYearBounds(leaveYear, startMonth)
  if (!joined || joined < from) return 1
  if (joined >= nextFrom) return 0
  if (joiner === 'full_year') return 1
  const months = monthsBetween(joined, nextFrom) - (joiningMonthCounts(joined, joiner) ? 0 : 1)
  return Math.min(12, Math.max(0, months)) / 12
}

/** The note a pro-rated grant carries: why it is not the year's full days. */
function proRataNote(joiner: JoinerGrant, joined: CalendarDate): string {
  return joiningMonthCounts(joined, joiner)
    ? `Pro-rated from joining on ${dayLabel(joined)}`
    : `Pro-rated from the month after joining on ${dayLabel(joined)}`
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
  /** This person's own days a year of the type, when they have their own; null or left out: the type's. */
  ownQuota?: ((employeeId: string, leaveTypeId: string) => number | null) | undefined
  /**
   * Whether last year has nothing of this type still waiting — no leave applied
   * for, no encashment asked. Until then nothing is carried: what is carried
   * once is never topped up, so days held by a request rejected later would
   * lapse. Left out: always settled.
   */
  lastYearSettled?: ((employeeId: string, leaveTypeId: string) => boolean) | undefined
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
      const quota = input.ownQuota?.(employee.id, type.id) ?? type.annualQuota

      if (quota > 0 && !done.has(`${employee.id}|${type.id}|opening_grant`)) {
        const joiner = type.joinerGrant ?? 'months_left'
        const days = proRatedQuota(quota, employee.dateOfJoining, input.leaveYear, input.startMonth, joiner)
        if (days > 0) {
          entries.push({
            employeeId: employee.id,
            leaveTypeId: type.id,
            leaveYear: input.leaveYear,
            days,
            reason: 'opening_grant',
            note: days === quota ? null : proRataNote(joiner, employee.dateOfJoining!),
          })
        }
      }

      // Last year's unused days, wherever they came from — a type given case by
      // case (comp off) carries as well as a yearly one — once nothing of it is
      // still waiting in last year.
      if (lastYearClosed && type.carryForward && !done.has(`${employee.id}|${type.id}|carry_forward`) && (input.lastYearSettled?.(employee.id, type.id) ?? true)) {
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

/**
 * What of a year's grant has been earned by a day, for a type that accrues
 * monthly (client §36): a twelfth for each month of the year reached — counted
 * from the month somebody joined, for a grant pro-rated from joining (from the
 * month after it, where the type gives nothing for the joining month) — rounded
 * to the half day. The month the day falls in counts as reached.
 */
export function accruedBy(input: {
  grant: number
  leaveYear: number
  startMonth: number
  joined: CalendarDate | null
  asOf: CalendarDate
  joinerGrant?: JoinerGrant | undefined
}): number {
  const { from, nextFrom } = leaveYearBounds(input.leaveYear, input.startMonth)
  const joinedIn = input.joined && input.joined >= from ? input.joined : null
  const firstOfMonth = (day: CalendarDate, plus: number): CalendarDate => {
    const index = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + plus
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`
  }
  const spanStart = joinedIn ? firstOfMonth(joinedIn, joiningMonthCounts(joinedIn, input.joinerGrant ?? 'months_left') ? 0 : 1) : from
  const span = monthsBetween(spanStart, nextFrom)
  if (span <= 0 || input.grant <= 0) return 0
  const reached = Math.max(0, Math.min(span, monthsBetween(spanStart, input.asOf) + 1))
  return toHalfDays((input.grant * reached) / span)
}
