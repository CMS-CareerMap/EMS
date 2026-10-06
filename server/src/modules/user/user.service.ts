import type { AppContext } from '../../platform/context'
import { AppError, BadRequest, Conflict, Forbidden, NotFound, ValidationFailed } from '../../platform/errors/AppError'
import type { ScopedDb } from '../../platform/db/scoped'
import { hashPassword, passwordProblem } from '../../platform/auth/password'
import { EMPLOYEE_ROLE } from '../../platform/authz/defaultRoles'
import {
  loginKind,
  maySetPasswordFor,
  passwordSetBy,
  passwordSetterName,
  type LoginKind,
  type PasswordRules,
} from '../../domain/org/passwords'
import { tellPasswordChanged } from '../auth/passwordNotice'
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
import { settleLeaveAfter } from '../leave/leaveApproval.service'

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
  /** Optional only for an employee login made with an employee record: it signs in with the Employee ID. */
  email?: string | null | undefined
  /** A role key of this company. */
  role: string
  fullName?: string | undefined
  employeeCode?: string | undefined
  /** Typed for them, when the company sets this kind of login's password (Settings → Passwords). */
  password?: string | undefined
}

export interface InviteResult {
  membership: repo.MembershipRow
  /**
   * The raw invitation token, returned ONCE and never stored — when the login
   * starts with a link, because the person sets their own password. Null when
   * a password was typed for them, or it waits for one.
   *
   * There is no email infrastructure yet, so the administrator copies this to
   * the new joiner themselves. That is deliberate rather than a gap papered
   * over: a "we sent you an email" message that sends nothing is worse than
   * asking someone to paste a link, because nobody finds out for a week.
   */
  inviteToken: string | null
  expiresAt: Date | null
}

/**
 * Creates a login for someone who does not have one.
 *
 * Whose password it is decides how it starts (Settings → Passwords): typed for
 * them, a single-use link that expires, or none yet — never a default
 * credential or a shared welcome password, and an invitation forwarded twice
 * still only works once.
 */
export async function inviteUser(ctx: AppContext, input: InviteInput): Promise<InviteResult> {
  const email = input.email ? input.email.toLowerCase().trim() : null

  if (email && (await repo.findMembershipByEmail(ctx.db, email))) {
    throw Conflict('Someone with that email address already has access to this company')
  }
  const { hash } = await preparedPassword(ctx.db, ctx.organizationId, input.password)

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
    const kind = loginKind(input.role, EMPLOYEE_ROLE, given.locked)
    assertLoginEmail(kind, email, Boolean(input.employeeCode))
    // The rules as they stand under the lock a change of them takes too.
    const start = loginStartFor(kind, await repo.passwordRules(tx, ctx.organizationId), actor, hash !== null)

    const employee = input.employeeCode
      ? await employeeRepo.createEmployee(tx, {
          organizationId: ctx.organizationId,
          employeeCode: await freeEmployeeCode(tx, ctx.organizationId, input.employeeCode),
          fullName: input.fullName?.trim() || email || input.employeeCode.trim(),
        })
      : null

    const created = await createLoginInTransaction(tx, {
      email,
      role: input.role,
      organizationId: ctx.organizationId,
      invitedByUserId: ctx.userId,
      employeeId: employee?.id ?? null,
      start,
      passwordHash: hash,
    })

    await audit(ctx, {
      action: 'user.invited',
      entityType: 'membership',
      entityId: created.membershipId,
      details: { email, role: input.role, roleName: given.grant.name, withEmployeeRecord: Boolean(input.employeeCode), start },
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
    // Only now, for a change that is the caller's to make: a role login signs
    // in by its own email (client, 6 Oct 2026), so a login with none stays an
    // employee login, signing in by the Employee ID.
    if (!target.user.email && loginKind(newRole, EMPLOYEE_ROLE, next.locked) !== 'employee') {
      throw BadRequest('This login has no email, so it can only be an employee login. Give them a role login of its own, with an email, on their page.')
    }
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
        // Read under those months' payroll locks, after the person's leave
        // lock (settling their leave takes it too): a month being approved is
        // waited for, then kept as it was paid.
        if (earlier) await lockFor(tx, `leave-apply:${current.employeeId}`)
        if (earlier && !(await isOpenFrom(ctx, addCalendarDays(earlier, 1), tx))) {
          lastDay = before
          payrollClosed = true
        }
      }
      await lifecycleRepo.updatePerson(tx, current.employeeId, {
        status: 'inactive',
        archivedAt: new Date(),
        lastWorkingDate: lastDay ? toDateColumn(lastDay) : null,
      })
      // No leave is taken from a job they have left.
      await settleLeaveAfter(ctx, tx, current.employeeId, lastDay)
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
  /** Optional for an employee login: it signs in with the Employee ID. */
  email?: string | null | undefined
  /** A role key of this company, different from every login the person has. */
  role: string
  /** Typed for them, when the company sets this kind of login's password (Settings → Passwords). */
  password?: string | undefined
}

/**
 * Gives somebody already here a login (Day 23): their employee login, or a role
 * login beside it, with its own email and its own password. Never a new person:
 * it is the same employee record, the same place in the company tree, and every
 * rule about "your own" applies to both logins alike.
 *
 * A role login is the Super Admin's to give (role:manage): a second way into
 * the system for somebody is a decision about the company's roles. An employee
 * login is also HR's (client, 6 Oct 2026; user:password:set) — for somebody
 * within their reach, never themselves, nor anybody whose other login, or
 * place in the company tree, is above them.
 */
export async function addLogin(ctx: AppContext, employeeId: string, input: AddLoginInput): Promise<InviteResult> {
  const email = input.email ? input.email.toLowerCase().trim() : null
  const { hash } = await preparedPassword(ctx.db, ctx.organizationId, input.password)

  const login = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const needs: readonly Permission[] = input.role === EMPLOYEE_ROLE ? ['role:manage', 'user:password:set'] : ['role:manage']
    const { actor, next: given, order, roles } = await rolesForGrant(tx, ctx, input.role, needs)
    if (!mayGive(actor, given, order)) throw Forbidden(REFUSAL_MESSAGES.not_below)

    const person = await repo.personForLogin(tx, employeeId)
    if (!person) throw NotFound('Employee not found')
    // Somebody without the Super Admin panel gives an employee login only to
    // somebody they could act on: within reach, not themselves, nobody senior.
    if (!actor.grant.permissions.has('role:manage')) {
      if (ctx.employeeId === person.id) throw Forbidden('Not your own: ask the Super Admin to give you a login.')
      const scope = { ...ctx.scopeFor('employee'), scope: actor.grant.scopes.employee }
      if (scope.scope !== 'ORGANIZATION' && !isInScope(scope, { id: person.id, reportingManagerId: person.reportingManagerId, departmentId: person.departmentId })) {
        throw NotFound('Employee not found')
      }
      await assertOtherLoginsBelow(tx, ctx, actor, order, roles, { id: '', employeeId: person.id })
    }
    if (person.archivedAt) throw BadRequest(`${person.fullName} has left the company.`)
    if (person.memberships.some((m) => m.role === input.role)) {
      throw Conflict(`${person.fullName} already has a ${given.grant.name} login. Choose a different role for this one.`)
    }
    const kind = loginKind(input.role, EMPLOYEE_ROLE, given.locked)
    assertLoginEmail(kind, email, true)
    // Asked only now, for somebody the caller may act on: no probing addresses from a narrow reach.
    if (email && (await repo.findMembershipByEmail(tx, email))) {
      throw Conflict('Someone with that email address already has access to this company. Each login needs an email of its own.')
    }
    // The rules as they stand under the lock a change of them takes too.
    const start = loginStartFor(kind, await repo.passwordRules(tx, ctx.organizationId), actor, hash !== null)

    const created = await createLoginInTransaction(tx, {
      email,
      role: input.role,
      organizationId: ctx.organizationId,
      invitedByUserId: ctx.userId,
      employeeId: person.id,
      start,
      passwordHash: hash,
    })
    await audit(ctx, {
      action: 'user.login_added',
      entityType: 'membership',
      entityId: created.membershipId,
      details: { employeeId: person.id, email, role: input.role, roleName: given.grant.name, logins: person.memberships.length + 1, start },
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

// ─── Passwords set by the company (client, 6 Oct 2026) ─────────────────────

/**
 * A password typed for somebody, checked against the company's rule and hashed
 * — before any lock is taken, as hashing is deliberately slow. No password, no
 * hash; the rules either way, for deciding how a login starts.
 */
export async function preparedPassword(
  db: ScopedDb | TxDb,
  organizationId: string,
  password: string | undefined,
): Promise<{ rules: PasswordRules; hash: string | null }> {
  const rules = await repo.passwordRules(db, organizationId)
  if (password === undefined) return { rules, hash: null }
  const problem = passwordProblem(password, rules.passwordMinLength)
  if (problem) throw ValidationFailed(problem, [{ field: 'password', message: problem }])
  return { rules, hash: await hashPassword(password) }
}

/** How a new login starts: a password typed for them, a link to set their own, or neither yet. */
export type LoginStart = 'password' | 'link' | 'none'

/**
 * How a new login starts, by whose password it is (Settings → Passwords) and
 * who is making it. The person's own: an invitation link. The company's: the
 * password typed for them, by somebody who may set it — or, left out, none
 * yet, so the login waits for HR or the Super Admin to set it.
 */
export function loginStartFor(kind: LoginKind, rules: PasswordRules, actor: PolicyRole, passwordGiven: boolean): LoginStart {
  if (passwordSetBy(kind, rules) === 'self') {
    if (passwordGiven) {
      throw BadRequest(kind === 'employee'
        ? 'At this company employees set their own password, from a link. Leave the password out.'
        : 'The holder of this login sets its password, from a link. Leave the password out.')
    }
    return 'link'
  }
  if (!passwordGiven) return 'none'
  if (!maySetPasswordFor(kind, { locked: actor.locked, holds: actor.grant.permissions.has('user:password:set') })) {
    throw Forbidden(kind === 'employee'
      ? 'You cannot set passwords. Leave it out: HR or the Super Admin sets it.'
      : 'Only the Super Admin sets the password of a role login. Leave it out: the login waits for the Super Admin.')
  }
  return 'password'
}

/**
 * A role login — and any login with no person behind it — needs an email to
 * sign in with. An employee login can sign in with the person's Employee ID.
 */
export function assertLoginEmail(kind: LoginKind, email: string | null, hasEmployeeRecord: boolean): void {
  if (email) return
  if (kind !== 'employee') {
    throw ValidationFailed('A role login needs an email of its own.', [{ field: 'email', message: 'A role login needs an email of its own' }])
  }
  if (!hasEmployeeRecord) {
    throw ValidationFailed('A login with no employee record needs an email to sign in with.', [{ field: 'email', message: 'Needed to sign in: there is no Employee ID' }])
  }
}

/**
 * An Employee ID nobody else has, whatever the letters' case — signing in by
 * it matches either case, so "cms7" beside "CMS7" would be two people behind
 * one ID. A person who has left keeps theirs, as the database does.
 *
 * Checked under a lock on the ID in small letters, held until the caller's
 * transaction ends: two people added at once as "cms7" and "CMS7" wait for
 * each other, and the second sees the first. The refusal names nobody — whose
 * the ID is may be outside the caller's reach.
 */
export async function freeEmployeeCode(db: TxDb, organizationId: string, code: string, exceptEmployeeId?: string): Promise<string> {
  const wanted = code.trim()
  await lockFor(db, employeeCodeLock(organizationId, wanted))
  const clash = await employeeRepo.employeeWithCodeLike(db, wanted, exceptEmployeeId)
  if (!clash) return wanted
  throw Conflict(
    clash.employeeCode === wanted
      ? `Employee ID ${wanted} is already in use.`
      : `Employee ID ${wanted} is already in use in other letters (${clash.employeeCode}): two IDs that differ only in capitals would sign in to one person.`,
  )
}

/** The lock an Employee ID is taken under, the same in any letters. */
export const employeeCodeLock = (organizationId: string, code: string) => `employee-code:${organizationId}:${code.trim().toLowerCase()}`

export interface LoginSeed {
  /** Null for an employee login with no email: it signs in with the Employee ID. */
  email: string | null
  /** A role key of this company, already checked by the caller. */
  role: string
  organizationId: string
  invitedByUserId: string
  /** The person the login belongs to; null for an operator with no employee record. */
  employeeId: string | null
  start: LoginStart
  /** The hash of the password typed for them — needed when `start` is 'password'. */
  passwordHash: string | null
}

export interface CreatedLogin {
  membershipId: string
  inviteToken: string | null
  expiresAt: Date | null
}

/**
 * Creates a User and a Membership — with the password typed for them, an
 * invitation token, or neither yet — INSIDE a caller's transaction.
 *
 * The one implementation behind POST /users/invite, POST /employees, giving
 * somebody a login and the roster import — it used to be written out three
 * times. Having the employee endpoint call inviteUser() instead would open a
 * second transaction inside the first, and a failure after that point would
 * leave the login created and the employee rolled back. One transaction, one
 * outcome.
 *
 * A raw token is made here and returned once; only its hash is stored.
 */
export async function createLoginInTransaction(tx: TxDb, seed: LoginSeed): Promise<CreatedLogin> {
  if (seed.start === 'password' && !seed.passwordHash) throw new Error('A login started with a password needs its hash')
  const link = seed.start === 'link'
    ? { rawToken: generateToken(), expiresAt: new Date(Date.now() + INVITE_VALID_FOR_HOURS * 60 * 60 * 1000) }
    : null

  try {
    const { membershipId } = await repo.createLogin(tx, {
      email: seed.email ? seed.email.toLowerCase().trim() : null,
      organizationId: seed.organizationId,
      role: seed.role,
      employeeId: seed.employeeId,
      passwordHash: seed.start === 'password' ? seed.passwordHash : null,
      link: link ? { tokenHash: hashInviteToken(link.rawToken), expiresAt: link.expiresAt, createdByUserId: seed.invitedByUserId } : null,
    })
    return { membershipId, inviteToken: link?.rawToken ?? null, expiresAt: link?.expiresAt ?? null }
  } catch (err) {
    if (err instanceof repo.LoginEmailTaken) throw Conflict(err.message)
    throw err
  }
}

/**
 * Sets somebody's password for them (client, 6 Oct 2026): HR an employee
 * login's, the Super Admin anybody's whose password the company sets. Never
 * the login one is signed in with — My Profile is for that, where the company
 * lets one — nor one's other login, except a Super Admin's: their passwords
 * are all their own, and nobody else could set the one beside theirs. Nor a
 * login whose role is not below the caller's, nor any login of somebody whose
 * other login, or place in the company tree, is above them (Day 23). Nor a
 * login whose owner sets their own (Settings → Passwords): they get a link.
 * Everything signed in with the old password is signed out, and the person is
 * told.
 *
 * The password is checked only once the login is known to be within reach —
 * a short one for somebody out of reach is "not found", like anything else
 * asked about them — but hashed before the lock, as hashing is slow.
 */
export async function setPassword(ctx: AppContext, membershipId: string, password: string): Promise<repo.MembershipRow> {
  const target = await repo.findMembership(ctx.db, membershipId)
  if (!target) throw NotFound('User not found')
  if (target.id === ctx.membershipId) {
    throw BadRequest(ctx.can('role:manage')
      ? 'This is the login you are signed in with: change its password on My Profile.'
      : 'This is your own login. Ask the Super Admin to set its password.')
  }
  const prepared = await preparedPassword(ctx.db, ctx.organizationId, password)
    .then((p) => ({ hash: p.hash, refusal: null }), (err: unknown) => ({ hash: null, refusal: err }))

  const { by, own, sessionsEnded } = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const current = await repo.findMembershipForChange(tx, membershipId)
    if (!current) throw NotFound('User not found')
    const { actor, next: targetRole, order, roles } = await rolesForGrant(tx, ctx, current.role, ['user:password:set'])
    // Reach first: somebody outside it is not found, whatever else is true.
    await assertTargetInReach(tx, ctx, actor, membershipId)
    if (prepared.refusal) throw prepared.refusal
    const own = ctx.employeeId !== null && current.employeeId === ctx.employeeId
    if (own && !actor.locked) {
      throw Forbidden('This is your own login. Ask the Super Admin to set its password.')
    }
    const kind = loginKind(current.role, EMPLOYEE_ROLE, targetRole.locked)
    if (!maySetPasswordFor(kind, { locked: actor.locked, holds: true })) {
      throw Forbidden('Only the Super Admin sets the password of a role login.')
    }
    if (!mayManage(actor, targetRole, order)) {
      throw Forbidden('You can set a password only for people whose role is below yours.')
    }
    // A key to a senior's employee login is a key to the senior (Day 23).
    await assertOtherLoginsBelow(tx, ctx, actor, order, roles, current)
    if (current.status === 'inactive') {
      throw Conflict('This login is turned off. Turn it on before setting its password.')
    }
    // Whose password it is, once the login is known to be the caller's to act
    // on — read under the lock a change of the rules takes too. A person
    // holding the Super Admin panel owns every one of theirs.
    if (!own) {
      const holdsSuperAdmin = current.employeeId !== null &&
        (await repo.loginsOfPerson(tx, current.employeeId)).some((l) => l.status === 'active' && roles.get(l.role)?.locked === true)
      if (passwordSetBy(kind, await repo.passwordRules(tx, ctx.organizationId), { holdsSuperAdmin }) === 'self') {
        throw Conflict(kind === 'super_admin' || holdsSuperAdmin
          ? 'A Super Admin sets their own passwords, on every login of theirs — their employee login from their own page. If they have forgotten their Super Admin password, send them a password link.'
          : 'At this company they set their own password (Settings → Passwords). Send them a password link instead.')
      }
    }
    const result = await repo.setPasswordFor(tx, { userId: target.userId, passwordHash: prepared.hash!, now: new Date() })
    await audit(ctx, {
      action: 'user.password_set',
      entityType: 'membership',
      entityId: target.id,
      details: {
        role: current.role,
        roleName: targetRole.grant.name,
        email: target.email,
        firstPassword: result.activated,
        sessionsEnded: result.sessionsEnded,
      },
    }, tx)
    return { by: actor.locked ? 'the Super Admin' : actor.grant.name, own, sessionsEnded: result.sessionsEnded }
  })

  // A Super Admin's own other login: told as their own change, not as somebody setting it for them.
  await tellPasswordChanged(ctx.organizationId, target.userId, own ? { how: 'changed' } : { how: 'set', by })
  logger.warn('Password set for somebody', { by: ctx.userId, forUserId: target.userId, sessionsEnded, organizationId: ctx.organizationId })

  const after = await repo.findMembership(ctx.db, membershipId)
  if (!after) throw NotFound('User not found')
  return after
}

/** The company's password rules, for Settings → Users & Roles → Passwords. */
export async function getPasswordRules(ctx: AppContext): Promise<PasswordRules> {
  return repo.passwordRules(ctx.db, ctx.organizationId)
}

/**
 * Changes the password rules. A rule made stricter does not touch passwords
 * already set — they are checked when next changed — and switching a kind of
 * login to "set by the company" spends the links still out for it, for good:
 * switched back, a link handed out before must not start working again.
 */
export async function updatePasswordRules(ctx: AppContext, rules: PasswordRules): Promise<PasswordRules> {
  await withTransaction(ctx.db, async (tx) => {
    // The lock every login start, link and password set takes: none of them
    // reads the rules half-changed, and no link is made after its kind's were spent.
    await lockFor(tx, rolesLock(ctx.organizationId))
    const before = await repo.passwordRules(tx, ctx.organizationId)
    await repo.updatePasswordRules(tx, ctx.organizationId, rules)
    const now = new Date()
    let linksSpent = 0
    if (before.employeePasswords === 'self' && rules.employeePasswords === 'company') {
      linksSpent += await repo.spendLinksOfKind(tx, { organizationId: ctx.organizationId, kind: 'employee', employeeRole: EMPLOYEE_ROLE, now })
    }
    if (before.rolePasswords === 'self' && rules.rolePasswords === 'company') {
      linksSpent += await repo.spendLinksOfKind(tx, { organizationId: ctx.organizationId, kind: 'role', employeeRole: EMPLOYEE_ROLE, now })
    }
    await audit(ctx, {
      action: 'user.password_rules_updated',
      entityType: 'organization',
      entityId: ctx.organizationId,
      details: { ...rules, before: { ...before }, linksSpent },
    }, tx)
  })
  return repo.passwordRules(ctx.db, ctx.organizationId)
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
    // A password the company sets is never the person's to choose from a link
    // (Settings → Passwords): it is set for them instead.
    const kind = loginKind(current.role, EMPLOYEE_ROLE, targetRole.locked)
    if (passwordSetBy(kind, await repo.passwordRules(tx, ctx.organizationId)) === 'company') {
      // The other login of a Super Admin is theirs to set, from their own page.
      const holdsSuperAdmin = current.employeeId !== null &&
        (await repo.loginsOfPerson(tx, current.employeeId)).some((l) => l.status === 'active' && roles.get(l.role)?.locked === true)
      throw Conflict(holdsSuperAdmin
        ? 'A Super Admin sets the password of this login themselves, from their own page.'
        : `At this company ${passwordSetterName(kind)} sets this login’s password: use Set password instead of a link.`)
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
