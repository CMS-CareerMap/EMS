import type { Role } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { generateToken, hashInviteToken } from '../../platform/auth/tokenHash'
import { logger } from '../../platform/logger'
import {
  refuseRoleChange,
  refuseAccountChange,
  grantsMoreThan,
  REFUSAL_MESSAGES,
  ACCOUNT_REFUSAL_MESSAGES,
} from './user.policy'
import * as repo from './user.repository'
import * as employeeRepo from '../employee/employee.repository'

/**
 * The four things the Supabase edge functions used to do, and nothing else
 * replaced: invite, change role, change status, terminate.
 *
 * Every one of them is a transaction, because every one of them touches more
 * than one table and a half-applied change here is an account in an impossible
 * state — access revoked but role unchanged, or an employee record with no
 * login pointing at it.
 */

const INVITE_VALID_FOR_HOURS = 72

export async function listUsers(ctx: AppContext): Promise<repo.MembershipRow[]> {
  return repo.listMemberships(ctx.db)
}

export interface InviteInput {
  email: string
  role: Role
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

  // The policy applies to invitations too: an inviter cannot hand out a role
  // they do not hold, or they could invite a super_admin and then sign in as
  // them. Reused rather than re-written, so the rule cannot drift.
  if (grantsMoreThan(input.role, ctx.role)) {
    throw Forbidden(REFUSAL_MESSAGES.broader_than_actor)
  }

  const login = await withTransaction(ctx.db, async (tx) => {
    const created = await createLoginInTransaction(tx, {
      email,
      role: input.role,
      organizationId: ctx.organizationId,
      invitedByUserId: ctx.userId,
    })

    if (input.employeeCode) {
      await employeeRepo.createEmployee(tx, {
        organizationId: ctx.organizationId,
        membershipId: created.membershipId,
        employeeCode: input.employeeCode.trim(),
        fullName: input.fullName?.trim() || email,
      })
    }

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
  newRole: Role,
): Promise<repo.MembershipRow> {
  await withTransaction(ctx.db, async (tx) => {
    const target = await repo.findMembershipForChange(tx, membershipId)
    if (!target) throw NotFound('User not found')

    const activeSuperAdminCount = await repo.countActiveSuperAdmins(tx)

    const refusal = refuseRoleChange({
      actorMembershipId: ctx.membershipId,
      actorRole: ctx.role,
      targetMembershipId: target.id,
      targetCurrentRole: target.role,
      newRole,
      activeSuperAdminCount,
    })

    if (refusal) throw Forbidden(REFUSAL_MESSAGES[refusal])

    await repo.setRole(tx, membershipId, newRole)
  })

  // A role change must take effect NOW, not in fifteen minutes. The middleware
  // reads the role from the database on every request, but their access token
  // still carries the old tokenVersion — bumping it forces a refresh, which
  // rebuilds the session and the permission list the UI draws from.
  const updated = await repo.findMembership(ctx.db, membershipId)
  if (!updated) throw NotFound('User not found')
  await repo.revokeSessions(updated.userId)

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

  if (status === 'inactive') {
    const refusal = refuseAccountChange({
      actorMembershipId: ctx.membershipId,
      targetMembershipId: membershipId,
      targetRole: target.role,
      activeSuperAdminCount: await repo.countActiveSuperAdmins(ctx.db),
    })
    if (refusal) throw Forbidden(ACCOUNT_REFUSAL_MESSAGES[refusal])
  }

  await repo.setStatus(ctx.db, membershipId, status)

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
 */
export async function terminateUser(ctx: AppContext, membershipId: string): Promise<void> {
  const target = await repo.findMembership(ctx.db, membershipId)
  if (!target) throw NotFound('User not found')

  const refusal = refuseAccountChange({
    actorMembershipId: ctx.membershipId,
    targetMembershipId: membershipId,
    targetRole: target.role,
    activeSuperAdminCount: await repo.countActiveSuperAdmins(ctx.db),
  })
  if (refusal) throw Forbidden(ACCOUNT_REFUSAL_MESSAGES[refusal])

  await withTransaction(ctx.db, async (tx) => {
    await repo.setStatus(tx, membershipId, 'inactive')
    if (target.employeeId) await employeeRepo.archiveEmployee(tx, target.employeeId, new Date())
  })

  await repo.revokeSessions(target.userId)

  logger.info('User terminated', {
    by: ctx.userId,
    membershipId,
    employeeArchived: Boolean(target.employeeId),
  })
}

/** Guards against a caller passing a role string the enum does not contain. */
export function assertAssignableRole(role: string): asserts role is Role {
  const assignable: string[] = ['super_admin', 'admin', 'hr', 'manager', 'rm', 'accounts', 'employee']
  if (!assignable.includes(role)) throw BadRequest('That is not a role')
}

export interface LoginSeed {
  email: string
  role: Role
  organizationId: string
  invitedByUserId: string
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
  })

  return { membershipId, inviteToken: rawToken, expiresAt }
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
 * applies — not for an account with more access than your own — and the log
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

  if (target.status === 'inactive') {
    throw Conflict('This account is deactivated. Reactivate it before issuing a link.')
  }

  if (grantsMoreThan(target.role, ctx.role)) {
    throw Forbidden('You cannot issue a link for an account with more access than your own.')
  }

  const purpose = target.status === 'invited' ? 'invite' : 'reset'
  const token = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_VALID_FOR_HOURS * 60 * 60 * 1000)

  await repo.replacePasswordLink(ctx.db, {
    userId: target.userId,
    tokenHash: hashInviteToken(token),
    expiresAt,
    purpose,
    createdByUserId: ctx.userId,
  })

  logger.warn('Password link issued', {
    by: ctx.userId,
    forUserId: target.userId,
    purpose,
    organizationId: ctx.organizationId,
  })

  return { membership: target, token, expiresAt, purpose }
}
