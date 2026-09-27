import type { Role, AccountStatus } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { unsafeDb } from '../../platform/db/unsafe'

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
  role: Role
  status: AccountStatus
  email: string
  fullName: string | null
  employeeId: string | null
  employeeCode: string | null
  createdAt: Date
}

const membershipSelect = {
  id: true,
  userId: true,
  role: true,
  status: true,
  createdAt: true,
  user: { select: { email: true } },
  employee: { select: { id: true, fullName: true, employeeCode: true } },
} as const

type RawMembership = {
  id: string
  userId: string
  role: Role
  status: AccountStatus
  createdAt: Date
  user: { email: string }
  employee: { id: string; fullName: string; employeeCode: string } | null
}

function flatten(row: RawMembership): MembershipRow {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role,
    status: row.status,
    email: row.user.email,
    fullName: row.employee?.fullName ?? null,
    employeeId: row.employee?.id ?? null,
    employeeCode: row.employee?.employeeCode ?? null,
    createdAt: row.createdAt,
  }
}

export async function listMemberships(db: ScopedDb): Promise<MembershipRow[]> {
  const rows = (await db.membership.findMany({
    select: membershipSelect,
    orderBy: { createdAt: 'asc' },
  })) as RawMembership[]
  return rows.map(flatten)
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
  return db.membership.count({ where: { role: 'super_admin', status: 'active' } })
}

export async function setRole(db: TxDb, membershipId: string, role: Role): Promise<void> {
  await db.membership.update({ where: { id: membershipId }, data: { role } })
}

export async function setStatus(
  db: TxDb,
  membershipId: string,
  status: AccountStatus,
): Promise<void> {
  await db.membership.update({ where: { id: membershipId }, data: { status } })
}

/** Role and status only — what the role-change invariants are checked against. */
export async function findMembershipForChange(db: TxDb, id: string) {
  return db.membership.findFirst({ where: { id }, select: { id: true, role: true, status: true } })
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
    role: Role
    tokenHash: string
    expiresAt: Date
    createdByUserId: string
  },
): Promise<{ userId: string; membershipId: string }> {
  const existing = await db.user.findUnique({ where: { email: input.email }, select: { id: true } })
  const user = existing ?? (await db.user.create({ data: { email: input.email, passwordHash: null } }))

  const membership = await db.membership.create({
    data: { userId: user.id, organizationId: input.organizationId, role: input.role, status: 'invited' },
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
  db: ScopedDb,
  input: {
    userId: string
    tokenHash: string
    expiresAt: Date
    purpose: 'invite' | 'reset'
    createdByUserId: string
  },
): Promise<void> {
  const now = new Date()
  await db.$transaction([
    db.passwordResetToken.updateMany({
      where: { userId: input.userId, usedAt: null },
      data: { usedAt: now },
    }),
    db.passwordResetToken.create({ data: input }),
  ])
}
