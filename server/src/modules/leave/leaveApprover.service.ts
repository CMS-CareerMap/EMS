import type { AppContext } from '../../platform/context'
import type { TxDb } from '../../platform/db/transaction'
import { BadRequest, Forbidden, NotFound } from '../../platform/errors/AppError'
import { buildTree, type CompanyTree } from '../../domain/org/companyTree'
import {
  mayDecide,
  mayReverse,
  primaryApprover,
  routeOf,
  type ApprovalRules,
  type Decider,
  type DecisionRight,
} from '../../domain/leave/approval'
import { namesOf, treePeople } from '../organization/tree.repository'
import { findApprovalRules } from '../organization/organization.repository'
import * as roleRepo from '../roles/roles.repository'
import * as notificationRepo from '../notifications/notification.repository'
import * as repo from './leave.repository'

/**
 * Who decides a leave request (Day 22), as the server applies it: the company
 * tree and Settings → Approvals, read when somebody decides — so a request
 * follows its requester to a new manager, and falls to the Super Admin when a
 * manager leaves. The rules themselves are domain/leave/approval.ts.
 */

export interface ApprovalWorld {
  tree: CompanyTree
  rules: ApprovalRules
}

export async function approvalWorld(db: TxDb, organizationId: string): Promise<ApprovalWorld> {
  const [people, row] = await Promise.all([treePeople(db), findApprovalRules(db, organizationId)])
  return {
    tree: buildTree(people),
    rules: {
      ownerEmployeeId: row?.ownerEmployeeId ?? null,
      noManagerApproverId: row?.leaveNoManagerApproverId ?? null,
      backup: row?.leaveBackup ?? 'super_admin',
      reversal: row?.leaveReversal ?? 'manager_or_super_admin',
    },
  }
}

/** "The Super Admin" here is whoever holds the Super Admin panel — `role:manage` is theirs alone. */
export const deciderOf = (ctx: AppContext): Decider => ({ employeeId: ctx.employeeId, isSuperAdmin: ctx.can('role:manage') })

export interface RequestRights {
  canDecide: boolean
  canReverse: boolean
  /** Deciding instead of the person whose decision it is. */
  asBackup: boolean
}

/** What the caller may do with one request, for the buttons a screen draws. */
export function rightsOn(world: ApprovalWorld, decider: Decider, request: { employeeId: string; status: string }): RequestRights {
  const decide: DecisionRight = request.status === 'pending' ? mayDecide(world.tree, world.rules, request.employeeId, decider) : { allowed: false, asBackup: false }
  const reverse: DecisionRight = request.status === 'approved' ? mayReverse(world.tree, world.rules, request.employeeId, decider) : { allowed: false, asBackup: false }
  return { canDecide: decide.allowed, canReverse: reverse.allowed, asBackup: decide.allowed && decide.asBackup }
}

/**
 * Who decides this person's leave, in words — for the refusal that names
 * whom to ask, and for the screen. "Sunita Rao" or "the Super Admin".
 */
export async function approverName(db: TxDb, world: ApprovalWorld, employeeId: string): Promise<string> {
  const route = routeOf(world.tree, world.rules, employeeId)
  if (route.kind === 'owner') return 'nobody — the owner’s leave is recorded directly'
  const primary = primaryApprover(route)
  if (!primary) return 'the Super Admin'
  return (await namesOf(db, [primary])).get(primary) ?? 'their reporting manager'
}

/** The names of whoever decides each of these people's leave, in one read. */
export async function approverNames(db: TxDb, world: ApprovalWorld, employeeIds: readonly string[]): Promise<Map<string, string>> {
  const primaries = new Map<string, string | null>()
  for (const id of new Set(employeeIds)) {
    const route = routeOf(world.tree, world.rules, id)
    primaries.set(id, route.kind === 'owner' ? null : primaryApprover(route))
  }
  const names = await namesOf(db, [...new Set([...primaries.values()].filter((v): v is string => Boolean(v)))])
  const result = new Map<string, string>()
  for (const [id, primary] of primaries) {
    const route = routeOf(world.tree, world.rules, id)
    // Words that read after "Goes to …" and "decided by …".
    result.set(id, route.kind === 'owner' ? 'the owner themselves' : primary ? (names.get(primary) ?? 'their reporting manager') : 'the Super Admin')
  }
  return result
}

/**
 * The request, when the caller may act on it the way they ask — or why not.
 *
 * Somebody who can see the request (their leave scope reaches it: HR, say) is
 * told who decides it. Anybody else is told it does not exist: a 403 would
 * confirm that it does.
 */
export async function requestToAct(
  ctx: AppContext,
  id: string,
  action: 'decide' | 'reverse',
): Promise<{ request: repo.LeaveRequestRow; world: ApprovalWorld; asBackup: boolean }> {
  const request = await repo.findRequestInCompany(ctx.db, id)
  if (!request) throw NotFound('Leave request not found')
  const world = await approvalWorld(ctx.db, ctx.organizationId)
  const decider = deciderOf(ctx)
  const right =
    action === 'decide'
      ? mayDecide(world.tree, world.rules, request.employeeId, decider)
      : mayReverse(world.tree, world.rules, request.employeeId, decider)
  if (right.allowed) return { request, world, asBackup: right.asBackup }

  const visible = await repo.findRequest(ctx.db, ctx.scopeFor('leave'), id)
  if (!visible && request.employeeId !== ctx.employeeId) throw NotFound('Leave request not found')
  const who = await approverName(ctx.db, world, request.employeeId)
  if (request.employeeId === ctx.employeeId) {
    throw Forbidden(`You cannot decide on your own leave. It goes to the person above you: ${who}.`)
  }
  throw Forbidden(
    action === 'decide'
      ? `${request.employee.fullName}'s leave is decided by ${who}, the person they report to in the company tree.`
      : world.rules.reversal === 'super_admin_only'
        ? 'Only the Super Admin can cancel approved leave.'
        : `Only ${who} or the Super Admin can cancel ${request.employee.fullName}'s approved leave.`,
  )
}

/**
 * Who is told about a new or withdrawn request: the person whose decision it
 * is — every Super Admin when that is "the Super Admin", or when that person
 * has no login to be told on. Never the requester; nobody for the owner, whose
 * leave nobody approves.
 */
export async function approverUsers(tx: TxDb, organizationId: string, employeeId: string): Promise<string[]> {
  const world = await approvalWorld(tx, organizationId)
  const route = routeOf(world.tree, world.rules, employeeId)
  if (route.kind === 'owner') return []
  const primary = primaryApprover(route)
  const primaryUser = primary ? await notificationRepo.userOfEmployee(tx, primary) : null
  const users = primaryUser
    ? [primaryUser]
    : (await roleRepo.membershipsHolding(tx, 'role:manage')).filter((m) => m.status === 'active').map((m) => m.userId)
  const applicant = await notificationRepo.userOfEmployee(tx, employeeId)
  return users.filter((user) => user !== applicant)
}

/**
 * Refuses a request nobody could ever decide: somebody with nobody above,
 * when the only Super Admin is that same person — the usual state before the
 * owner is marked. A request that would wait forever is worse than a refusal
 * that says what to do.
 */
export async function assertSomebodyDecides(tx: TxDb, world: ApprovalWorld, employeeId: string): Promise<void> {
  const route = routeOf(world.tree, world.rules, employeeId)
  if (route.kind !== 'nobody_above' || route.approverId) return
  const others = (await roleRepo.membershipsHolding(tx, 'role:manage')).filter((m) => m.status === 'active' && m.employee?.id !== employeeId)
  if (others.length > 0) return
  throw BadRequest(
    'Nobody could decide this request: there is nobody above this person, and the only Super Admin is the same person. Mark the owner in Settings → Company tree — the owner’s leave needs no approval — or place them under somebody.',
  )
}

/** The people whose leave this person decides as the one asked — not as a backup. */
export function peopleDecidedBy(world: ApprovalWorld, decider: Decider): string[] {
  const me = decider.employeeId
  const people: string[] = []
  for (const id of world.tree.ids()) {
    if (id === me || world.tree.left(id)) continue
    const route = routeOf(world.tree, world.rules, id)
    if (route.kind === 'manager' ? route.managerId === me : route.kind === 'nobody_above' && (route.approverId ? route.approverId === me : decider.isSuperAdmin)) {
      people.push(id)
    }
  }
  return people
}
