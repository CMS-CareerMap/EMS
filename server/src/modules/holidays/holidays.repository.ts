import type { HolidayType } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'

/** The company's holiday calendar. */

export async function listForYear(db: ScopedDb, year?: number) {
  const where =
    year === undefined
      ? {}
      : { date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } }
  return db.holiday.findMany({ where, orderBy: [{ date: 'asc' }, { name: 'asc' }] })
}

export async function findById(db: ScopedDb, id: string) {
  return db.holiday.findFirst({ where: { id } })
}

/** The same holiday on the same day, whatever the capitalisation. */
export async function findSame(db: ScopedDb, date: Date, name: string) {
  return db.holiday.findFirst({ where: { date, name: { equals: name, mode: 'insensitive' } } })
}

export async function create(
  db: ScopedDb,
  organizationId: string,
  data: { date: Date; name: string; type: HolidayType },
) {
  return db.holiday.create({ data: { organizationId, ...data } })
}

export async function update(
  db: ScopedDb,
  id: string,
  data: { date?: Date; name?: string; type?: HolidayType },
) {
  return db.holiday.update({ where: { id }, data })
}

export async function remove(db: ScopedDb, id: string) {
  return db.holiday.delete({ where: { id } })
}

/**
 * Approved leave that covers a day — counted so the person changing the
 * calendar is told what their change does NOT recalculate.
 */
export async function countApprovedLeaveCovering(db: ScopedDb, date: Date) {
  return db.leaveRequest.count({
    where: { status: 'approved', fromDate: { lte: date }, toDate: { gte: date } },
  })
}

/**
 * Days nobody is expected to work between two dates, inclusive: public
 * holidays, and weekly-off rows kept from before the working week was a
 * setting. Optional holidays are each employee's own choice, so they do not
 * free a day for everybody.
 */
export async function listDaysOff(db: ScopedDb, from: Date, to: Date) {
  return db.holiday.findMany({
    where: { date: { gte: from, lte: to }, type: { in: ['public', 'weekly_off'] } },
    select: { date: true },
  })
}
