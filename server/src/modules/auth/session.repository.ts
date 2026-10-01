import type { AccountStatus } from '@prisma/client'
import { unsafeDb } from '../../platform/db/unsafe'
import { toGrant, type RoleGrant } from '../../platform/authz/grant'

/**
 * Refresh tokens and the User row they belong to are both GLOBAL models, so
 * these queries have no organization to be scoped by — the same reason login
 * uses the unscoped client. See platform/db/unsafe.
 */

export interface StoredToken {
  id: string
  userId: string
  familyId: string
  expiresAt: Date
  revokedAt: Date | null
  /** Set when the token was ROTATED away — the only kind whose return means a copy. */
  replacedById: string | null
}

const storedSelect = { id: true, userId: true, familyId: true, expiresAt: true, revokedAt: true, replacedById: true } as const

export interface IssueInput {
  userId: string
  tokenHash: string
  familyId: string
  expiresAt: Date
  userAgent?: string | undefined
  ip?: string | undefined
}

export async function storeToken(input: IssueInput): Promise<StoredToken> {
  return unsafeDb.refreshToken.create({
    data: {
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    },
    select: storedSelect,
  })
}

export async function findByHash(tokenHash: string): Promise<StoredToken | null> {
  return unsafeDb.refreshToken.findUnique({
    where: { tokenHash },
    select: storedSelect,
  })
}

/**
 * Issue the successor and retire the predecessor, atomically.
 *
 * The `revokedAt: null` in the update filter is a concurrency guard, not
 * decoration. Two requests arriving together would otherwise both read an
 * unrevoked row and both rotate it, leaving two live tokens from one — which is
 * precisely the state reuse detection exists to prevent. Exactly one update can
 * match, so the loser throws and its new token rolls back with the transaction.
 *
 * The cost is real: two browser tabs refreshing in the same instant will log
 * one of them out. The fix belongs on the client — a single-flight refresh, so
 * concurrent 401s queue behind one request rather than racing. That is noted
 * for Day 6, when api/http.js is written.
 */
export async function rotate(input: {
  previousId: string
  next: IssueInput
}): Promise<StoredToken> {
  return unsafeDb.$transaction(async (tx) => {
    const created = await tx.refreshToken.create({
      data: {
        userId: input.next.userId,
        tokenHash: input.next.tokenHash,
        familyId: input.next.familyId,
        expiresAt: input.next.expiresAt,
        userAgent: input.next.userAgent ?? null,
        ip: input.next.ip ?? null,
      },
      select: storedSelect,
    })

    const retired = await tx.refreshToken.updateMany({
      where: { id: input.previousId, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: created.id },
    })

    if (retired.count !== 1) {
      throw new Error('Refresh token was rotated concurrently')
    }

    return created
  })
}

/**
 * Kills every token descended from one login. Called when reuse is detected:
 * at that point we know a token was copied, but not by whom, so the only safe
 * move is to end the session for everyone holding one.
 */
export async function revokeFamily(familyId: string): Promise<number> {
  const result = await unsafeDb.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count
}

/** Every session on every device. Used by password change and termination. */
export async function revokeAllForUser(userId: string): Promise<number> {
  const result = await unsafeDb.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count
}

export async function revokeOne(id: string): Promise<void> {
  await unsafeDb.refreshToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/**
 * Invalidates every ACCESS token this user holds.
 *
 * Revoking refresh tokens is not enough on its own: an access token already in
 * a browser stays valid until it expires, because nothing checks a database to
 * verify it. Raising the version is what the authenticate middleware compares
 * against, so the outstanding ones die at the next request instead of fifteen
 * minutes later.
 */
export async function bumpTokenVersion(userId: string): Promise<number> {
  const user = await unsafeDb.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
    select: { tokenVersion: true },
  })
  return user.tokenVersion
}

export async function setPasswordHash(userId: string, passwordHash: string): Promise<void> {
  await unsafeDb.user.update({ where: { id: userId }, data: { passwordHash } })
}

export async function findUserCredentials(
  userId: string,
): Promise<{ id: string; passwordHash: string | null; tokenVersion: number } | null> {
  return unsafeDb.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true, tokenVersion: true },
  })
}

export interface AuthState {
  userId: string
  tokenVersion: number
  grant: RoleGrant
  status: AccountStatus
  employeeId: string | null
  departmentId: string | null
}

/**
 * Everything the authenticate middleware needs, in ONE query.
 *
 * Reading the membership rather than the user is deliberate: it carries the
 * role and the status, so an account deactivated a minute ago is refused here
 * rather than at the next refresh. It also reaches the Employee row, which the
 * access token does not carry — and must not, because an employee record
 * created after the token was minted would leave the claim stale for fifteen
 * minutes, exactly when a new joiner is trying to use the system.
 *
 * Since Day 21 it also reads the ROLE ROW — its permissions and scopes — in
 * the same query, so a role edited on the Roles screen applies to the holder's
 * very next request.
 */
export async function findAuthState(membershipId: string): Promise<AuthState | null> {
  const membership = await unsafeDb.membership.findUnique({
    where: { id: membershipId },
    select: {
      status: true,
      roleDef: { select: roleForGrant },
      user: { select: { id: true, tokenVersion: true } },
      employee: { select: { id: true, departmentId: true } },
    },
  })

  if (!membership) return null

  return {
    userId: membership.user.id,
    tokenVersion: membership.user.tokenVersion,
    grant: toGrant(membership.roleDef),
    status: membership.status,
    employeeId: membership.employee?.id ?? null,
    departmentId: membership.employee?.departmentId ?? null,
  }
}

/** The columns of a Role row a grant is made from. */
export const roleForGrant = { key: true, name: true, permissions: true, scopes: true } as const
