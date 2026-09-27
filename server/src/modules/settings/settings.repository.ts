import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'

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
  db: TxDb,
  organizationId: string,
  data: Record<string, unknown>,
) {
  return db.organization.update({ where: { id: organizationId }, data })
}

/** The policy in force now: the one row whose period has not been closed. */
export async function getCurrentPolicy(db: TxDb) {
  return db.organizationPolicy.findFirst({
    where: { effectiveTo: null },
    orderBy: { effectiveFrom: 'desc' },
  })
}

export async function listPolicies(db: ScopedDb) {
  return db.organizationPolicy.findMany({ orderBy: { effectiveFrom: 'desc' } })
}

export async function findPolicy(db: ScopedDb, id: string) {
  return db.organizationPolicy.findFirst({ where: { id } })
}

/**
 * Opens a policy period. `values` are the rates it starts with; anything not
 * given takes the schema's statutory default.
 */
export async function createPolicy(
  db: TxDb,
  period: { organizationId: string; effectiveFrom: Date; createdByUserId: string },
  values: Record<string, unknown> = {},
) {
  return db.organizationPolicy.create({ data: { ...period, ...values } })
}

/** Changes a period in place — a same-day correction. */
export async function updatePolicy(db: TxDb, id: string, values: Record<string, unknown>) {
  return db.organizationPolicy.update({ where: { id }, data: values })
}

/** Ends a period on `effectiveTo`, the day before its successor starts. */
export async function closePolicy(db: TxDb, id: string, effectiveTo: Date) {
  return db.organizationPolicy.update({ where: { id }, data: { effectiveTo } })
}

export async function listGeofences(db: ScopedDb) {
  return db.geofenceLocation.findMany({ orderBy: { name: 'asc' } })
}

export interface GeofenceValues {
  latitude: number
  longitude: number
  radiusMeters: number
  maxAccuracyMeters?: number
  isActive?: boolean
}

export async function findGeofence(db: ScopedDb, id: string) {
  return db.geofenceLocation.findFirst({ where: { id } })
}

/** The fence a punch-in is checked against. */
export async function findActiveGeofence(db: ScopedDb) {
  return db.geofenceLocation.findFirst({ where: { isActive: true } })
}

export async function findGeofenceByName(db: ScopedDb, name: string) {
  return db.geofenceLocation.findFirst({ where: { name } })
}

export async function createGeofence(db: TxDb, organizationId: string, name: string, values: GeofenceValues) {
  return db.geofenceLocation.create({ data: { organizationId, name, ...values } })
}

export async function updateGeofence(db: TxDb, id: string, values: GeofenceValues) {
  return db.geofenceLocation.update({ where: { id }, data: values })
}

export async function deleteGeofence(db: TxDb, id: string) {
  return db.geofenceLocation.delete({ where: { id } })
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

export interface LeaveTypeValues {
  name: string
  code: string
  annualQuota: number
  isPaid: boolean
  carryForward: boolean
  carryForwardCap: number
}

export async function createLeaveType(db: TxDb, organizationId: string, values: LeaveTypeValues) {
  return db.leaveType.create({ data: { organizationId, ...values } })
}

/** Brings an archived type back with new values; its ledger history comes with it. */
export async function restoreLeaveType(db: TxDb, id: string, values: LeaveTypeValues) {
  return db.leaveType.update({ where: { id }, data: { ...values, archivedAt: null } })
}

export async function updateLeaveType(db: TxDb, id: string, values: Record<string, unknown>) {
  return db.leaveType.update({ where: { id }, data: values })
}

export async function archiveLeaveType(db: TxDb, id: string, at: Date) {
  return db.leaveType.update({ where: { id }, data: { archivedAt: at } })
}

export async function listPtSlabs(db: ScopedDb, state?: string) {
  return db.ptSlab.findMany({
    where: { effectiveTo: null, ...(state ? { state } : {}) },
    orderBy: [{ state: 'asc' }, { minGross: 'asc' }],
  })
}

/** A state's table as it stands — the slabs nobody has closed. */
export async function listOpenPtSlabsForState(db: TxDb, state: string) {
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
 * Puts a state's new table in place: the old slabs are either removed (a
 * correction on the day they started) or closed the day before the new ones
 * begin (a revision). On the caller's transaction — half of that happening
 * would leave two tables in force at once, or none.
 */
export async function replacePtTable(
  db: TxDb,
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
  if (input.deleteIds.length > 0) {
    await db.ptSlab.deleteMany({ where: { id: { in: input.deleteIds } } })
  }
  if (input.closeIds.length > 0 && input.closeOn) {
    await db.ptSlab.updateMany({ where: { id: { in: input.closeIds } }, data: { effectiveTo: input.closeOn } })
  }
  await db.ptSlab.createMany({
    data: input.rows.map((row) => ({
      organizationId,
      state: input.state,
      effectiveFrom: input.effectiveFrom,
      ...row,
    })),
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
