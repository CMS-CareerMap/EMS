import type { ScopedDb } from '../../platform/db/scoped'

/**
 * Company configuration.
 *
 * Every query goes through the scoped client, so "this company's settings" is
 * enforced by the extension rather than remembered by each function.
 */

export async function getOrganization(db: ScopedDb, organizationId: string) {
  // Organization is a GLOBAL model — it is the company, not a row inside one —
  // so this is the one read here that needs its id passed explicitly.
  return db.organization.findUnique({ where: { id: organizationId } })
}

export async function updateOrganization(
  db: ScopedDb,
  organizationId: string,
  data: Record<string, unknown>,
) {
  return db.organization.update({ where: { id: organizationId }, data })
}

/** The policy in force now: the one row whose period has not been closed. */
export async function getCurrentPolicy(db: ScopedDb) {
  return db.organizationPolicy.findFirst({
    where: { effectiveTo: null },
    orderBy: { effectiveFrom: 'desc' },
  })
}

export async function listPolicies(db: ScopedDb) {
  return db.organizationPolicy.findMany({ orderBy: { effectiveFrom: 'desc' } })
}

export async function listGeofences(db: ScopedDb) {
  return db.geofenceLocation.findMany({ orderBy: { name: 'asc' } })
}

export async function listLeaveTypes(db: ScopedDb) {
  return db.leaveType.findMany({
    where: { archivedAt: null },
    orderBy: { code: 'asc' },
  })
}

export async function findLeaveType(db: ScopedDb, id: string) {
  // findFirst, not findUnique — the company filter has to apply.
  return db.leaveType.findFirst({ where: { id, archivedAt: null } })
}

export async function listPtSlabs(db: ScopedDb, state?: string) {
  return db.ptSlab.findMany({
    where: { effectiveTo: null, ...(state ? { state } : {}) },
    orderBy: [{ state: 'asc' }, { minGross: 'asc' }],
  })
}

/** A state's table as it stands — the slabs nobody has closed. */
export async function listOpenPtSlabsForState(db: ScopedDb, state: string) {
  return db.ptSlab.findMany({
    where: { state: { equals: state, mode: 'insensitive' }, effectiveTo: null },
    orderBy: [{ gender: 'asc' }, { minGross: 'asc' }],
  })
}

export interface PtRow {
  gender: 'male' | 'female' | 'any'
  minGross: number
  maxGross: number | null
  amount: number
  februaryAmount: number | null
}

/**
 * Puts a state's new table in place, in one transaction: the old slabs are
 * either removed (a correction on the day they started) or closed the day
 * before the new ones begin (a revision). Half of that happening would leave
 * two tables in force at once, or none.
 */
export async function replacePtTable(
  db: ScopedDb,
  organizationId: string,
  input: {
    state: string
    effectiveFrom: Date
    deleteIds: string[]
    closeIds: string[]
    closeOn: Date | null
    rows: PtRow[]
  },
) {
  return db.$transaction(async (tx) => {
    if (input.deleteIds.length > 0) {
      await tx.ptSlab.deleteMany({ where: { id: { in: input.deleteIds } } })
    }
    if (input.closeIds.length > 0 && input.closeOn) {
      await tx.ptSlab.updateMany({ where: { id: { in: input.closeIds } }, data: { effectiveTo: input.closeOn } })
    }
    await tx.ptSlab.createMany({
      data: input.rows.map((row) => ({
        organizationId,
        state: input.state,
        effectiveFrom: input.effectiveFrom,
        ...row,
      })),
    })
  })
}

/** Whether any leave has been granted or taken — the leave year is fixed after that. */
export async function countLeaveLedgerEntries(db: ScopedDb) {
  return db.leaveLedgerEntry.count()
}

/** Leave types matching a code or a name, archived or not, whatever the case. */
export async function findLeaveTypesLike(db: ScopedDb, code: string | undefined, name: string | undefined) {
  const or = [
    ...(code ? [{ code: { equals: code, mode: 'insensitive' as const } }] : []),
    ...(name ? [{ name: { equals: name, mode: 'insensitive' as const } }] : []),
  ]
  if (or.length === 0) return []
  return db.leaveType.findMany({ where: { OR: or } })
}
