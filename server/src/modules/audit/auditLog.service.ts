import type { AppContext } from '../../platform/context'
import { BusinessRule, NotFound, ValidationFailed } from '../../platform/errors/AppError'
import {
  AUDIT_CATEGORIES,
  actionLabel,
  actionsIn,
  categoryOf,
  deviceOf,
  roleLabel,
  summarise,
  type AuditCategory,
  type AuditNames,
  type Details,
} from '../../domain/audit/catalogue'
import { addCalendarDays, zonedDayStart, type CalendarDate } from '../../domain/shared/dates'
import { companyTimezone } from '../organization/organization.service'
import { REPORT_TITLES } from '../reports/reports.service'
import { recordSecurityEvent } from './audit.service'
import * as repo from './audit.repository'

/**
 * Reading the audit log — the screen Super Admin opens to answer "who did
 * this?".
 *
 * The rows are written all over the system in the words of the code that wrote
 * them: ids and codes. This turns a page of them into sentences a person can
 * read — names looked up once per page, not once per row — and leaves the log
 * itself untouched. There is no way to change or delete a row from here, or
 * from anywhere.
 */

export interface AuditQuery {
  /** Calendar days on the company's clock, both inclusive. */
  from?: CalendarDate | undefined
  to?: CalendarDate | undefined
  category?: AuditCategory | undefined
  actorUserId?: string | undefined
  /** Rows about this person. */
  employeeId?: string | undefined
}

export interface AuditEntryView {
  id: string
  at: Date
  actor: { userId: string; name: string; role: string } | null
  action: string
  actionLabel: string
  category: AuditCategory | null
  categoryLabel: string | null
  summary: string
  ip: string | null
  device: string | null
  requestId: string | null
}

const PAGE_SIZE = 50
/** An export beyond this is a date range too wide to read; the person is asked to narrow it. */
export const EXPORT_LIMIT = 20_000
const EXPORT_BATCH = 1000

export const CATEGORY_OPTIONS = (Object.keys(AUDIT_CATEGORIES) as AuditCategory[]).map((id) => ({ id, label: AUDIT_CATEGORIES[id] }))

async function filterOf(ctx: AppContext, q: AuditQuery): Promise<repo.AuditFilter> {
  if (q.from && q.to && q.from > q.to) {
    throw ValidationFailed('The start date is after the end date', [{ field: 'from', message: 'Choose a start on or before the end' }])
  }
  const timezone = q.from || q.to ? await companyTimezone(ctx) : null

  let about: repo.AuditFilter['about']
  if (q.employeeId) {
    const person = await repo.loginsOf(ctx.db, q.employeeId)
    if (!person) throw NotFound('No such employee')
    about = { employeeId: person.id, membershipIds: person.memberships.map((m) => m.id), userIds: person.memberships.map((m) => m.userId) }
  }

  return {
    actions: q.category ? actionsIn(q.category) : undefined,
    actorUserId: q.actorUserId,
    // "To 30 Sep" means up to the start of 1 Oct on the company's clock.
    from: q.from && timezone ? zonedDayStart(q.from, timezone) : undefined,
    to: q.to && timezone ? zonedDayStart(addCalendarDays(q.to, 1), timezone) : undefined,
    about,
  }
}

const detailsOf = (row: repo.AuditLogRow): Details =>
  row.details && typeof row.details === 'object' && !Array.isArray(row.details) ? (row.details as Details) : {}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

type Login = Awaited<ReturnType<typeof repo.membershipsByIds>>[number]
const loginName = (m: Login) => m.employee?.fullName ?? m.user.email

/** A page of rows in words. Every name is fetched in one query per kind. */
async function describe(ctx: AppContext, rows: repo.AuditLogRow[]): Promise<AuditEntryView[]> {
  const employeeIds = new Set<string>()
  const membershipIds = new Set<string>()
  const userIds = new Set<string>()
  const docCodes = new Set<string>()
  const componentCodes = new Set<string>()
  const leaveCodes = new Set<string>()
  const leaveTypeIds = new Set<string>()

  for (const row of rows) {
    const d = detailsOf(row)
    if (row.actorUserId) userIds.add(row.actorUserId)
    if (row.entityType === 'employee' && row.entityId) employeeIds.add(row.entityId)
    if (row.entityType === 'membership' && row.entityId) membershipIds.add(row.entityId)
    if (row.entityType === 'user' && row.entityId) userIds.add(row.entityId)
    const employeeId = str(d.employeeId)
    if (employeeId) employeeIds.add(employeeId)
    // People named by a change to the company tree (Day 22).
    for (const key of ['managerTo', 'managerFrom', 'ownerEmployeeId', 'previousOwnerId', 'noManagerApproverId']) {
      const named = str(d[key])
      if (named) employeeIds.add(named)
    }
    if (row.action.startsWith('document.') && str(d.type)) docCodes.add(String(d.type))
    if (row.action.startsWith('document_type.') && str(d.code)) docCodes.add(String(d.code))
    if (row.action.startsWith('payroll.entry_') && str(d.component)) componentCodes.add(String(d.component))
    if (row.action.startsWith('leave_type.') && str(d.code)) leaveCodes.add(String(d.code))
    if (row.entityType === 'leave_type' && row.entityId) leaveTypeIds.add(row.entityId)
  }

  const [employees, memberships, logins, docTypes, components, leaveTypes, roles] = await Promise.all([
    repo.employeesByIds(ctx.db, [...employeeIds]),
    repo.membershipsByIds(ctx.db, [...membershipIds]),
    repo.membershipsByUserIds(ctx.db, [...userIds]),
    repo.documentTypeLabels(ctx.db, [...docCodes]),
    repo.componentLabels(ctx.db, [...componentCodes]),
    repo.leaveTypeNames(ctx.db, [...leaveCodes], [...leaveTypeIds]),
    repo.roleNames(ctx.db),
  ])

  const employeeName = new Map(employees.map((e) => [e.id, e.fullName]))
  const membershipName = new Map(memberships.map((m) => [m.id, loginName(m)]))
  const byUser = new Map(logins.map((m) => [m.userId, m]))
  const docLabel = new Map(docTypes.map((t) => [t.code, t.label]))
  const componentLabel = new Map(components.map((c) => [c.code, c.label]))
  const leaveName = new Map(leaveTypes.flatMap((t) => [[t.code, t.name], [t.id, t.name]] as [string, string][]))
  const roleName = new Map(roles.map((r) => [r.key, r.name]))
  const lookup = <T>(map: Map<string, T>) => (key: unknown) => (typeof key === 'string' ? map.get(key) ?? null : null)

  const names: AuditNames = {
    employee: lookup(employeeName),
    membership: lookup(membershipName),
    user: (id) => {
      const m = typeof id === 'string' ? byUser.get(id) : undefined
      return m ? loginName(m) : null
    },
    documentType: lookup(docLabel),
    component: lookup(componentLabel),
    leaveType: lookup(leaveName),
    report: (id) => (typeof id === 'string' && Object.hasOwn(REPORT_TITLES, id) ? REPORT_TITLES[id as keyof typeof REPORT_TITLES] : null),
    role: lookup(roleName),
  }

  return rows.map((row) => {
    const d = detailsOf(row)
    const actor = row.actorUserId ? byUser.get(row.actorUserId) : undefined
    const category = categoryOf(row.action)
    // The role written with the row; rows from before it was written show the
    // role now, which the screen says.
    const thenRole = str(d.actorRole) ?? (row.action === 'permission.denied' ? str(d.role) : null)
    const thenName = str(d.actorRoleName) ?? (row.action === 'permission.denied' ? str(d.roleName) : null)
    return {
      id: row.id,
      at: row.createdAt,
      actor: row.actorUserId
        ? {
            userId: row.actorUserId,
            name: actor ? loginName(actor) : 'A removed login',
            // "(now)" is today's role under today's name.
            role: thenRole ? roleLabel(thenRole, names, thenName) : actor ? `${names.role(actor.role) ?? roleLabel(actor.role, names)} (now)` : '',
          }
        : null,
      action: row.action,
      actionLabel: actionLabel(row.action),
      category,
      categoryLabel: category ? AUDIT_CATEGORIES[category] : null,
      summary: summarise({ action: row.action, entityType: row.entityType, entityId: row.entityId, details: d }, names),
      ip: str(d.ip),
      device: deviceOf(d.userAgent),
      requestId: row.requestId,
    }
  })
}

/**
 * The "Done by" and "About" choices. From the log's own permission, not from
 * the Users and Employees lists: whoever reads the log may hold neither, or
 * reach only a department of them, while the log covers the whole company.
 */
export async function auditFilterPeople(ctx: AppContext) {
  const { logins, employees } = await repo.filterPeople(ctx.db)
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  // Somebody with two logins (Day 23) is listed once per login, so each says which.
  const loginsPerPerson = new Map<string, number>()
  for (const m of logins) if (m.employeeId) loginsPerPerson.set(m.employeeId, (loginsPerPerson.get(m.employeeId) ?? 0) + 1)
  const actorName = (m: (typeof logins)[number]) => {
    const name = m.employee?.fullName ?? m.user.email
    return m.employeeId && (loginsPerPerson.get(m.employeeId) ?? 0) > 1 ? `${name} — ${m.roleDef.name} login` : name
  }
  return {
    actors: logins.map((m) => ({ userId: m.userId, name: actorName(m) })).sort(byName),
    employees: employees.map((e) => ({ id: e.id, name: e.fullName, code: e.employeeCode })).sort(byName),
  }
}

/** One page, newest first. `more` says whether "Load older" has anything to load. */
export async function listAuditLog(ctx: AppContext, q: AuditQuery, cursor?: repo.AuditCursor) {
  const filter = await filterOf(ctx, q)
  const rows = await repo.page(ctx.db, filter, PAGE_SIZE + 1, cursor)
  const more = rows.length > PAGE_SIZE
  return { rows: await describe(ctx, rows.slice(0, PAGE_SIZE)), more }
}

/**
 * Everything the filters match, for a CSV — and the export is itself a row in
 * the log, so taking a copy of who-did-what is as visible as anything else.
 */
export async function exportAuditLog(ctx: AppContext, q: AuditQuery) {
  const filter = await filterOf(ctx, q)
  const total = await repo.countOf(ctx.db, filter)
  if (total > EXPORT_LIMIT) {
    throw BusinessRule(`That is ${total.toLocaleString('en-IN')} rows, more than the ${EXPORT_LIMIT.toLocaleString('en-IN')} one file can hold. Choose a shorter date range.`)
  }

  const rows: AuditEntryView[] = []
  let cursor: repo.AuditCursor | undefined
  for (;;) {
    const batch = await repo.page(ctx.db, filter, EXPORT_BATCH, cursor)
    rows.push(...(await describe(ctx, batch)))
    const last = batch[batch.length - 1]
    if (batch.length < EXPORT_BATCH || !last) break
    cursor = { before: last.createdAt, beforeId: last.id }
  }

  await recordSecurityEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    requestId: ctx.requestId,
    action: 'audit.exported',
    details: {
      rows: rows.length,
      filters: { from: q.from ?? null, to: q.to ?? null, category: q.category ?? null, actorUserId: q.actorUserId ?? null, employeeId: q.employeeId ?? null },
    },
  })

  return { rows, timezone: await companyTimezone(ctx) }
}
