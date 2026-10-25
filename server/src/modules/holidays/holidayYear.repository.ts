import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { toDateColumn, type CalendarDate } from '../../domain/shared/dates'

/** The nightly job's two holiday markers (client, 25 Oct 2026), and the company's zone. */
export async function markersOf(db: ScopedDb | TxDb, organizationId: string) {
  return db.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true, fixedHolidaysThrough: true, holidayReminderYear: true },
  })
}

export async function setMarkers(tx: TxDb, organizationId: string, data: { fixedHolidaysThrough?: number; holidayReminderYear?: number }) {
  await tx.organization.update({ where: { id: organizationId }, data })
}

/** Whether anything is entered on a day — a company that renamed its Gandhi Jayanti keeps its own. */
export async function enteredOn(tx: TxDb, date: CalendarDate): Promise<boolean> {
  return (await tx.holiday.count({ where: { date: toDateColumn(date) } })) > 0
}

export async function addPublic(tx: TxDb, organizationId: string, date: CalendarDate, name: string) {
  return tx.holiday.create({ data: { organizationId, date: toDateColumn(date), name, type: 'public' } })
}

/** The holidays entered for a year. */
export async function holidaysOfYear(db: ScopedDb | TxDb, year: number) {
  return db.holiday.findMany({
    where: { date: { gte: toDateColumn(`${year}-01-01`), lte: toDateColumn(`${year}-12-31`) } },
    select: { date: true, name: true },
  })
}
