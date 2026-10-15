import type { AppContext } from '../../platform/context'
import { BadRequest, NotFound } from '../../platform/errors/AppError'
import { addCalendarDays, fromDateColumn, toDateColumn, zonedToday, type CalendarDate } from '../../domain/shared/dates'
import { shiftRulesOf, stillAtWork } from '../../domain/attendance/shiftRules'
import { monthSoFar, type MonthSoFar } from '../../domain/attendance/monthSoFar'
import { companyTimezone, companyToday } from '../organization/organization.service'
import { payDaysFor, type MyPayDays } from '../payroll/myPayDays.service'
import { monthCalendar, type MonthCalendar } from './attendanceAdmin.service'
import * as repo from './attendance.repository'
import { isInScope } from '../../platform/authz/scopeWhere'

/**
 * One person's month of attendance (client, 15 Oct 2026): the page HR or a
 * manager opens by a name on Attendance — the person's calendar, their days
 * one by one, and the month so far, counted to today — and the person's own
 * figures on their own Attendance page. Everything the page needs, in one
 * answer, read through the caller's ATTENDANCE reach: somebody outside it is
 * a 404, not an empty month.
 */

export interface PersonMonth {
  person: NonNullable<Awaited<ReturnType<typeof repo.personForMonth>>>
  year: number
  month: number
  today: CalendarDate
  days: repo.AttendanceRow[]
  calendar: MonthCalendar
  payDays: MyPayDays
  totals: MonthSoFar
  /** The check-in of the day they are still at work on, in this month — the page adds the time since, live. Null otherwise. */
  openSince: Date | null
  /** That day: today, or yesterday for a night shift past midnight. */
  openDay: CalendarDate | null
  /** Their last day here: the last working day, or the day they were removed; null while employed. */
  employedUntil: CalendarDate | null
}

export async function personMonth(ctx: AppContext, employeeId: string, year: number, month: number): Promise<PersonMonth> {
  if (month < 1 || month > 12) throw BadRequest('Month must be between 1 and 12')
  const scope = ctx.scopeFor('attendance')
  const person = await repo.personForMonth(ctx.db, scope, employeeId)
  if (!person) throw NotFound('That person’s attendance is not one you see.')

  const [days, calendar, payDays, today, timezone] = await Promise.all([
    repo.list(ctx.db, scope, { year, month, employeeId }),
    monthCalendar(ctx, year, month),
    payDaysFor(ctx, employeeId, year, month, { own: employeeId === ctx.employeeId }),
    companyToday(ctx),
    companyTimezone(ctx),
  ])
  // Removed with no last working day (somebody who never joined): counted to the day they were removed, as payroll and the reports do.
  const left = fromDateColumn(person.lastWorkingDate) ?? (person.archivedAt ? zonedToday(person.archivedAt, timezone) : null)

  const totals = monthSoFar({
    year,
    month,
    today,
    joined: fromDateColumn(person.dateOfJoining),
    left,
    daysOff: calendar.daysOff,
    rows: days.map((d) => ({
      date: fromDateColumn(d.date),
      status: d.status,
      hoursWorked: d.hoursWorked == null ? null : Number(d.hoursWorked),
      lateMinutes: d.lateMinutes,
      checkedIn: d.checkIn !== null,
    })),
    expectedPerDay: person.shift ? Number(person.shift.expectedHours) : null,
  })
  const open = await openDayOf(ctx, person, today, timezone)
  // Live only in the month the open day belongs to: its hours are that day's.
  const openHere = open && totals.from && totals.to && open.date >= totals.from && open.date <= totals.to ? open : null

  // Which leave a day was, and leave asked for an absent day, are their LEAVE:
  // shown to whoever's leave reach takes them in too — a role made to see the
  // company's attendance but nobody's leave sees the days and the pay counts only.
  const own = employeeId === ctx.employeeId
  const seesLeave = own || (ctx.can('leave:read') && isInScope(ctx.scopeFor('leave'), person))

  return {
    person,
    year,
    month,
    today,
    days,
    calendar,
    payDays: seesLeave ? payDays : withoutLeave(payDays),
    totals,
    openSince: openHere?.since ?? null,
    openDay: openHere?.date ?? null,
    employedUntil: left,
  }
}

/**
 * The day they are at work on now, if any, and since when — by the rule their
 * own card and the roster count by (stillAtWork): today's open day; or, for
 * somebody who checks in on the app, yesterday's while a night shift carries
 * it past midnight and they have not checked in today.
 */
async function openDayOf(ctx: AppContext, person: { id: string; attendanceMode: string }, today: CalendarDate, timezone: string): Promise<{ date: CalendarDate; since: Date } | null> {
  const yesterday = addCalendarDays(today, -1)
  const [todays, yesterdays] = await Promise.all([
    repo.findDayWithShift(ctx.db, person.id, toDateColumn(today)),
    person.attendanceMode === 'app' ? repo.findDayWithShift(ctx.db, person.id, toDateColumn(yesterday)) : Promise.resolve(null),
  ])
  const now = new Date()
  if (todays?.checkIn && !todays.checkOut && todays.checkIn.getTime() <= now.getTime()) return { date: today, since: todays.checkIn }
  if (yesterdays?.checkIn && stillAtWork({
    date: yesterday, today, checkIn: yesterdays.checkIn, checkOut: yesterdays.checkOut, rules: shiftRulesOf(yesterdays.shift),
    timezone, now, checkedInToday: Boolean(todays?.checkIn),
  })) return { date: yesterday, since: yesterdays.checkIn }
  return null
}

/** The month in pay terms without the leave in it: the counts, and nothing of which leave or what was asked. */
function withoutLeave(payDays: MyPayDays): MyPayDays {
  return { ...payDays, leaveDays: [], absentDays: payDays.absentDays.map((d) => ({ ...d, applied: false, leave: null, why: null })) }
}
