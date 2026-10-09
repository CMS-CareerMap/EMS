import type { ScopedDb } from '../../platform/db/scoped'
import type { ScopeContext } from '../../platform/authz/scope'
import { employeesInScope } from '../../platform/authz/scopeWhere'
import { SHIFT_RULES_SELECT } from '../attendance/attendance.repository'

/**
 * The home page's own questions. Each reaches only as far as the scope it is
 * given — the caller's EMPLOYEE reach for the people section, their ATTENDANCE
 * reach for today — so one screen never mixes the two.
 */

/** Everybody the caller's employee reach covers, left people included, archived records not. */
export async function peopleInReach(db: ScopedDb, scope: ScopeContext) {
  return db.employee.findMany({
    where: { AND: [employeesInScope(scope), { archivedAt: null }] },
    select: {
      id: true,
      fullName: true,
      employeeCode: true,
      status: true,
      dateOfJoining: true,
      lastWorkingDate: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
    },
    orderBy: { fullName: 'asc' },
  })
}

/** These people's leave that touches the days from..to, still waiting or approved. */
export async function leaveTouching(db: ScopedDb, employeeIds: readonly string[], from: Date, to: Date) {
  if (employeeIds.length === 0) return []
  return db.leaveRequest.findMany({
    where: { employeeId: { in: [...employeeIds] }, status: { in: ['pending', 'approved'] }, fromDate: { lte: to }, toDate: { gte: from } },
    select: {
      employeeId: true,
      fromDate: true,
      toDate: true,
      status: true,
      leaveType: { select: { code: true, name: true } },
      employee: { select: { fullName: true } },
    },
    orderBy: [{ fromDate: 'asc' }],
  })
}

/** Their working-from-home and on-duty requests that touch the days from..to, still waiting or approved. */
export async function awayRequestsTouching(db: ScopedDb, employeeIds: readonly string[], from: Date, to: Date) {
  if (employeeIds.length === 0) return []
  return db.employeeRequest.findMany({
    where: {
      employeeId: { in: [...employeeIds] },
      type: { in: ['work_from_home', 'on_duty'] },
      status: { in: ['pending', 'approved'] },
      fromDate: { lte: to },
      toDate: { gte: from },
    },
    select: { employeeId: true, type: true, fromDate: true, toDate: true, status: true, employee: { select: { fullName: true } } },
    orderBy: [{ fromDate: 'asc' }],
  })
}

/** Company days off between two dates, with their names: public holidays, and weekly offs kept as rows. */
export async function daysOffBetween(db: ScopedDb, from: Date, to: Date) {
  return db.holiday.findMany({
    where: { date: { gte: from, lte: to }, type: { in: ['public', 'weekly_off'] } },
    select: { date: true, name: true, type: true },
  })
}

/** One person's days between two dates — their own last week on the home page. */
export async function myDays(db: ScopedDb, employeeId: string, from: Date, to: Date) {
  return db.attendance.findMany({
    where: { employeeId, date: { gte: from, lte: to } },
    // With the day's shift: whether an open day is still theirs depends on it (stillAtWork).
    select: { date: true, status: true, checkIn: true, checkOut: true, hoursWorked: true, lateMinutes: true, workMode: true, shift: { select: SHIFT_RULES_SELECT } },
    orderBy: { date: 'asc' },
  })
}
