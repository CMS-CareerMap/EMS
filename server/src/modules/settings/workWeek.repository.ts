import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { fromDateColumn, toDateColumn, type CalendarDate } from '../../domain/shared/dates'
import { workWeek, type Weekday, type WorkWeek } from '../../domain/shared/workWeek'

/**
 * The company's working week, dated (client, 25 Oct 2026). Every module that
 * asks whether a day is a weekly off reads it HERE, and asks the domain
 * (`isWeeklyOff`, `offDaysOn`) — never a weekday list of its own.
 */

export interface WorkWeekRow {
  id: string
  effectiveFrom: Date
  weeklyOffDays: number[]
  createdByUserId: string | null
  createdAt: Date
}

export async function workWeekRows(db: ScopedDb | TxDb): Promise<WorkWeekRow[]> {
  return db.workWeek.findMany({
    orderBy: { effectiveFrom: 'asc' },
    select: { id: true, effectiveFrom: true, weeklyOffDays: true, createdByUserId: true, createdAt: true },
  })
}

export function toWorkWeek(rows: readonly WorkWeekRow[]): WorkWeek {
  return workWeek(rows.map((row) => ({ from: fromDateColumn(row.effectiveFrom), offDays: row.weeklyOffDays as Weekday[] })))
}

/** The working week over time, for counting days. */
export async function workWeekOf(db: ScopedDb | TxDb): Promise<WorkWeek> {
  return toWorkWeek(await workWeekRows(db))
}

/** Removes the rules that begin on or after a day — replaced by one from it. */
export async function removeFrom(tx: TxDb, from: CalendarDate): Promise<void> {
  await tx.workWeek.deleteMany({ where: { effectiveFrom: { gte: toDateColumn(from) } } })
}

export async function removeOn(tx: TxDb, from: CalendarDate): Promise<number> {
  return (await tx.workWeek.deleteMany({ where: { effectiveFrom: toDateColumn(from) } })).count
}

export async function create(tx: TxDb, organizationId: string, from: CalendarDate, offDays: readonly Weekday[], createdByUserId: string | null) {
  return tx.workWeek.create({
    data: { organizationId, effectiveFrom: toDateColumn(from), weeklyOffDays: [...offDays], createdByUserId },
  })
}

/** Approved leave running on or after a day — what a change of the working week from it did not recount. */
export async function approvedLeaveFrom(db: ScopedDb | TxDb, from: CalendarDate) {
  return db.leaveRequest.findMany({
    where: { status: 'approved', toDate: { gte: toDateColumn(from) }, leaveType: { countsNonWorkingDays: false } },
    select: { id: true, fromDate: true, toDate: true },
  })
}
