import type { AppContext } from '../../platform/context'
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { tellLeft } from '../notifications/peopleNotices'
import { closePendingOf } from '../requests/requests.repository'
import { isUniqueViolation } from '../../platform/db/errors'
import { generateToken, hashInviteToken } from '../../platform/auth/tokenHash'
import { logger } from '../../platform/logger'
import {
  refuseRoleChange,
  refuseAccountChange,
  mayGive,
  mayManage,
  REFUSAL_MESSAGES,
  ACCOUNT_REFUSAL_MESSAGES,
  type PolicyRole,
} from './user.policy'
import * as repo from './user.repository'
import * as roleRepo from '../roles/roles.repository'
import type { Permission } from '../../platform/authz/permissions'
import { employeesInScope, isInScope } from '../../platform/authz/scopeWhere'
import * as employeeRepo from '../employee/employee.repository'
import { audit } from '../audit/audit.service'
import { buildTree } from '../../domain/org/companyTree'
import { treePeople } from '../organization/tree.repository'
import * as lifecycleRepo from '../lifecycle/lifecycle.repository'
import { companyToday } from '../organization/organization.service'
import { addCalendarDays, fromDateColumn, toDateColumn } from '../../domain/shared/dates'
import { isOpenFrom } from '../payroll/payrollLock.service'

/**
 * The lock every change to roles or to who holds them takes (Day 21), so a
 * role being edited on the Roles screen and the same role being handed out at
 * that moment are decided one after the other, never on a half-changed role.
 */
export const rolesLock = (organizationId: string) => `roles:${organizationId}`

/**
 * The caller's role and the one asked for, as the rules see them; a key that
 * is not a role is refused.
 *
 * The caller's role is READ AGAIN here, under the roles lock, and the
 * permission the action needs is checked against it. The request was let in
 * on the role as it stood when it arrived; a demotion, or the permission
 * being taken off the role, that committed while this request waited for the
 * lock must stop it.
 */
export async function rolesForGrant(
  tx: TxDb,
  ctx: AppContext,
  wanted: string,
  needs: readonly Permission[],
): Promise<{ actor: PolicyRole; next: PolicyRole; order: Awaited<ReturnType<typeof roleRepo.policyRoles>>['order']; roles: Map<string, PolicyRole> }> {
  const [{ roles, order }, me] = await Promise.all([roleRepo.policyRoles(tx), repo.findMembershipForChange(tx, ctx.membershipId)])
  if (!me || me.status !== 'active') throw Forbidden('Your access has changed. Sign in again.')
  const actor = roles.get(me.role)
  if (!actor) throw Forbidden('Your role has changed. Sign in again.')
  if (!needs.some((p) => actor.grant.permissions.has(p))) throw Forbidden('Your role no longer allows this. Reload the page.')
  const next = roles.get(wanted)
  if (!next) throw BadRequest('That is not one of the company’s roles')
  return { actor, next, order, roles }
}

/**
 * The people a caller may act on as users: everybody for a company-wide
 * reach, else only those whose employee record the caller's employee scope
 * reaches (Day 21). A department head who may switch logins off switches off
 * their department's, not Finance's.
 */
async function assertTargetInReach(tx: TxDb, ctx: AppContext, actor: PolicyRole, targetMembershipId: string): Promise<void> {
  if (actor.locked) return
  const scope = { ...ctx.scopeFor('employee'), scope: actor.grant.scopes.employee }
  if (scope.scope === 'ORGANIZATION') return
  const place = await repo.employeePlaceOf(tx, targetMembershipId)
  // Out of reach reads as absent, never as forbidden: existence is not told.
  if (!place || !isInScope(scope, place)) throw NotFound('User not found')
}

/**
 * Refuses handing out a role above the caller's own, or one holding powers they
 * lack. The rule for invitations and for logins made with an employee record —
 * the role endpoint applies it inside refuseRoleChange.
 */
export async function assertMayGive(tx: TxDb, ctx: AppContext, wanted: string, needs: readonly Permission[]): Promise<PolicyRole> {
  const { actor, next, order } = await rolesForGrant(tx, ctx, wanted, needs)
  if (!mayGive(actor, next, order)) throw Forbidden(REFUSAL_MESSAGES.not_below)
  return next
}

/**
 * The four things the original backend's edge functions used to do, and nothing else
 * replaced: invite, change role, change status, terminate.
 *
 * Every one of them is a transaction, because every one of them touches more
 * than one table and a half-applied change here is an account in an impossible
 * state — access revoked but role unchanged, or an employee record with no
 * login pointing at it.
 */

const INVITE_VALID_FOR_HOURS = 72

/**
 * Everybody's login — for a caller whose employee scope is the company. A
 * narrower one (Day 21) sees the logins of the people it reaches, and not the
 * logins with no employee record (operators), which nobody narrower may manage.
 */
export async function listUsers(ctx: AppContext): Promise<repo.MembershipRow[]> {
  const scope = ctx.scopeFor('employee')
  return repo.listMemberships(ctx.db, scope.scope === 'ORGANIZATION' ? null : employeesInScope(scope))
}

export interface InviteInput {
  email: string
  /** A role key of this company. */
  role: string
  fullName?: string | undefined
  employeeCode?: string | undefined
}

export interface InviteResult {
  membership: repo.MembershipRow
  /**
   * The raw invitation token, returned ONCE and never stored.
   *
   * There is no email infrastructure yet, so the administrator copies this to
   * the new joiner themselves. That is deliberate rather than a gap papered
   * over: a "we sent you an email" message that sends nothing is worse than
   * asking someone to paste a link, because nobody finds out for a week.
   */
  inviteToken: string
  expiresAt: Date
}

/**
 * Creates a login for someone who does not have one.
 *
 * The new user gets `passwordHash = null`, which cannot match any password, and
 * a single-use token that expires. So there is no default credential, no shared
 * welcome password, and an invitation that is forwarded twice still only works
 * once.
 */
export async function inviteUser(ctx: AppContext, input: InviteInput): Promise<InviteResult> {
  const email = input.email.toLowerCase().trim()

  if (await repo.findMembershipByEmail(ctx.db, email)) {
    throw Conflict('Someone with that email address already has access to this company')
  }

  const login = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    // The policy applies to invitations too: an inviter cannot hand out a role
    // above their own, or they could invite a super_admin and then sign in as
    // them. Reused rather than re-written, so the rule cannot drift.
    const { actor, next: given, order } = await rolesForGrant(tx, ctx, input.role, ['user:invite'])
    if (!mayGive(actor, given, order)) throw Forbidden(REFUSAL_MESSAGES.not_below)
    // An invitation makes a login with no team and no department — and its
    // employee record, if any, with no manager and no department. Only a
    // company-wide reach could see either afterwards, or send its link again.
    // Read from the role as it stands under the lock, not as the request found it.
    if (!actor.locked && actor.grant.scopes.employee !== 'ORGANIZATION') {
      throw Forbidden('Inviting adds somebody outside any team or department, so it needs a company-wide reach. Add them under Employees instead, with yourself as their reporting manager, and give them a login there.')
    }

    const employee = input.employeeCode
      ? await employeeRepo.createEmployee(tx, {
          organizationId: ctx.organizationId,
          employeeCode: input.employeeCode.trim(),
          fullName: input.fullName?.trim() || email,
        })
      : null

    const created = await createLoginInTransaction(tx, {
      email,
      role: input.role,
      organizationId: ctx.organizationId,
      invitedByUserId: ctx.userId,
      employeeId: employee?.id ?? null,
    })

    await audit(ctx, {
      action: 'user.invited',
      entityType: 'membership',
      entityId: created.membershipId,
      details: { email, role: input.role, roleName: given.grant.name, withEmployeeRecord: Boolean(input.employeeCode) },
    }, tx)

    return created
  })

  const membership = await repo.findMembership(ctx.db, login.membershipId)
  if (!membership) throw NotFound('Invitation was created but could not be read back')

  logger.info('User invited', {
    invitedBy: ctx.userId,
    organizationId: ctx.organizationId,
    role: input.role,
  })

  return { membership, inviteToken: login.inviteToken, expiresAt: login.expiresAt }
}

/**
 * Changes a role, subject to the three invariants in user.policy.
 *
 * The count of super admins is read INSIDE the transaction, so two
 * simultaneous demotions cannot each see "there are two" and both proceed.
 */
export async function changeRole(
  ctx: AppContext,
  membershipId: string,
  newRole: string,
): Promise<repo.MembershipRow> {
  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const target = await repo.findMembershipForChange(tx, membershipId)
    if (!target) throw NotFound('User not found')

    // Read with the target's own role, so reach is checked before the role
    // asked for: outside it, any request is "not found", a bad key included.
    const { actor, next: targetCurrent, order, roles } = await rolesForGrant(tx, ctx, target.role, ['membership:role:assign'])
    await assertTargetInReach(tx, ctx, actor, membershipId)
    const next = roles.get(newRole)
    if (!next) throw BadRequest('That is not one of the company’s roles')
    // Only a login that can sign in is one of the "active" Super Admins: an
    // invitation nobody has used yet can be changed whatever the count.
    const activeSuperAdminCount = target.status === 'active' ? await repo.countActiveSuperAdmins(tx) : Number.POSITIVE_INFINITY

    const refusal = refuseRoleChange({
      actorMembershipId: ctx.membershipId,
      actorEmployeeId: ctx.employeeId,
      actor,
      targetMembershipId: target.id,
      targetEmployeeId: target.employeeId,
      targetCurrent,
      next,
      order,
      activeSuperAdminCount,
    })

    if (refusal) throw Forbidden(REFUSAL_MESSAGES[refusal])
    await assertOtherLoginsBelow(tx, ctx, actor, order, roles, target)
    // One login per role per person (Day 23): their other login already holds it.
    if (target.employeeId && newRole !== target.role) {
      const others = await repo.loginsOfPerson(tx, target.employeeId)
      if (others.some((l) => l.id !== target.id && l.role === newRole)) {
        throw Conflict(`This person already has a ${next.grant.name} login. Each of their logins holds a different role.`)
      }
    }

    await repo.setRole(tx, membershipId, newRole)
    await audit(ctx, {
      action: 'user.role_changed',
      entityType: 'membership',
      entityId: membershipId,
      // The names as they read today, kept with the row: a custom role
      // deleted later still reads by name in the log.
      details: { from: target.role, to: newRole, fromName: targetCurrent.grant.name, toName: next.grant.name },
    }, tx)
  })

  // A role change must take effect NOW, not in fifteen minutes. The middleware
  // reads the role from the database on every request; ending their access
  // tokens (not their sessions) makes their browser refresh at its next
  // request and redraw with the new role. Ending the sessions too, as this
  // used to, signed them out — and their browser's next refresh was then
  // logged as a copied session.
  const updated = await repo.findMembership(ctx.db, membershipId)
  if (!updated) throw NotFound('User not found')
  await roleRepo.endAccessTokens([updated.userId])

  logger.info('Role changed', {
    by: ctx.userId,
    membershipId,
    from: ctx.role,
    to: newRole,
  })

  return updated
}

export async function changeStatus(
  ctx: AppContext,
  membershipId: string,
  status: 'active' | 'inactive',
): Promise<repo.MembershipRow> {
  const target = await repo.findMembership(ctx.db, membershipId)
  if (!target) throw NotFound('User not found')

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    // Read again under the lock: their role may have changed since.
    const current = await repo.findMembershipForChange(tx, membershipId)
    if (!current) throw NotFound('User not found')
    // Switching somebody on is as much "managing" them as switching them off.
    // One login only: their other one, if they have two, stays as it is. Only
    // switching off a login that can sign in removes a Super Admin.
    await assertMayManage(tx, ctx, current, status === 'inactive' && current.status === 'active', ['user:status:update'])
    // Leaving closed every login of theirs; turning one back on would let
    // somebody who has left sign in again.
    if (status === 'active' && current.employee?.archivedAt) {
      throw BadRequest(`${current.employee.fullName} has left the company, so their logins stay closed.`)
    }
    await repo.setStatus(tx, membershipId, status)
    await audit(ctx, {
      action: 'user.status_changed',
      entityType: 'membership',
      entityId: membershipId,
      // Which login, for somebody with two (Day 23) — and about whom.
      details: {
        from: target.status,
        to: status,
        email: target.email,
        role: current.role,
        roleName: target.roleName,
        ...(current.employeeId ? { employeeId: current.employeeId } : {}),
      },
    }, tx)
  })

  // Deactivating must end the session immediately. Without this the person
  // stays signed in until their access token expires, which is exactly the
  // window that matters when someone is being removed in a hurry.
  if (status === 'inactive') await repo.revokeSessions(target.userId)

  logger.info('Account status changed', { by: ctx.userId, membershipId, status })

  const updated = await repo.findMembership(ctx.db, membershipId)
  if (!updated) throw NotFound('User not found')
  return updated
}

/**
 * Termination — guide §A9.
 *
 * Despite the HTTP verb, this DELETES NOTHING. Access ends; the record stays.
 *
 * That is not caution, it is law: payslips, PF and ESI filings all reference
 * this employee, and a payslip whose employee row has vanished is an unusable
 * document at exactly the moment somebody needs it — a loan application, a
 * provident-fund claim, an inspection. Deleting the row would also cascade
 * through attendance and leave, destroying the record of work already done and
 * already paid for.
 *
 * So: the membership goes inactive, every session dies, the employee row is
 * archived out of the active list, and everything attached to it remains
 * exactly where it was.
 *
 * Leaving is the PERSON's (Day 23): somebody with an employee login and a role
 * login leaves by either one, and both close together, with every session of
 * both. The caller must be allowed to close each — removing an HR head through
 * their employee login still needs a role above HR.
 */
export async function terminateUser(ctx: AppContext, membershipId: string): Promise<void> {
  const target = await repo.findMembership(ctx.db, membershipId)
  if (!target) throw NotFound('User not found')

  const closed = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const current = await repo.findMembershipForChange(tx, membershipId)
    if (!current) throw NotFound('User not found')
    const logins = current.employeeId ? await repo.loginsOfPerson(tx, current.employeeId) : [{ ...current, userId: target.userId }]
    // Only a login that can sign in is "the last Super Admin": one switched
    // off, or an invitation nobody used, loses nothing.
    for (const login of logins) await assertMayManage(tx, ctx, login, login.status === 'active', ['user:delete'])
    for (const login of logins) await repo.setStatus(tx, login.id, 'inactive')
    // Somebody removed twice keeps the day they left.
    if (current.employeeId && !current.employee?.archivedAt) {
      // Leaving as the lifecycle's exit leaves (client §43), under the same
      // lock after the roles lock: a resignation cannot be handed in or
      // accepted while they are being removed.
      await lockFor(tx, `lifecycle:${current.employeeId}`)
      // Their requests' lock before their record changes, the order a decision takes them in.
      await lockFor(tx, `requests:${current.employeeId}`)
      const person = await lifecycleRepo.findPerson(tx, null, current.employeeId)
      const today = await companyToday(ctx)
      const joined = fromDateColumn(person?.dateOfJoining ?? null)
      const before = fromDateColumn(person?.lastWorkingDate ?? null)
      // Paid up to today — or to a last working day already past. Somebody
      // who never joined has none.
      let lastDay = joined && joined > today ? null : before && before < today ? before : today
      // A month whose payroll is approved keeps what it paid: their last
      // working day then stays as it was, and the history says why.
      let payrollClosed = false
      if (lastDay !== before) {
        const earlier = [before, lastDay].filter((d): d is string => Boolean(d)).sort()[0]
        if (earlier && !(await isOpenFrom(ctx, addCalendarDays(earlier, 1)))) {
          lastDay = before
          payrollClosed = true
        }
      }
      await lifecycleRepo.updatePerson(tx, current.employeeId, {
        status: 'inactive',
        archivedAt: new Date(),
        lastWorkingDate: lastDay ? toDateColumn(lastDay) : null,
      })
      // Their employment history says they left, and a resignation still open is finished with.
      await lifecycleRepo.completeOpenResignations(tx, current.employeeId, ctx.userId)
      await lifecycleRepo.addEvent(tx, {
        organizationId: ctx.organizationId,
        employeeId: current.employeeId,
        kind: 'exited',
        effectiveDate: toDateColumn(lastDay ?? today),
        details: { via: 'access_removed', loginsClosed: logins.length, lastWorkingDate: lastDay, previousLastWorkingDate: before, ...(payrollClosed ? { payrollClosed } : {}) },
        createdByUserId: ctx.userId,
      })
      // Their manager and HR hear that they have gone (client §45).
      await tellLeft(ctx, tx, current.employeeId, lastDay, 'access_removed')
      const closedRequests = await closePendingOf(tx, current.employeeId, ctx.userId)
      if (closedRequests > 0) {
        await audit(ctx, { action: 'request.closed_on_leaving', entityType: 'employee', entityId: current.employeeId, details: { employeeId: current.employeeId, closed: closedRequests } }, tx)
      }
    }
    await audit(ctx, {
      action: 'user.terminated',
      entityType: 'membership',
      entityId: membershipId,
      details: {
        role: target.role,
        employeeArchived: Boolean(current.employeeId),
        ...(current.employeeId ? { employeeId: current.employeeId } : {}),
        loginsClosed: logins.length,
      },
    }, tx)
    return logins
  })

  for (const login of closed) await repo.revokeSessions(login.userId)

  logger.info('User terminated', {
    by: ctx.userId,
    membershipId,
    employeeArchived: Boolean(target.employeeId),
    loginsClosed: closed.length,
  })
}

/**
 * Closes every login of a person whose exit is being completed (the employee
 * lifecycle), inside the caller's transaction, under the roles lock the caller
 * takes. The same rules as removing them: the caller must be allowed to manage
 * each login — by `user:delete`, or by running the lifecycle — so HR does not
 * close a Super Admin's or an Accounts head's logins. Returns the users whose
 * sessions to end once the transaction commits.
 */
export async function closeLoginsForExit(tx: TxDb, ctx: AppContext, employeeId: string): Promise<string[]> {
  const logins = await repo.loginsOfPerson(tx, employeeId)
  await assertMayCloseLogins(tx, ctx, logins)

  for (const login of logins) {
    if (login.status !== 'inactive') await repo.setStatus(tx, login.id, 'inactive')
  }
  return logins.map((l) => l.userId)
}

const EXIT_NEEDS: readonly Permission[] = ['user:delete', 'employee:lifecycle:manage']

async function assertMayCloseLogins(db: TxDb, ctx: AppContext, logins: Awaited<ReturnType<typeof repo.loginsOfPerson>>): Promise<void> {
  for (const login of logins) {
    await assertMayManage(db, ctx, login, login.status === 'active', EXIT_NEEDS)
  }
}

/**
 * Whether the caller could close every login of this person — what the
 * "Complete exit" button asks, so it is not offered for somebody whose logins
 * the exit would then refuse to close.
 */
export async function mayCloseLoginsForExit(db: TxDb, ctx: AppContext, employeeId: string): Promise<boolean> {
  try {
    await assertMayCloseLogins(db, ctx, await repo.loginsOfPerson(db, employeeId))
    return true
  } catch (err) {
    if (err instanceof AppError && err.status === 403) return false
    throw err
  }
}

/** Ends every session of these users — after the change that closed their logins has committed. */
export async function endSessionsOf(userIds: readonly string[]): Promise<void> {
  for (const userId of userIds) await repo.revokeSessions(userId)
}

export interface AddLoginInput {
  email: string
  /** A role key of this company, different from every login the person has. */
  role: string
}

/**
 * Gives somebody already here another login (Day 23) — a role login beside
 * their employee login, with its own email and its own invitation link. Never
 * a new person: it is the same employee record, the same place in the company
 * tree, and every rule about "your own" applies to both logins alike.
 *
 * The Super Admin's, as the route says (role:manage): a second way into the
 * system for somebody is a decision about the company's roles.
 */
export async function addLogin(ctx: AppContext, employeeId: string, input: AddLoginInput): Promise<InviteResult> {
  const email = input.email.toLowerCase().trim()

  if (await repo.findMembershipByEmail(ctx.db, email)) {
    throw Conflict('Someone with that email address already has access to this company. Each login needs an email of its own.')
  }

  const login = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const { actor, next: given, order } = await rolesForGrant(tx, ctx, input.role, ['role:manage'])
    if (!mayGive(actor, given, order)) throw Forbidden(REFUSAL_MESSAGES.not_below)

    const person = await repo.personForLogin(tx, employeeId)
    if (!person) throw NotFound('Employee not found')
    if (person.archivedAt) throw BadRequest(`${person.fullName} has left the company.`)
    if (person.memberships.some((m) => m.role === input.role)) {
      throw Conflict(`${person.fullName} already has a ${given.grant.name} login. Choose a different role for this one.`)
    }

    const created = await createLoginInTransaction(tx, {
      email,
      role: input.role,
      organizationId: ctx.organizationId,
      invitedByUserId: ctx.userId,
      employeeId: person.id,
    })
    await audit(ctx, {
      action: 'user.login_added',
      entityType: 'membership',
      entityId: created.membershipId,
      details: { employeeId: person.id, email, role: input.role, roleName: given.grant.name, logins: person.memberships.length + 1 },
    }, tx)
    return created
  }).catch((err: unknown) => {
    // The same email added a moment ago by somebody else, past the check above.
    if (isUniqueViolation(err)) throw Conflict('Someone with that email address already has access to this company. Each login needs an email of its own.')
    throw err
  })

  const membership = await repo.findMembership(ctx.db, login.membershipId)
  if (!membership) throw NotFound('The login was created but could not be read back')

  logger.info('Login added', { by: ctx.userId, employeeId, role: input.role })

  return { membership, inviteToken: login.inviteToken, expiresAt: login.expiresAt }
}

/**
 * Refuses switching off (or back on) a login the caller may not manage: their
 * own, one whose role is not below theirs, or the last Super Admin. Inside the
 * caller's transaction and under the roles lock, so the count of Super Admins
 * cannot change between the check and the write.
 */
async function assertMayManage(
  tx: TxDb,
  ctx: AppContext,
  login: { id: string; role: string; employeeId: string | null },
  removingAccess: boolean,
  needs: readonly Permission[],
): Promise<void> {
  const { actor, next: target, order, roles } = await rolesForGrant(tx, ctx, login.role, needs)
  await assertTargetInReach(tx, ctx, actor, login.id)
  const refusal = refuseAccountChange({
    actorMembershipId: ctx.membershipId,
    actorEmployeeId: ctx.employeeId,
    actor,
    targetMembershipId: login.id,
    targetEmployeeId: login.employeeId,
    target,
    order,
    // Only switching OFF can leave the company without a Super Admin.
    activeSuperAdminCount: removingAccess ? await repo.countActiveSuperAdmins(tx) : Number.POSITIVE_INFINITY,
  })
  if (refusal) throw Forbidden(ACCOUNT_REFUSAL_MESSAGES[refusal])
  await assertOtherLoginsBelow(tx, ctx, actor, order, roles, login)
}

const OTHER_LOGIN_NOT_BELOW =
  'This person has another login whose role is not below yours, so their logins are managed by somebody above that role.'

/**
 * Refuses acting on one login of a person whose OTHER login the caller could
 * not manage (Day 23). A login is the person — every rule about "your own"
 * keys on them — so a senior's employee login, whose role is low, is as much
 * the senior as their Super Admin login: resetting its password, switching it
 * on or off or giving it a role is acting on the senior. Somebody's rank is
 * that of their highest login, switched off or not.
 */
async function assertOtherLoginsBelow(
  tx: TxDb,
  ctx: AppContext,
  actor: PolicyRole,
  order: Awaited<ReturnType<typeof roleRepo.policyRoles>>['order'],
  roles: Map<string, PolicyRole>,
  login: { id: string; employeeId: string | null },
): Promise<void> {
  if (actor.locked || !login.employeeId) return
  for (const other of await repo.loginsOfPerson(tx, login.employeeId)) {
    if (other.id === login.id) continue
    const role = roles.get(other.role)
    if (!role || !mayManage(actor, role, order)) throw Forbidden(OTHER_LOGIN_NOT_BELOW)
  }
  // The role order is not the company tree: an HR head may sit under a manager
  // whose role is below HR's. Resetting that manager's password, or switching
  // their login, is taking over the person who decides the HR head's leave.
  if (ctx.employeeId && buildTree(await treePeople(tx)).above(ctx.employeeId).includes(login.employeeId)) {
    throw Forbidden('This person is above you in the company tree, so their logins are not yours to manage. Ask the Super Admin.')
  }
}

export interface LoginSeed {
  email: string
  /** A role key of this company, already checked by the caller. */
  role: string
  organizationId: string
  invitedByUserId: string
  /** The person the login belongs to; null for an operator with no employee record. */
  employeeId: string | null
}

export interface CreatedLogin {
  membershipId: string
  inviteToken: string
  expiresAt: Date
}

/**
 * Creates a User, a Membership and an invitation token INSIDE a caller's
 * transaction.
 *
 * The one implementation behind POST /users/invite, POST /employees and the
 * roster import — it used to be written out three times. Having the employee
 * endpoint call inviteUser() instead would open a second transaction inside the
 * first, and a failure after that point would leave the login created and the
 * employee rolled back. One transaction, one outcome.
 *
 * The raw token is made here and returned once; only its hash is stored.
 */
export async function createLoginInTransaction(tx: TxDb, seed: LoginSeed): Promise<CreatedLogin> {
  const rawToken = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_VALID_FOR_HOURS * 60 * 60 * 1000)

  const { membershipId } = await repo.createInvitedLogin(tx, {
    email: seed.email.toLowerCase().trim(),
    organizationId: seed.organizationId,
    role: seed.role,
    tokenHash: hashInviteToken(rawToken),
    expiresAt,
    createdByUserId: seed.invitedByUserId,
    employeeId: seed.employeeId,
  })

  return { membershipId, inviteToken: rawToken, expiresAt }
}

/**
 * Takes back an invitation nobody has used — a login added with a mistyped
 * address, or for the wrong person. It is deleted, not switched off: it never
 * signed anybody in, and leaving it would hold its role, so the right login
 * could not be added. Once somebody has set a password, a login is switched
 * off instead, and its history stays.
 */
export async function withdrawInvitation(ctx: AppContext, membershipId: string): Promise<void> {
  const target = await repo.findMembership(ctx.db, membershipId)
  if (!target) throw NotFound('User not found')

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const current = await repo.findMembershipForChange(tx, membershipId)
    if (!current) throw NotFound('User not found')
    const { actor, next: targetRole, order, roles } = await rolesForGrant(tx, ctx, current.role, ['user:invite'])
    await assertTargetInReach(tx, ctx, actor, membershipId)
    if (!mayManage(actor, targetRole, order)) {
      throw Forbidden('You can withdraw an invitation only for a role below yours.')
    }
    await assertOtherLoginsBelow(tx, ctx, actor, order, roles, current)
    if (current.status !== 'invited' || (await repo.hasPassword(tx, target.userId))) {
      throw Conflict('This login has been used, so it cannot be withdrawn. Turn it off instead.')
    }
    await repo.deleteUnusedLogin(tx, membershipId, target.userId)
    await audit(ctx, {
      action: 'user.invite_withdrawn',
      entityType: 'membership',
      entityId: membershipId,
      details: {
        email: target.email,
        role: current.role,
        roleName: target.roleName,
        ...(current.employeeId ? { employeeId: current.employeeId } : {}),
      },
    }, tx)
  })

  logger.info('Invitation withdrawn', { by: ctx.userId, membershipId })
}

export interface PasswordLinkResult {
  membership: repo.MembershipRow
  token: string
  expiresAt: Date
  purpose: 'invite' | 'reset'
}

/**
 * A new link for somebody: their invitation again, or a password reset.
 *
 * Which one depends on where the account stands. Still `invited` — the first
 * link expired, or was lost — and this is that invitation again. Already
 * `active` and it is a reset, the only way back in after a forgotten password
 * while there is no email to send one by.
 *
 * A reset link is a key to somebody else's account: whoever holds it can set
 * the password and sign in as them. So the same rule as handing out roles
 * applies — only for an account whose role is below your own — and the log
 * records who issued it. Their current sessions are NOT ended here, only when
 * the link is used; otherwise issuing a link would sign somebody out whether or
 * not they ever needed it.
 */
export async function issuePasswordLink(
  ctx: AppContext,
  membershipId: string,
): Promise<PasswordLinkResult> {
  const target = await repo.findMembership(ctx.db, membershipId)
  if (!target) throw NotFound('User not found')

  if (target.id === ctx.membershipId) {
    throw BadRequest('Use Change password to change your own password.')
  }

  const token = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_VALID_FOR_HOURS * 60 * 60 * 1000)

  // A reset link is a key to somebody's account; who handed one out is on record.
  const purpose = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const current = await repo.findMembershipForChange(tx, membershipId)
    if (!current) throw NotFound('User not found')
    const { actor, next: targetRole, order, roles } = await rolesForGrant(tx, ctx, current.role, ['user:invite'])
    // Reach first: somebody outside it is not found, whatever their status —
    // a 409 would tell that the login exists and is switched off.
    await assertTargetInReach(tx, ctx, actor, membershipId)
    if (!mayManage(actor, targetRole, order)) {
      throw Forbidden('You can issue a link only for people whose role is below yours.')
    }
    // A key to a senior's employee login is a key to the senior (Day 23).
    await assertOtherLoginsBelow(tx, ctx, actor, order, roles, current)
    // Their status as it stands under the lock, not as first read.
    if (current.status === 'inactive') {
      throw Conflict('This account is deactivated. Reactivate it before issuing a link.')
    }
    const purpose: 'invite' | 'reset' = current.status === 'invited' ? 'invite' : 'reset'
    await repo.replacePasswordLink(tx, {
      userId: target.userId,
      tokenHash: hashInviteToken(token),
      expiresAt,
      purpose,
      createdByUserId: ctx.userId,
    })
    await audit(ctx, {
      action: 'user.password_link_issued',
      entityType: 'membership',
      entityId: target.id,
      details: { purpose, email: target.email },
    }, tx)
    return purpose
  })

  logger.warn('Password link issued', {
    by: ctx.userId,
    forUserId: target.userId,
    purpose,
    organizationId: ctx.organizationId,
  })

  return { membership: target, token, expiresAt, purpose }
}
