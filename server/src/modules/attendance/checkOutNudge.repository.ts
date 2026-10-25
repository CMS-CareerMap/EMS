import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'

/** The reads and writes of the check-out reminder (client, 25 Oct 2026). */

export async function openDays(db: ScopedDb | TxDb, from: Date, to: Date) {
  return db.attendance.findMany({
    where: { date: { gte: from, lte: to }, checkIn: { not: null }, checkOut: null, checkOutNudgedAt: null, source: 'punch' },
    select: {
      id: true,
      employeeId: true,
      date: true,
      checkIn: true,
      shift: { select: { startTime: true, endTime: true } },
      employee: { select: { attendanceMode: true, archivedAt: true, shift: { select: { startTime: true, endTime: true } } } },
    },
  })
}

/** Told — only if it is still open and nobody told them a moment ago. */
export async function markNudged(tx: TxDb, id: string, at: Date): Promise<boolean> {
  return (await tx.attendance.updateMany({ where: { id, checkOut: null, checkOutNudgedAt: null }, data: { checkOutNudgedAt: at } })).count === 1
}

export async function timezoneOf(db: ScopedDb, organizationId: string): Promise<string> {
  return (await db.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } }))?.timezone ?? 'Asia/Kolkata'
}
