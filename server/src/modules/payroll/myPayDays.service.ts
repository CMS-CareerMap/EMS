import type { AppContext } from '../../platform/context'
import { Forbidden } from '../../platform/errors/AppError'
import { addCalendarDays, fromDateColumn, monthKey, toDateColumn, type CalendarDate } from '../../domain/shared/dates'
import { daysInMonth, employmentWindow } from '../../domain/payroll/salary'
import { leaveDaysIn, proration } from '../../domain/payroll/payDays'
import { companyToday } from '../organization/organization.service'
import { listDaysOff } from '../holidays/holidays.repository'
import { employmentWindow as employmentDates } from '../leave/leave.repository'
import * as repo from './payrollRun.repository'
import { inForceOn, lossOfPayOf } from './payrollRun.service'
import { closedMonthKeys } from './payrollLock.service'

/**
 * A person's own month in pay terms, for their Attendance page (client, 10
 * Oct 2026): the days paid and the days of loss of pay, worked out exactly as
 * the payroll run will (lossOfPayOf, proration) — so the page and the payslip
 * agree — with each day of approved leave named by its type, and each absent
 * day with whether leave can still be asked for it.
 *
 * Days still ahead count as paid, as they do in a run before the month ends:
 * the figures are "so far", and the payslip is final.
 */

/** How far back leave may be applied for by the person themselves (leave.service applyForLeave). */
const APPLY_DAYS_BACK = 90

export interface MyPayDays {
  year: number
  month: number
  employed: boolean
  /** Null when no pay rules were in force: nothing honest to say. */
  paidDays: number | null
  unpaidDays: number | null
  employmentDays: number
  /** Working days already past with nothing recorded — counted as paid, as payroll does. */
  notMarkedDays: number
  leaveDays: { date: CalendarDate; portion: number; paid: boolean; leaveTypeName: string; code: string }[]
  absentDays: {
    date: CalendarDate
    applied: boolean
    /** The leave asked for it, as it stands — waiting, or approved (a half day, or a day with a punch, stays Absent beside it). */
    leave: { status: 'pending' | 'approved'; leaveTypeName: string; half: boolean } | null
    canApply: boolean
    why: string | null
  }[]
}

export async function myPayDays(ctx: AppContext, year: number, month: number): Promise<MyPayDays> {
  const employeeId = ctx.employeeId
  if (!employeeId) throw Forbidden('Your account has no employee record, so there is no attendance of yours.')
  const key = monthKey(year, month)
  const monthStart = `${key}-01`
  const monthEnd = `${key}-${String(daysInMonth(year, month)).padStart(2, '0')}`
  const from = toDateColumn(monthStart)
  const to = toDateColumn(monthEnd)

  const [today, dates, policies, dayOffRows, attendance, leave] = await Promise.all([
    companyToday(ctx),
    employmentDates(ctx.db, employeeId),
    repo.policiesForMonth(ctx.db, from, to),
    listDaysOff(ctx.db, from, to),
    repo.attendanceForMonth(ctx.db, [employeeId], from, to),
    repo.leaveForMonth(ctx.db, [employeeId], from, to),
  ])
  const empty: MyPayDays = { year, month, employed: false, paidDays: null, unpaidDays: null, employmentDays: 0, notMarkedDays: 0, leaveDays: [], absentDays: [] }
  const window = employmentWindow({ year, month, dateOfJoining: fromDateColumn(dates?.dateOfJoining), lastWorkingDate: fromDateColumn(dates?.lastWorkingDate) })
  if (!window) return empty

  const policy = inForceOn(policies, window.from)
  const holidays = dayOffRows.map((row) => fromDateColumn(row.date)!)
  const { calendar, weeklyOffDays, lop } = lossOfPayOf({
    year, month, window,
    // With no pay rules yet, the days still have names — on Sunday off, as leave is counted then too
    // (leave.service leaveContext); the paid and unpaid figures stay null.
    policy: policy ?? { weeklyOffDays: [0], sandwichRule: false },
    holidays, attendance, leave, today,
  })
  const pay = policy ? proration({ lopBasis: policy.lopBasis, calendar, window, lopDays: lop.lopDays }) : null

  // Each day of approved leave, named by its type — one request at a time, so each day knows whose type it is.
  const leaveDays = leave
    .filter((row) => row.status === 'approved')
    .flatMap((row) => leaveDaysIn([{ from: fromDateColumn(row.fromDate)!, to: fromDateColumn(row.toDate)!, halfDays: row.halfDayDates, paid: row.leaveType.isPaid }], calendar, weeklyOffDays)
      .filter((d) => d.date >= window.from && d.date <= window.to)
      .map((d) => ({ date: d.date, portion: d.portion, paid: d.paid, leaveTypeName: row.leaveType.name, code: row.leaveType.code })))
    .sort((a, b) => a.date.localeCompare(b.date))

  // Absent working days so far, and whether leave can still be asked for them.
  // Only this month's own payroll closes it — as applying and approving check (assertMonthsOpen).
  // A weekly off or holiday marked absent costs nothing, and leave on it counts no days: not offered.
  const monthOpen = !(await closedMonthKeys(ctx)).has(key)
  const working = new Set(calendar.days.filter((d) => d.kind === 'working').map((d) => d.date))
  const earliest = addCalendarDays(today, -APPLY_DAYS_BACK)
  const absentDays = attendance
    .filter((row) => row.status === 'absent')
    .map((row) => fromDateColumn(row.date)!)
    .filter((date) => date <= today && date >= window.from && date <= window.to && working.has(date))
    .sort()
    .map((date) => {
      const asked = leave.find((l) => fromDateColumn(l.fromDate)! <= date && fromDateColumn(l.toDate)! >= date)
      const applied = Boolean(asked)
      const why = applied ? null
        : !monthOpen ? 'This month’s payroll is closed — ask HR.'
        : date < earliest ? `More than ${APPLY_DAYS_BACK} days ago — ask HR to record it.`
        : null
      return {
        date,
        applied,
        leave: asked
          ? { status: asked.status === 'approved' ? 'approved' as const : 'pending' as const, leaveTypeName: asked.leaveType.name, half: asked.halfDayDates.includes(date) }
          : null,
        canApply: !applied && why === null,
        why,
      }
    })

  return {
    year,
    month,
    employed: true,
    paidDays: pay ? pay.paidDays : null,
    unpaidDays: pay ? lop.lopDays : null,
    employmentDays: pay ? pay.employmentDays : calendar.days.filter((d) => d.date >= window.from && d.date <= window.to).length,
    notMarkedDays: lop.unmarked.length,
    leaveDays,
    absentDays,
  }
}
