import type { AttendanceStatus } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { toDateColumn, type CalendarDate } from '../../domain/shared/dates'

/**
 * No check-in means Absent (client, 25 Oct 2026): the reads and writes of the
 * rule. Every write names the state it expects the row to be in, so a row
 * somebody changed a moment ago is left as they left it.
 */

export interface AbsentRuleRow {
  absentWithoutCheckIn: boolean
  absentWithoutCheckInFrom: Date | null
  absentWaitDays: number
  timezone: string
}

export async function ruleOf(db: ScopedDb | TxDb, organizationId: string): Promise<AbsentRuleRow | null> {
  return db.organization.findUnique({
    where: { id: organizationId },
    select: { absentWithoutCheckIn: true, absentWithoutCheckInFrom: true, absentWaitDays: true, timezone: true },
  })
}

export async function saveRule(tx: TxDb, organizationId: string, data: { absentWithoutCheckIn: boolean; absentWithoutCheckInFrom: Date | null; absentWaitDays: number }) {
  return tx.organization.update({ where: { id: organizationId }, data })
}

/**
 * Everybody employed at some time between two days, with what decides when
 * their day is over — as payroll takes a month's people: somebody archived is
 * here up to their last working day; somebody inactive with none recorded is
 * left out, as payroll leaves them out.
 */
export async function peopleBetween(db: ScopedDb | TxDb, from: CalendarDate, to: CalendarDate) {
  const people = await db.employee.findMany({
    where: {
      AND: [
        { OR: [{ archivedAt: null }, { lastWorkingDate: { gte: toDateColumn(from) } }] },
        { OR: [{ dateOfJoining: null }, { dateOfJoining: { lte: toDateColumn(to) } }] },
        { OR: [{ lastWorkingDate: null }, { lastWorkingDate: { gte: toDateColumn(from) } }] },
      ],
    },
    select: {
      id: true,
      status: true,
      dateOfJoining: true,
      lastWorkingDate: true,
      attendanceMode: true,
      shift: { select: { startTime: true, endTime: true } },
      // When their record and their first login came to be: no day before them is theirs to have checked in on.
      createdAt: true,
      memberships: { select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 1 },
    },
  })
  return people.filter((p) => p.status === 'active' || p.lastWorkingDate !== null)
}

/** Every attendance row between two days — what each day already says. */
export async function rowsBetween(tx: TxDb, from: CalendarDate, to: CalendarDate) {
  return tx.attendance.findMany({
    where: { date: { gte: toDateColumn(from), lte: toDateColumn(to) } },
    select: { id: true, employeeId: true, date: true, status: true, source: true, checkIn: true, statusBeforeSystem: true },
  })
}

/** Approved leave touching two days. */
export async function approvedLeaveBetween(tx: TxDb, from: CalendarDate, to: CalendarDate) {
  return tx.leaveRequest.findMany({
    where: { status: 'approved', fromDate: { lte: toDateColumn(to) }, toDate: { gte: toDateColumn(from) } },
    select: { employeeId: true, fromDate: true, toDate: true, halfDayDates: true },
  })
}

/** Days off for everybody between two days: public holidays, and weekly-off rows kept from before the week was a setting. */
export async function daysOffBetween(tx: TxDb, from: CalendarDate, to: CalendarDate) {
  return tx.holiday.findMany({
    where: { date: { gte: toDateColumn(from), lte: toDateColumn(to) }, type: { in: ['public', 'weekly_off'] } },
    select: { date: true },
  })
}

/** The earliest day a row the rule wrote is on, from a day — where taking back has to look from. */
export async function earliestManaged(tx: ScopedDb | TxDb, from: CalendarDate): Promise<Date | null> {
  const row = await tx.attendance.findFirst({
    where: { date: { gte: toDateColumn(from) }, OR: [{ source: 'system' }, { statusBeforeSystem: { not: null } }] },
    orderBy: { date: 'asc' },
    select: { date: true },
  })
  return row?.date ?? null
}

export async function createAbsent(tx: TxDb, organizationId: string, days: { employeeId: string; date: CalendarDate }[]): Promise<number> {
  if (days.length === 0) return 0
  const result = await tx.attendance.createMany({
    data: days.map((d) => ({
      organizationId,
      employeeId: d.employeeId,
      date: toDateColumn(d.date),
      status: 'absent' as const,
      source: 'system' as const,
      note: 'No check-in',
    })),
    // Somebody's row written a moment ago is theirs: this one is not added.
    skipDuplicates: true,
  })
  return result.count
}

export async function removeAbsent(tx: TxDb, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  return (await tx.attendance.deleteMany({ where: { id: { in: ids }, source: 'system' } })).count
}

/** All of the day on leave now: the row says leave, as approving would have made it. */
export async function absentToLeave(tx: TxDb, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  return (await tx.attendance.updateMany({
    where: { id: { in: ids }, source: 'system' },
    data: { status: 'on_leave', source: 'leave', note: null },
  })).count
}

export async function convertHalfLeave(tx: TxDb, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  return (await tx.attendance.updateMany({
    where: { id: { in: ids }, status: 'on_leave', source: 'leave', checkIn: null, statusBeforeSystem: null },
    data: { status: 'absent', statusBeforeSystem: 'on_leave' },
  })).count
}

export async function restoreHalfLeave(tx: TxDb, rows: { id: string; to: AttendanceStatus }[]): Promise<number> {
  let count = 0
  for (const row of rows) {
    count += (await tx.attendance.updateMany({
      where: { id: row.id, status: 'absent', checkIn: null, statusBeforeSystem: { not: null } },
      data: { status: row.to, statusBeforeSystem: null },
    })).count
  }
  return count
}

export async function forgetBefore(tx: TxDb, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await tx.attendance.updateMany({ where: { id: { in: ids } }, data: { statusBeforeSystem: null } })
}
