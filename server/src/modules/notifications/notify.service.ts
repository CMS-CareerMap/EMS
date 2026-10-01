import type { AppContext } from '../../platform/context'
import type { TxDb } from '../../platform/db/transaction'
import type { Permission } from '../../platform/authz/permissions'
import { readScopes } from '../../platform/authz/grant'
import { isInScope } from '../../platform/authz/scopeWhere'
import type { ScopedResource } from '../../platform/authz/scope'
import { isEnabled, NOTIFICATION_EVENTS, type NotificationEvent } from '../../domain/notifications/events'
import * as repo from './notification.repository'
import * as roleRepo from '../roles/roles.repository'

/**
 * Sending a notice — always from the server, always inside the transaction of
 * the change it reports.
 *
 * "Inside" is the point (guide, the request lifecycle, step 9g). If the leave
 * approval rolls back, the "your leave was approved" notice rolls back with it;
 * there is never a notice about something that did not happen.
 *
 * Recipients are found by what people may DO — "whoever holds leave:approve"
 * — never by a list of names or hard-coded ids. The old code sent approvals to
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
  | { reaching: { permission: Permission; resource: ScopedResource; employeeId: string } }
  | { leaveApproversOf: string }
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
}

async function resolve(tx: TxDb, to: Recipients): Promise<string[]> {
  if ('users' in to) return [...to.users]
  if ('employee' in to) {
    const user = await repo.userOfEmployee(tx, to.employee)
    return user ? [user] : []
  }
  if ('employees' in to) return [...(await repo.usersOfEmployees(tx, to.employees)).values()]
  // Found through the company's roles as they stand — a custom role given the
  // permission on the Roles screen is told like a built-in one.
  if ('holding' in to) {
    const holders = await roleRepo.membershipsHolding(tx, to.holding)
    return holders.filter((m) => m.status !== 'inactive').map((m) => m.userId)
  }
  if ('everybody' in to) return repo.allUsers(tx)
  if ('reaching' in to) return reaching(tx, to.reaching.permission, to.reaching.resource, to.reaching.employeeId)

  // Whoever can decide this person's leave: every approver whose leave scope
  // reaches them — the whole company, their team (their reporting manager),
  // or their department. A request somebody cannot open is not one to tell
  // them about. Never the person the leave is for — they may not decide their
  // own, even when somebody else filed it for them.
  const users = await reaching(tx, 'leave:approve', 'leave', to.leaveApproversOf)
  const applicant = await repo.userOfEmployee(tx, to.leaveApproversOf)
  return users.filter((user) => user !== applicant)
}

/** Live logins holding `permission` whose `resource` scope reaches `employeeId`. */
async function reaching(tx: TxDb, permission: Permission, resource: ScopedResource, employeeId: string): Promise<string[]> {
  const [holders, place] = await Promise.all([roleRepo.membershipsHolding(tx, permission), repo.placeOf(tx, employeeId)])
  if (!place) return []
  return holders
    .filter((m) => m.status !== 'inactive')
    .filter((m) =>
      isInScope(
        { scope: readScopes(m.roleDef.scopes)[resource], employeeId: m.employee?.id ?? null, departmentId: m.employee?.departmentId ?? null },
        place,
      ),
    )
    .map((m) => m.userId)
}

/** Who is acting and in which company — all a notice needs to know of the caller. */
export type NoticeActor = Pick<AppContext, 'userId' | 'organizationId'>

/** Writes the notices. Returns how many were written — none when the event is switched off. */
export async function notify(ctx: NoticeActor, tx: TxDb, notice: Notice): Promise<number> {
  const settings = await repo.savedSettings(tx)
  if (!isEnabled(notice.event, settings)) return 0

  const users = new Set(await resolve(tx, notice.to))
  if (!notice.includeActor) users.delete(ctx.userId)
  if (users.size === 0) return 0

  const rule = NOTIFICATION_EVENTS[notice.event]
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
