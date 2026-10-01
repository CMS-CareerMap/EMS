import type { NotificationKind, Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import type { PersonPlace } from '../../platform/authz/scopeWhere'

/**
 * Notifications and the people they go to.
 *
 * A deactivated login is never sent anything; an invited one is — the notice
 * is waiting when they first sign in, which is when "your payslip is ready"
 * is most useful.
 */

type Db = ScopedDb | TxDb

const REACHABLE: Prisma.MembershipWhereInput = { status: { not: 'inactive' } }

/** Everybody with a login. */
export async function allUsers(db: Db): Promise<string[]> {
  const rows = await db.membership.findMany({ where: REACHABLE, select: { userId: true } })
  return rows.map((r) => r.userId)
}

/** The login of an employee, when they have one that is not switched off. */
export async function userOfEmployee(db: Db, employeeId: string): Promise<string | null> {
  const row = await db.employee.findFirst({
    where: { id: employeeId },
    select: { membership: { select: { userId: true, status: true } } },
  })
  if (!row?.membership || row.membership.status === 'inactive') return null
  return row.membership.userId
}

/** The logins of several employees at once — a payroll run's worth. */
export async function usersOfEmployees(db: Db, employeeIds: readonly string[]): Promise<Map<string, string>> {
  if (employeeIds.length === 0) return new Map()
  const rows = await db.employee.findMany({
    where: { id: { in: [...employeeIds] }, membership: REACHABLE },
    select: { id: true, membership: { select: { userId: true } } },
  })
  return new Map(rows.flatMap((r) => (r.membership ? [[r.id, r.membership.userId] as const] : [])))
}

/** Where a person sits — who they report to, which department — for deciding whose scope reaches them. */
export async function placeOf(db: Db, employeeId: string): Promise<PersonPlace | null> {
  return db.employee.findFirst({ where: { id: employeeId }, select: { id: true, reportingManagerId: true, departmentId: true } })
}

export async function savedSettings(db: Db): Promise<Map<string, boolean>> {
  const rows = await db.notificationSetting.findMany({ select: { event: true, enabled: true } })
  return new Map(rows.map((r) => [r.event, r.enabled]))
}

export async function saveSetting(tx: TxDb, organizationId: string, event: string, enabled: boolean, userId: string) {
  await tx.notificationSetting.upsert({
    where: { organizationId_event: { organizationId, event } },
    update: { enabled, updatedByUserId: userId },
    create: { organizationId, event, enabled, updatedByUserId: userId },
  })
}

export interface NotificationValues {
  organizationId: string
  userId: string
  event: string
  kind: NotificationKind
  title: string
  message: string
  link: string | null
  entityType: string | null
  entityId: string | null
}

export async function createMany(tx: TxDb, rows: NotificationValues[]): Promise<number> {
  if (rows.length === 0) return 0
  const result = await tx.notification.createMany({ data: rows })
  return result.count
}

const listSelect = {
  id: true,
  event: true,
  kind: true,
  title: true,
  message: true,
  link: true,
  entityType: true,
  entityId: true,
  readAt: true,
  createdAt: true,
} as const

export type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof listSelect }>

/** Where the previous page ended, in the list's own order: newest first, then id. */
export interface NoticeCursor {
  before: Date
  beforeId?: string | undefined
}

export async function listFor(db: ScopedDb, userId: string, limit: number, cursor?: NoticeCursor): Promise<NotificationRow[]> {
  const after = !cursor
    ? {}
    : cursor.beforeId
      ? { OR: [{ createdAt: { lt: cursor.before } }, { createdAt: cursor.before, id: { lt: cursor.beforeId } }] }
      : { createdAt: { lt: cursor.before } }
  return db.notification.findMany({
    where: { userId, ...after },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: listSelect,
  })
}

export async function unreadCount(db: ScopedDb, userId: string): Promise<number> {
  return db.notification.count({ where: { userId, readAt: null } })
}

/** Marks one as read — only if it is the caller's own. */
export async function markRead(db: ScopedDb, userId: string, id: string): Promise<number> {
  const result = await db.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } })
  return result.count
}

export async function exists(db: ScopedDb, userId: string, id: string): Promise<boolean> {
  return (await db.notification.count({ where: { id, userId } })) > 0
}

export async function markAllRead(db: ScopedDb, userId: string): Promise<number> {
  const result = await db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } })
  return result.count
}

export async function clearAll(db: ScopedDb, userId: string): Promise<number> {
  const result = await db.notification.deleteMany({ where: { userId } })
  return result.count
}

export async function countOlderThan(db: ScopedDb, cutoff: Date): Promise<number> {
  return db.notification.count({ where: { createdAt: { lt: cutoff } } })
}

export async function purgeOlderThan(db: ScopedDb, cutoff: Date): Promise<number> {
  const result = await db.notification.deleteMany({ where: { createdAt: { lt: cutoff } } })
  return result.count
}
