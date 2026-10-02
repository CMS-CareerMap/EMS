import type { Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { unsafeDb } from '../../platform/db/unsafe'

/**
 * The audit log.
 *
 * There is an append here and a read, and no update and no delete — anywhere.
 * A log that can be edited is not a log. (A company's rows go with the company
 * if it is ever removed; that is the only way one leaves.)
 */

export interface AuditRow {
  organizationId: string
  actorUserId: string | null
  action: string
  entityType: string | null
  entityId: string | null
  details: Prisma.InputJsonValue | undefined
  requestId: string | null
}

/** Appends on whatever handle the change is being made on, so they commit together. */
export async function append(db: TxDb, row: AuditRow): Promise<void> {
  await db.auditLog.create({ data: row })
}

/** For events before a company-scoped client exists — a sign-in. */
export async function appendUnscoped(row: AuditRow): Promise<void> {
  await unsafeDb.auditLog.create({ data: row })
}

/** What a company calls one of its roles, for a security event written without the name. */
export async function roleNameOf(organizationId: string, key: string): Promise<string | null> {
  const role = await unsafeDb.role.findUnique({ where: { organizationId_key: { organizationId, key } }, select: { name: true } })
  return role?.name ?? null
}

/**
 * On a transaction of the unscoped client — for a pre-sign-in change that must
 * commit together with its row, like a recovery link issued from the terminal.
 */
export async function appendIn(tx: Prisma.TransactionClient, row: AuditRow): Promise<void> {
  await tx.auditLog.create({ data: row })
}

/** Newest first, everything matching — what the tests read. The screen pages through `page`. */
export async function listFor(db: ScopedDb, filter: { entityType?: string; entityId?: string; action?: string } = {}) {
  return db.auditLog.findMany({ where: filter, orderBy: { createdAt: 'desc' } })
}

// ── Reading the log back: the audit screen ──────────────────────────────────

export interface AuditFilter {
  /** Only these actions — a category, turned into its actions by the caller. */
  actions?: string[] | undefined
  /** Who did it. */
  actorUserId?: string | undefined
  /** From this instant (inclusive) to that one (exclusive). */
  from?: Date | undefined
  to?: Date | undefined
  /** Rows about one person: their record, any of their logins, or naming them in the facts. */
  about?: { employeeId: string; membershipIds: string[]; userIds: string[] } | undefined
}

export interface AuditCursor {
  before: Date
  beforeId: string
}

function whereOf(filter: AuditFilter): Prisma.AuditLogWhereInput[] {
  const and: Prisma.AuditLogWhereInput[] = []
  if (filter.actions) and.push({ action: { in: filter.actions } })
  if (filter.actorUserId) and.push({ actorUserId: filter.actorUserId })
  if (filter.from) and.push({ createdAt: { gte: filter.from } })
  if (filter.to) and.push({ createdAt: { lt: filter.to } })
  if (filter.about) {
    const { employeeId, membershipIds, userIds } = filter.about
    const about: Prisma.AuditLogWhereInput[] = [
      { entityType: 'employee', entityId: employeeId },
      { details: { path: ['employeeId'], equals: employeeId } },
    ]
    if (membershipIds.length > 0) about.push({ entityType: 'membership', entityId: { in: membershipIds } })
    if (userIds.length > 0) about.push({ entityType: 'user', entityId: { in: userIds } })
    and.push({ OR: about })
  }
  return and
}

const ROW = {
  id: true,
  actorUserId: true,
  action: true,
  entityType: true,
  entityId: true,
  details: true,
  requestId: true,
  createdAt: true,
} as const

export type AuditLogRow = Prisma.AuditLogGetPayload<{ select: typeof ROW }>

/**
 * One page, newest first, keyed on (createdAt, id): two rows written in the
 * same millisecond are still told apart, so paging never skips or repeats one.
 */
export async function page(db: ScopedDb, filter: AuditFilter, limit: number, cursor?: AuditCursor): Promise<AuditLogRow[]> {
  const and = whereOf(filter)
  if (cursor) {
    and.push({ OR: [{ createdAt: { lt: cursor.before } }, { createdAt: cursor.before, id: { lt: cursor.beforeId } }] })
  }
  return db.auditLog.findMany({ where: { AND: and }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, select: ROW })
}

export async function countOf(db: ScopedDb, filter: AuditFilter): Promise<number> {
  return db.auditLog.count({ where: { AND: whereOf(filter) } })
}

const LOGIN = {
  id: true,
  userId: true,
  role: true,
  user: { select: { email: true } },
  employee: { select: { fullName: true, employeeCode: true } },
} as const

/** The names behind the ids a page of rows carries, fetched once per page. */
export async function employeesByIds(db: ScopedDb, ids: string[]) {
  if (ids.length === 0) return []
  return db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, employeeCode: true } })
}

export async function membershipsByIds(db: ScopedDb, ids: string[]) {
  if (ids.length === 0) return []
  return db.membership.findMany({ where: { id: { in: ids } }, select: LOGIN })
}

export async function membershipsByUserIds(db: ScopedDb, userIds: string[]) {
  if (userIds.length === 0) return []
  return db.membership.findMany({ where: { userId: { in: userIds } }, select: LOGIN })
}

export async function documentTypeLabels(db: ScopedDb, codes: string[]) {
  if (codes.length === 0) return []
  return db.documentType.findMany({ where: { code: { in: codes } }, select: { code: true, label: true } })
}

export async function componentLabels(db: ScopedDb, codes: string[]) {
  if (codes.length === 0) return []
  return db.salaryComponent.findMany({ where: { code: { in: codes } }, select: { code: true, label: true } })
}

export async function leaveTypeNames(db: ScopedDb, codes: string[], ids: string[] = []) {
  if (codes.length === 0 && ids.length === 0) return []
  return db.leaveType.findMany({ where: { OR: [{ code: { in: codes } }, { id: { in: ids } }] }, select: { id: true, code: true, name: true } })
}

/** Every role's name today, by key — the company has only a handful. */
export async function roleNames(db: ScopedDb) {
  return db.role.findMany({ select: { key: true, name: true } })
}

/**
 * Everybody the log can be filtered by: every login (as the one who did it)
 * and every employee record, archived ones included (as the one it was about).
 * The whole company, like the log itself.
 */
export async function filterPeople(db: ScopedDb) {
  const [logins, employees] = await Promise.all([
    db.membership.findMany({ select: { userId: true, employeeId: true, roleDef: { select: { name: true } }, user: { select: { email: true } }, employee: { select: { fullName: true } } } }),
    db.employee.findMany({ select: { id: true, fullName: true, employeeCode: true } }),
  ])
  return { logins, employees }
}

/**
 * A person and every login of theirs (Day 23: an employee login and a role
 * login), so "about Ravi" also finds the sign-ins and role changes of both.
 */
export async function loginsOf(db: ScopedDb, employeeId: string) {
  return db.employee.findFirst({
    where: { id: employeeId },
    select: { id: true, memberships: { select: { id: true, userId: true } } },
  })
}
