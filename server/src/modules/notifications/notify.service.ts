import type { AppContext } from '../../platform/context'
import type { TxDb } from '../../platform/db/transaction'
import type { Permission } from '../../platform/authz/permissions'
import { toGrant } from '../../platform/authz/grant'
import { EMPLOYEE_ROLE } from '../../platform/authz/defaultRoles'
import { isSelfServiceLogin } from '../../domain/org/logins'
import { loadWork, mayDoWork, type WorkKind } from '../organization/workRules.service'
import { isInScope } from '../../platform/authz/scopeWhere'
import { TREE_SCOPES, type ScopedResource } from '../../platform/authz/scope'
import { buildTree, placeIn } from '../../domain/org/companyTree'
import { topPeople, treePeople } from '../organization/tree.repository'
import { isEnabled, NOTIFICATION_EVENTS, type NotificationEvent } from '../../domain/notifications/events'
import * as repo from './notification.repository'
import * as roleRepo from '../roles/roles.repository'
import { appLink, emailReady } from '../../platform/email/mailer'

/**
 * Sending a notice — always from the server, always inside the transaction of
 * the change it reports.
 *
 * "Inside" is the point (guide, the request lifecycle, step 9g). If the leave
 * approval rolls back, the "your leave was approved" notice rolls back with it;
 * there is never a notice about something that did not happen.
 *
 * Recipients are found by what people may DO — "whoever verifies documents
 * for this person" — or, for leave, by the company tree (the person it goes
 * to: leave/leaveApprover.service) — never by a list of names or hard-coded ids. The old code sent approvals to
 * the literal string 'demo-hr-admin-id', so no approver ever heard a thing.
 *
 * The person who did the thing is not told about it. HR approving a request
 * does not need a notice saying HR approved it.
 */

export type Recipients =
  | { users: readonly string[] }
  | { employee: string }
  | { employees: readonly string[] }
  | { holding: Permission }
  /**
   * Whoever holds `permission` AND whose scope for `resource` reaches this
   * employee — the same rule that decides whether they can open the thing the
   * notice is about. A verifier who checks one department's documents is not
   * told about another department's uploads.
   */
  | { reaching: { permission: Permission; resource: ScopedResource; employeeId: string; work?: WorkKind; alsoHolding?: Permission } }
  /**
   * Whoever holds `permission` AND may do that kind of work on this employee
   * (Day 22: one's own, and a fellow worker's, goes up the tree). A notice
   * "to check" sent to somebody who would be refused is a notice about nothing.
   */
  | { doing: { permission: Permission; work: WorkKind; employeeId: string } }
  /** Several of the above together — each person told once. */
  | { all: readonly Recipients[] }
  | { everybody: true }

export interface Notice {
  event: NotificationEvent
  to: Recipients
  title: string
  message: string
  link?: string | null
  entity?: { type: string; id: string }
  /** Tell the actor too — for notices ABOUT them, like a password change. */
  includeActor?: boolean
  /** Never tell this employee's logins — the person a notice about them is for others. */
  notAbout?: string
}

async function resolve(tx: TxDb, organizationId: string, to: Recipients): Promise<string[]> {
  if ('users' in to) return [...to.users]
  if ('employee' in to) return repo.usersOfEmployee(tx, to.employee)
  if ('employees' in to) return repo.usersOfEmployees(tx, to.employees)
  // Found through the company's roles as they stand — a custom role given the
  // permission on the Roles screen is told like a built-in one.
  if ('holding' in to) {
    const holders = await roleRepo.membershipsHolding(tx, to.holding)
    return holders.filter((m) => m.status !== 'inactive').map((m) => m.userId)
  }
  if ('everybody' in to) return repo.allUsers(tx)
  if ('all' in to) {
    const groups = await Promise.all(to.all.map((part) => resolve(tx, organizationId, part)))
    return [...new Set(groups.flat())]
  }
  if ('doing' in to) {
    const holders = (await roleRepo.membershipsHolding(tx, to.doing.permission)).filter((m) => m.status !== 'inactive')
    return (await workers(tx, organizationId, to.doing.work, to.doing.employeeId, holders)).map((m) => m.userId)
  }
  return reaching(tx, organizationId, to.reaching)
}

type Holder = Awaited<ReturnType<typeof roleRepo.membershipsHolding>>[number]

/** Of these holders, those who may do this kind of work on the employee. */
async function workers(tx: TxDb, organizationId: string, work: WorkKind, employeeId: string, holders: Holder[]): Promise<Holder[]> {
  if (holders.length === 0) return []
  const loaded = await loadWork(tx, organizationId, work)
  return holders.filter((m) => mayDoWork(loaded, { employeeId: m.employee?.id ?? null, isSuperAdmin: m.roleDef.locked }, employeeId))
}

/** Live logins holding `permission` whose `resource` scope reaches `employeeId` — and, given `work`, who may do it there. */
async function reaching(
  tx: TxDb,
  organizationId: string,
  { permission, resource, employeeId, work, alsoHolding }: { permission: Permission; resource: ScopedResource; employeeId: string; work?: WorkKind | undefined; alsoHolding?: Permission | undefined },
): Promise<string[]> {
  const [all, place] = await Promise.all([roleRepo.membershipsHolding(tx, permission), repo.placeOf(tx, employeeId)])
  if (!place) return []
  const holders = all.filter((m) => m.status !== 'inactive' && (!alsoHolding || m.roleDef.locked || m.roleDef.permissions.includes(alsoHolding)))
  // The scope as it APPLIES (toGrant), not as stored: a role without the
  // permission a scope belongs to reaches only its own rows there.
  const live = (work ? await workers(tx, organizationId, work, employeeId, holders) : holders)
    // An employee login beside a live role login reaches only its own rows (Day 23), as it does when it reads them.
    .map((m) => ({ ...m, scope: m.employee && isSelfServiceLogin(m, m.employee.memberships, EMPLOYEE_ROLE) ? 'SELF' as const : toGrant(m.roleDef).scopes[resource] }))
  // A holder whose scope follows the company tree (Day 22) is decided on their
  // place in it; the tree is read once, and only when somebody needs it.
  const followsTree = live.some((m) => TREE_SCOPES.has(m.scope))
  const [people, top] = followsTree ? await Promise.all([treePeople(tx), topPeople(tx)]) : [[], []]
  const tree = followsTree ? buildTree(people) : null
  return live
    .filter((m) => {
      const holderId = m.employee?.id ?? null
      return isInScope(
        {
          scope: m.scope,
          employeeId: holderId,
          departmentId: m.employee?.departmentId ?? null,
          tree: tree ? (holderId ? placeIn(tree, holderId, top) : { below: [], above: top }) : undefined,
        },
        place,
      )
    })
    .map((m) => m.userId)
}

/** Who is acting and in which company — all a notice needs to know of the caller. */
export type NoticeActor = Pick<AppContext, 'userId' | 'organizationId'> & Partial<Pick<AppContext, 'employeeId'>>

/** Writes the notices. Returns how many were written — none when the event is switched off. */
export async function notify(ctx: NoticeActor, tx: TxDb, notice: Notice): Promise<number> {
  const settings = await repo.savedSettings(tx)
  if (!isEnabled(notice.event, settings)) return 0

  const users = new Set(await resolve(tx, ctx.organizationId, notice.to))
  if (!notice.includeActor) {
    users.delete(ctx.userId)
    // The actor is a person, not a login (Day 23): what they did from their
    // role login is not news to their employee login.
    if (ctx.employeeId) for (const own of await repo.usersOfEmployee(tx, ctx.employeeId)) users.delete(own)
  }
  if (notice.notAbout) for (const own of await repo.usersOfEmployee(tx, notice.notAbout)) users.delete(own)
  if (users.size === 0) return 0

  const rule = NOTIFICATION_EVENTS[notice.event]
  // Also by email (client §45), when the server can send it and the company
  // has not turned it off for this event — queued in this same transaction,
  // so a change that rolls back sends nothing.
  if (emailReady() && ((await repo.savedEmailChoices(tx)).get(notice.event) ?? true)) {
    const to = await repo.loginEmails(tx, [...users])
    await repo.queueEmails(
      tx,
      to.map((toEmail) => ({
        organizationId: ctx.organizationId,
        toEmail,
        subject: notice.title.slice(0, 160),
        body: `${notice.message}\n\nOpen it: ${appLink(notice.link)}\n\nThis is an automatic message from the company’s HR system. Reply to your HR team, not to this email.`,
      })),
    )
  }
  return repo.createMany(
    tx,
    [...users].map((userId) => ({
      organizationId: ctx.organizationId,
      userId,
      event: notice.event,
      kind: rule.kind,
      title: notice.title.slice(0, 160),
      message: notice.message.slice(0, 1000),
      link: notice.link ?? null,
      entityType: notice.entity?.type ?? null,
      entityId: notice.entity?.id ?? null,
    })),
  )
}
