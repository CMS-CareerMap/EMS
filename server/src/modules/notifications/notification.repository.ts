import type { NotificationKind, Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import type { PersonPlace } from '../../platform/authz/scopeWhere'
import { EMPLOYEE_ROLE } from '../../platform/authz/defaultRoles'
import { decidingLogins } from '../../domain/org/logins'

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

/**
 * The logins of an employee that are not switched off — both of them, for
 * somebody with an employee login and a role login (Day 23): a notice about
 * the person reaches them whichever one they sign in with.
 */
export async function usersOfEmployee(db: Db, employeeId: string): Promise<string[]> {
  const rows = await db.membership.findMany({ where: { employeeId, ...REACHABLE }, select: { userId: true } })
  return rows.map((r) => r.userId)
}

/**
 * The logins a person DECIDES from — for "a request is waiting for you": all
 * not switched off, less their employee login while they have a live role
 * login (Day 23), which is for their own things only.
 */
export async function decidingUsersOfEmployee(db: Db, employeeId: string): Promise<string[]> {
  const rows = await db.membership.findMany({ where: { employeeId }, select: { id: true, role: true, status: true, userId: true } })
  return decidingLogins(rows, EMPLOYEE_ROLE).map((r) => r.userId)
}

/**
 * The OTHER logins of the person this login belongs to, not switched off —
 * for "the password of your other login was changed" (Day 23). None for an
 * operator with no employee record.
 */
export async function otherLoginsOfPerson(db: Db, userId: string): Promise<{ email: string | null; others: string[] }> {
  const mine = await db.membership.findFirst({ where: { userId }, select: { employeeId: true, user: { select: { email: true } } } })
  if (!mine?.employeeId) return { email: mine?.user.email ?? null, others: [] }
  const rows = await db.membership.findMany({
    where: { employeeId: mine.employeeId, userId: { not: userId }, ...REACHABLE },
    select: { userId: true },
  })
  return { email: mine.user.email, others: rows.map((r) => r.userId) }
}

/** The logins of several employees at once — a payroll run's worth. */
export async function usersOfEmployees(db: Db, employeeIds: readonly string[]): Promise<string[]> {
  if (employeeIds.length === 0) return []
  const rows = await db.membership.findMany({
    where: { employeeId: { in: [...employeeIds] }, ...REACHABLE },
    select: { userId: true },
  })
  return rows.map((r) => r.userId)
}

/** Where a person sits — who they report to, which department — for deciding whose scope reaches them. */
export async function placeOf(db: Db, employeeId: string): Promise<PersonPlace | null> {
  return db.employee.findFirst({ where: { id: employeeId }, select: { id: true, reportingManagerId: true, departmentId: true } })
}

export async function savedSettings(db: Db): Promise<Map<string, boolean>> {
  const rows = await db.notificationSetting.findMany({ select: { event: true, enabled: true } })
  return new Map(rows.map((r) => [r.event, r.enabled]))
}

/** Which events are also emailed (client §45), where the company chose; the rest take the default. */
export async function savedEmailChoices(db: Db): Promise<Map<string, boolean>> {
  const rows = await db.notificationSetting.findMany({ where: { email: { not: null } }, select: { event: true, email: true } })
  return new Map(rows.map((r) => [r.event, r.email === true]))
}

export async function saveSetting(tx: TxDb, organizationId: string, event: string, enabled: boolean, userId: string, email?: boolean) {
  await tx.notificationSetting.upsert({
    where: { organizationId_event: { organizationId, event } },
    update: { enabled, updatedByUserId: userId, ...(email === undefined ? {} : { email }) },
    create: { organizationId, event, enabled, updatedByUserId: userId, email: email ?? null },
  })
}

/**
 * The sign-in email of each of these logins that is still allowed in — where
 * an emailed notice goes. A login with no email (Employee ID only) is told in
 * the app alone.
 */
export async function loginEmails(db: Db, userIds: readonly string[]): Promise<string[]> {
  const rows = await db.membership.findMany({
    where: { userId: { in: [...userIds] }, status: 'active' },
    select: { user: { select: { email: true } } },
  })
  return [...new Set(rows.map((r) => r.user.email).filter((email): email is string => Boolean(email)))]
}

/** Email to send once this transaction commits (client §45). */
export async function queueEmails(tx: TxDb, rows: { organizationId: string; toEmail: string; subject: string; body: string }[]): Promise<void> {
  if (rows.length > 0) await tx.emailOutbox.createMany({ data: rows })
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

/** A name and the person above them — for a notice about somebody joining or leaving. */
export async function personBrief(db: Db, employeeId: string) {
  return db.employee.findFirst({ where: { id: employeeId }, select: { fullName: true, employeeCode: true, reportingManagerId: true } })
}
