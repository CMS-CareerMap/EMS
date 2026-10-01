import type { Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { unsafeDb } from '../../platform/db/unsafe'
import { toGrant } from '../../platform/authz/grant'
import type { RoleNode } from '../../platform/authz/roleOrder'
import type { PolicyRole } from '../user/user.policy'

/**
 * Roles — the company's own list since Day 21, edited on Settings → Roles &
 * Permissions. Tenant-scoped: `db` is a forOrg() client, so every query here
 * sees one company's roles and no other's.
 */

type Db = ScopedDb | TxDb

const roleSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  parentId: true,
  builtIn: true,
  locked: true,
  permissions: true,
  scopes: true,
  updatedAt: true,
  _count: { select: { memberships: true } },
} as const

export type RoleRecord = Prisma.RoleGetPayload<{ select: typeof roleSelect }>

/** Every role of the company, in the order they were made (the seven first). */
export async function listRoles(db: Db): Promise<RoleRecord[]> {
  return db.role.findMany({ select: roleSelect, orderBy: [{ createdAt: 'asc' }, { key: 'asc' }] })
}

export async function findRole(db: Db, key: string): Promise<RoleRecord | null> {
  return db.role.findFirst({ where: { key }, select: roleSelect })
}

/** The role order as a map from key to its parent's key. */
export function orderOf(roles: readonly Pick<RoleRecord, 'id' | 'key' | 'parentId'>[]): Map<string, RoleNode> {
  const keyOf = new Map(roles.map((r) => [r.id, r.key]))
  return new Map(roles.map((r) => [r.key, { key: r.key, parentKey: r.parentId ? (keyOf.get(r.parentId) ?? null) : null }]))
}

/** Everything the user and role rules need, read in one query. */
export async function policyRoles(db: Db): Promise<{ roles: Map<string, PolicyRole>; order: Map<string, RoleNode> }> {
  const rows = await listRoles(db)
  const order = orderOf(rows)
  const roles = new Map(
    rows.map((r) => [
      r.key,
      { key: r.key, parentKey: order.get(r.key)?.parentKey ?? null, locked: r.locked, grant: toGrant(r) },
    ]),
  )
  return { roles, order }
}

export interface RoleWrite {
  name: string
  description: string
  parentId: string | null
  permissions: string[]
  scopes: Prisma.InputJsonValue
}

export async function createRole(tx: TxDb, organizationId: string, key: string, data: RoleWrite) {
  return tx.role.create({ data: { organizationId, key, builtIn: false, locked: false, ...data }, select: { id: true } })
}

/**
 * Writes a role only if nobody else has since — the `updatedAt` it was read
 * at must still be the one stored. Returns how many rows changed: 0 means the
 * edit was made on an out-of-date copy.
 */
export async function updateRole(tx: TxDb, id: string, readAt: Date, data: RoleWrite): Promise<number> {
  const result = await tx.role.updateMany({ where: { id, updatedAt: readAt }, data: { ...data, updatedAt: new Date() } })
  return result.count
}

export async function deleteRole(tx: TxDb, id: string): Promise<void> {
  await tx.role.deleteMany({ where: { id } })
}

/** Roles that come directly under this one. */
export async function childCount(db: Db, id: string): Promise<number> {
  return db.role.count({ where: { parentId: id } })
}

export async function keyExists(db: Db, key: string): Promise<boolean> {
  return (await db.role.count({ where: { key } })) > 0
}

/** The logins that hold a role — so an edit can end their access tokens and the change shows at once. */
export async function holderUserIds(db: Db, key: string): Promise<string[]> {
  const rows = await db.membership.findMany({ where: { role: key }, select: { userId: true } })
  return rows.map((r) => r.userId)
}

/**
 * Ends these users' access tokens — NOT their sessions. Their browser trades
 * its refresh cookie for a new token at the next request and is handed the
 * role as it is now. Global: a user's tokens are not owned by a company.
 */
export async function endAccessTokens(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return
  await unsafeDb.user.updateMany({ where: { id: { in: [...userIds] } }, data: { tokenVersion: { increment: 1 } } })
}

/** Every login holding a role with this permission, switched off or not — the caller filters. */
export async function membershipsHolding(db: Db, permission: string) {
  return db.membership.findMany({
    where: { roleDef: { permissions: { has: permission } } },
    select: {
      userId: true,
      status: true,
      role: true,
      roleDef: { select: { scopes: true } },
      // Where the holder sits — what their team and department scopes are measured from.
      employee: { select: { id: true, departmentId: true } },
    },
  })
}
