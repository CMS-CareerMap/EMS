import type { AccountStatus, Prisma } from '@prisma/client'
import type { PersonPlace } from '../../platform/authz/scopeWhere'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { unsafeDb } from '../../platform/db/unsafe'
import { SUPER_ADMIN_ROLE } from '../../platform/authz/defaultRoles'
import type { PasswordRules } from '../../domain/org/passwords'

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
  /** The Super Admin's role: whose password is always their own. */
  roleLocked: boolean
  status: AccountStatus
  /** Null for an employee login with no email: it signs in with the Employee ID. */
  email: string | null
  /** Whether a password is set — false for a login still waiting for one. */
  hasPassword: boolean
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
  roleDef: { select: { name: true, locked: true } },
  status: true,
  createdAt: true,
  // The hash is read only to say whether there is one; flatten() drops it.
  user: { select: { email: true, passwordHash: true } },
  employee: { select: { id: true, fullName: true, employeeCode: true, archivedAt: true } },
} as const

type RawMembership = {
  id: string
  userId: string
  role: string
  roleDef: { name: string; locked: boolean }
  status: AccountStatus
  createdAt: Date
  user: { email: string | null; passwordHash: string | null }
  employee: { id: string; fullName: string; employeeCode: string; archivedAt: Date | null } | null
}

function flatten(row: RawMembership): MembershipRow {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role,
    roleName: row.roleDef.name,
    roleLocked: row.roleDef.locked,
    status: row.status,
    email: row.user.email,
    hasPassword: Boolean(row.user.passwordHash),
    fullName: row.employee?.fullName ?? null,
    employeeId: row.employee?.id ?? null,
    employeeCode: row.employee?.employeeCode ?? null,
    personLeft: Boolean(row.employee?.archivedAt),
    createdAt: row.createdAt,
  }
}

/** The company's password rules (Settings → Users & Roles → Passwords). */
export async function passwordRules(db: TxDb | ScopedDb, organizationId: string): Promise<PasswordRules> {
  const org = await db.organization.findFirst({
    where: { id: organizationId },
    select: { employeePasswords: true, rolePasswords: true, passwordMinLength: true },
  })
  if (!org) throw new Error(`Organization ${organizationId} not found`)
  return org
}

export async function updatePasswordRules(db: TxDb, organizationId: string, rules: PasswordRules): Promise<void> {
  await db.organization.update({ where: { id: organizationId }, data: rules })
}

/**
 * Spends every link still out for one kind of login of the company — its
 * employee logins, or its role logins (not a Super Admin's, whose password is
 * always their own). Returns how many.
 */
export async function spendLinksOfKind(db: TxDb, input: { organizationId: string; kind: 'employee' | 'role'; employeeRole: string; now: Date }): Promise<number> {
  const logins = input.kind === 'employee'
    ? { organizationId: input.organizationId, role: input.employeeRole }
    : { organizationId: input.organizationId, role: { not: input.employeeRole }, roleDef: { locked: false } }
  const { count } = await db.passwordResetToken.updateMany({
    where: { usedAt: null, user: { memberships: { some: logins } } },
    data: { usedAt: input.now },
  })
  return count
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
  db: ScopedDb | TxDb,
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
    select: { id: true, role: true, status: true, employeeId: true, employee: { select: { fullName: true, archivedAt: true } }, user: { select: { email: true } } },
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

/** Somebody already here, where they sit, and their logins — for giving them another one. */
export async function personForLogin(db: TxDb, employeeId: string) {
  return db.employee.findFirst({
    where: { id: employeeId },
    select: {
      id: true,
      fullName: true,
      archivedAt: true,
      reportingManagerId: true,
      departmentId: true,
      memberships: { select: { role: true, status: true } },
    },
  })
}

/**
 * A login for somebody with none in this company: their User — reused if they
 * already have one, since the same person can belong to two companies — and a
 * Membership, which starts one of three ways:
 *
 *   a password typed for them   `active` at once (the company sets passwords)
 *   an invitation link          `invited`, with the hashed one-use token
 *   neither yet                 `invited`, waiting for HR or the Super Admin
 *                               to set its password (Settings → Users)
 *
 * On the caller's transaction, so it lands together with whatever else is
 * being created (an employee record, a whole import), or not at all.
 */
export async function createLogin(
  db: TxDb,
  input: {
    /** Null for an employee login with no email: it signs in with the Employee ID. */
    email: string | null
    organizationId: string
    role: string
    /** The person it belongs to; null for an operator with no employee record. */
    employeeId: string | null
    passwordHash: string | null
    link: { tokenHash: string; expiresAt: Date; createdByUserId: string } | null
  },
): Promise<{ userId: string; membershipId: string }> {
  const existing = input.email
    ? await db.user.findUnique({ where: { email: input.email }, select: { id: true, passwordHash: true } })
    : null
  // A User from another company keeps the password it has: one typed here
  // would quietly replace it there.
  if (existing?.passwordHash && input.passwordHash) {
    throw new LoginEmailTaken()
  }
  const user = existing
    ? input.passwordHash
      ? await db.user.update({ where: { id: existing.id }, data: { passwordHash: input.passwordHash }, select: { id: true } })
      : existing
    : await db.user.create({ data: { email: input.email, passwordHash: input.passwordHash }, select: { id: true } })

  const membership = await db.membership.create({
    data: {
      userId: user.id,
      organizationId: input.organizationId,
      role: input.role,
      status: input.passwordHash ? 'active' : 'invited',
      employeeId: input.employeeId,
    },
  })

  if (input.link) {
    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: input.link.tokenHash,
        expiresAt: input.link.expiresAt,
        purpose: 'invite',
        createdByUserId: input.link.createdByUserId,
      },
    })
  }

  return { userId: user.id, membershipId: membership.id }
}

/** The email belongs to a login that already has a password, elsewhere. */
export class LoginEmailTaken extends Error {
  constructor() {
    super('That email address already has a password for another account. Use a different email.')
  }
}

/**
 * A password set for somebody by HR or the Super Admin, on the caller's
 * transaction. Everything signed in with the old one is signed out — every
 * access token (the version goes up) and every refresh token — any link still
 * out is spent, and a login that was waiting for its first password can now
 * sign in. One switched off stays off.
 */
export async function setPasswordFor(db: TxDb, input: { userId: string; passwordHash: string; now: Date }): Promise<{ sessionsEnded: number; activated: boolean }> {
  await db.user.update({
    where: { id: input.userId },
    data: { passwordHash: input.passwordHash, tokenVersion: { increment: 1 } },
  })
  const ended = await db.refreshToken.updateMany({
    where: { userId: input.userId, revokedAt: null },
    data: { revokedAt: input.now },
  })
  await db.passwordResetToken.updateMany({
    where: { userId: input.userId, usedAt: null },
    data: { usedAt: input.now },
  })
  const activated = await db.membership.updateMany({
    where: { userId: input.userId, status: 'invited' },
    data: { status: 'active' },
  })
  return { sessionsEnded: ended.count, activated: activated.count > 0 }
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
