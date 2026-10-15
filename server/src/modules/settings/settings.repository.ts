import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { equalsInsensitive } from '../../platform/db/insensitive'
import type { PunchMethod } from '../../domain/attendance/punchMethod'

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

export async function findGeofence(db: ScopedDb | TxDb, id: string) {
  return db.geofenceLocation.findFirst({ where: { id } })
}

/** The fence a punch is checked against: the one office — the last saved, should two ever be on. */
export async function findActiveGeofence(db: ScopedDb | TxDb) {
  return db.geofenceLocation.findFirst({ where: { isActive: true }, orderBy: { updatedAt: 'desc' } })
}

/** One office: every other location switched off once this one is saved on. */
export async function retireOtherGeofences(tx: TxDb, keepId: string) {
  await tx.geofenceLocation.updateMany({ where: { id: { not: keepId }, isActive: true }, data: { isActive: false } })
}

export async function findGeofenceByName(db: ScopedDb | TxDb, name: string) {
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

/**
 * Settings → Attendance Security (client, 11 and 14 Oct 2026): the punch
 * method, one phone, and the fingerprint machine's file. The switches the
 * method replaced (punchCheckOutLocation, punchPhoneOnly, punchSelfie) are
 * left in the table for one release and read by nothing.
 */
export const ATTENDANCE_SECURITY_FIELDS = {
  punchMethod: true,
  punchMachineMatch: true,
  punchMachineMinutes: true,
  punchMachineMissing: true,
  punchMachineFills: true,
  punchSelfieKeepDays: true,
  punchOneDevice: true,
} as const

export type AttendanceSecurity = {
  punchMethod: PunchMethod
  punchMachineMatch: boolean
  punchMachineMinutes: number
  punchMachineMissing: 'flag' | 'absent'
  punchMachineFills: boolean
  punchSelfieKeepDays: number
  punchOneDevice: boolean
}

export async function attendanceSecurityOf(db: ScopedDb | TxDb, organizationId: string): Promise<AttendanceSecurity | null> {
  return db.organization.findUnique({ where: { id: organizationId }, select: ATTENDANCE_SECURITY_FIELDS })
}

/** `legacy`: the old switch the version before still reads, kept in step for one release. */
export async function saveAttendanceSecurity(tx: TxDb, organizationId: string, data: Partial<AttendanceSecurity>, legacy: { punchSelfie?: boolean } = {}): Promise<AttendanceSecurity> {
  return tx.organization.update({ where: { id: organizationId }, data: { ...data, ...legacy }, select: ATTENDANCE_SECURITY_FIELDS })
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
  minNoticeDays: number
  maxDaysPerRequest: number | null
  eligibleAfterDays: number
  eligibleGender: 'male' | 'female' | 'other' | null
  accrual: 'yearly' | 'monthly'
  halfDayAllowed: boolean
  countsNonWorkingDays: boolean
  encashable: boolean
  encashMaxDaysPerYear: number | null
  joinerGrant: 'months_left' | 'months_after_joining' | 'full_year'
  usableAfterConfirmation: boolean
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
    where: { state: equalsInsensitive(state), effectiveTo: null },
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
    ...(code ? [{ code: equalsInsensitive(code) }] : []),
    ...(name ? [{ name: equalsInsensitive(name) }] : []),
  ]
  if (or.length === 0) return []
  return db.leaveType.findMany({ where: { OR: or } })
}

// ── What counts as PF wages ─────────────────────────────────────────────────

const pfComponentSelect = { id: true, code: true, label: true, type: true, entry: true, countsForPf: true, displayOrder: true } as const

/** Every earning component the company uses — the ones PF wages may be made of. */
export async function listEarningComponents(db: ScopedDb) {
  return db.salaryComponent.findMany({
    where: { type: 'earning', archivedAt: null },
    select: pfComponentSelect,
    orderBy: { displayOrder: 'asc' },
  })
}

export async function findSalaryComponent(db: TxDb, id: string) {
  return db.salaryComponent.findFirst({ where: { id, archivedAt: null }, select: pfComponentSelect })
}

export async function setCountsForPf(tx: TxDb, id: string, countsForPf: boolean): Promise<void> {
  await tx.salaryComponent.update({ where: { id }, data: { countsForPf } })
}
