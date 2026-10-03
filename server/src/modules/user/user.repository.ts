import type { AccountStatus, Prisma } from '@prisma/client'
import type { PersonPlace } from '../../platform/authz/scopeWhere'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { unsafeDb } from '../../platform/db/unsafe'
import { SUPER_ADMIN_ROLE } from '../../platform/authz/defaultRoles'

/**
 * Memberships — who may sign in to this company, and as what.
 *
 * Membership is tenant-scoped, so `db` (a forOrg client) confines every query
 * here to one organization automatically. The User rows behind them are global,
 * which is why a few operations reach for the unscoped client: a user's tokens
 * and password are not owned by a company.
 */

export interface MembershipRow {
  id: string
  userId: string
  /** The role's key. Its name, for the screen, is `roleName`. */
  role: string
  roleName: string
  status: AccountStatus
  email: string
  fullName: string | null
  employeeId: string | null
  employeeCode: string | null
  /** The person has left the company: their logins are closed for good. */
  personLeft: boolean
  createdAt: Date
}

const membershipSelect = {
  id: true,
  userId: true,
  role: true,
  roleDef: { select: { name: true } },
  status: true,
  createdAt: true,
  user: { select: { email: true } },
  employee: { select: { id: true, fullName: true, employeeCode: true, archivedAt: true } },
} as const

type RawMembership = {
  id: string
  userId: string
  role: string
  roleDef: { name: string }
  status: AccountStatus
  createdAt: Date
  user: { email: string }
  employee: { id: string; fullName: string; employeeCode: string; archivedAt: Date | null } | null
}

function flatten(row: RawMembership): MembershipRow {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role,
    roleName: row.roleDef.name,
    status: row.status,
    email: row.user.email,
    fullName: row.employee?.fullName ?? null,
    employeeId: row.employee?.id ?? null,
    employeeCode: row.employee?.employeeCode ?? null,
    personLeft: Boolean(row.employee?.archivedAt),
    createdAt: row.createdAt,
  }
}

/** Every login — or, given an employee filter, only the logins of the people it matches. */
export async function listMemberships(db: ScopedDb, employees: Prisma.EmployeeWhereInput | null = null): Promise<MembershipRow[]> {
  const rows = (await db.membership.findMany({
    ...(employees ? { where: { employee: employees } } : {}),
    select: membershipSelect,
    orderBy: { createdAt: 'asc' },
  })) as RawMembership[]
  return rows.map(flatten)
}

/** Where a login's person sits — for whether a narrower reach covers them. Null for a login with no employee record. */
export async function employeePlaceOf(db: TxDb, membershipId: string): Promise<PersonPlace | null> {
  const row = await db.membership.findFirst({
    where: { id: membershipId },
    select: { employee: { select: { id: true, reportingManagerId: true, departmentId: true } } },
  })
  return row?.employee ?? null
}

export async function findMembership(db: ScopedDb, id: string): Promise<MembershipRow | null> {
  // findFirst, not findUnique: findUnique takes only the unique key, so the
  // company filter could not be applied and an id from another organization
  // would resolve. Scoped or nothing.
  const row = (await db.membership.findFirst({
    where: { id },
    select: membershipSelect,
  })) as RawMembership | null

  return row ? flatten(row) : null
}

export async function findMembershipByEmail(
  db: ScopedDb,
  email: string,
): Promise<MembershipRow | null> {
  const row = (await db.membership.findFirst({
    where: { user: { email: email.toLowerCase().trim() } },
    select: membershipSelect,
  })) as RawMembership | null

  return row ? flatten(row) : null
}

/**
 * How many active super admins this company has.
 *
 * Read inside the same transaction as the change that depends on it, so two
 * simultaneous demotions cannot both see a count of two and both proceed —
 * leaving the company with none.
 */
export async function countActiveSuperAdmins(db: TxDb): Promise<number> {
  return db.membership.count({ where: { role: SUPER_ADMIN_ROLE, status: 'active' } })
}

export async function setRole(db: TxDb, membershipId: string, role: string): Promise<void> {
  await db.membership.update({ where: { id: membershipId }, data: { role } })
}

export async function setStatus(
  db: TxDb,
  membershipId: string,
  status: AccountStatus,
): Promise<void> {
  await db.membership.update({ where: { id: membershipId }, data: { status } })
}

/** Role, status and person only — what the role-change invariants are checked against. */
export async function findMembershipForChange(db: TxDb, id: string) {
  return db.membership.findFirst({
    where: { id },
    select: { id: true, role: true, status: true, employeeId: true, employee: { select: { fullName: true, archivedAt: true } } },
  })
}

/** Every login of one person (Day 23): leaving closes them all together. */
export async function loginsOfPerson(db: TxDb, employeeId: string) {
  return db.membership.findMany({
    where: { employeeId },
    select: { id: true, userId: true, role: true, status: true, employeeId: true },
    orderBy: { createdAt: 'asc' },
  })
}

/** Somebody already here, and their logins — for giving them another one. */
export async function personForLogin(db: TxDb, employeeId: string) {
  return db.employee.findFirst({
    where: { id: employeeId },
    select: { id: true, fullName: true, archivedAt: true, memberships: { select: { role: true, status: true } } },
  })
}

/**
 * A login for somebody with none in this company: their User — reused if they
 * already have one, since the same person can belong to two companies — an
 * `invited` Membership, and the hashed invitation token.
 *
 * On the caller's transaction, so it lands together with whatever else is
 * being created (an employee record, a whole import), or not at all.
 */
export async function createInvitedLogin(
  db: TxDb,
  input: {
    email: string
    organizationId: string
    role: string
    tokenHash: string
    expiresAt: Date
    createdByUserId: string
    /** The person it belongs to; null for an operator with no employee record. */
    employeeId: string | null
  },
): Promise<{ userId: string; membershipId: string }> {
  const existing = await db.user.findUnique({ where: { email: input.email }, select: { id: true } })
  const user = existing ?? (await db.user.create({ data: { email: input.email, passwordHash: null } }))

  const membership = await db.membership.create({
    data: { userId: user.id, organizationId: input.organizationId, role: input.role, status: 'invited', employeeId: input.employeeId },
  })

  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      purpose: 'invite',
      createdByUserId: input.createdByUserId,
    },
  })

  return { userId: user.id, membershipId: membership.id }
}

/** Whether a login's User has ever set a password — an invitation that was used. */
export async function hasPassword(db: TxDb, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
  return Boolean(user?.passwordHash)
}

/**
 * Takes back an invitation nobody used: the login goes, its links go, and its
 * User goes too when nothing else holds it — a mistyped address leaves no
 * trace but the audit row. On the caller's transaction.
 */
export async function deleteUnusedLogin(db: TxDb, membershipId: string, userId: string): Promise<void> {
  await db.membership.delete({ where: { id: membershipId } })
  await db.passwordResetToken.deleteMany({ where: { userId, usedAt: null } })
  // The User is global: counted across every company, not only this one.
  const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true, _count: { select: { memberships: true } } } })
  if (user && user._count.memberships === 0 && !user.passwordHash) await db.user.delete({ where: { id: userId } })
}

/** Global: a user's sessions are not owned by a company. */
export async function revokeSessions(userId: string): Promise<void> {
  await unsafeDb.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  await unsafeDb.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  })
}

export async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  return unsafeDb.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: { id: true },
  })
}

/**
 * Issues a fresh password link, killing any this person still holds.
 *
 * One live link per person. Two in circulation — the first "lost", the second
 * sent to replace it — means the first still works when it turns up in
 * somebody else's inbox.
 */
export async function replacePasswordLink(
  db: TxDb,
  input: {
    userId: string
    tokenHash: string
    expiresAt: Date
    purpose: 'invite' | 'reset'
    createdByUserId: string
  },
): Promise<void> {
  // On the caller's transaction: the old links die, the new one is born and
  // the audit row is written together, or none of it happens.
  await db.passwordResetToken.updateMany({
    where: { userId: input.userId, usedAt: null },
    data: { usedAt: new Date() },
  })
  await db.passwordResetToken.create({ data: input })
}
