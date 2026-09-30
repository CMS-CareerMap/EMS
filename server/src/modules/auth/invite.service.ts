import type { PasswordTokenPurpose } from '@prisma/client'
import { BadRequest, ValidationFailed } from '../../platform/errors/AppError'
import { hashPassword, passwordProblem } from '../../platform/auth/password'
import { hashInviteToken } from '../../platform/auth/tokenHash'
import { logger } from '../../platform/logger'
import * as repo from './invite.repository'
import { findIdentityByUserId } from './auth.repository'
import { recordSecurityEvent } from '../audit/audit.service'
import { tellPasswordChanged } from './passwordNotice'

/**
 * The other half of an invitation: using it.
 *
 * Invitations were being created from the start — by the invite endpoint, by
 * creating an employee with a login, by the roster import — and each one gave
 * back a single-use link. Nothing accepted the link. So every invited person
 * was stuck at "This account has not been activated yet" for ever, and the
 * only account that could ever sign in was the one bootstrap created.
 *
 * Also the way back in after a forgotten password. There is no email in v1, so
 * self-service reset is not possible; an administrator issues a reset link and
 * hands it over, and it is redeemed here exactly like an invitation.
 */

/**
 * One message for every way a link can be dead.
 *
 * Unknown, expired and already-used are told apart in the log, never in the
 * response. Saying "this link was already used" to whoever is holding it
 * confirms it was real, and saying "expired" confirms it was issued.
 */
const DEAD_LINK = 'This link is invalid or has expired. Ask your administrator for a new one.'

export interface LinkInfo {
  email: string
  purpose: PasswordTokenPurpose
  expiresAt: Date
}

async function liveLink(token: string, now: Date) {
  const found = await repo.findLiveToken(hashInviteToken(token), now)
  if (!found) {
    logger.warn('Dead password link presented', { reason: 'unknown_used_or_expired' })
    throw BadRequest(DEAD_LINK)
  }

  // An invitation whose membership has since been deactivated is dead too.
  // Accepting it would set a password on an account that still could not sign
  // in — a success screen followed by a refusal.
  if (found.purpose === 'invite' && (await repo.countInvitedMemberships(found.userId)) === 0) {
    logger.warn('Dead password link presented', { userId: found.userId, reason: 'no_invited_membership' })
    throw BadRequest(DEAD_LINK)
  }

  return found
}

/**
 * What a link is for, before anybody types a password into it.
 *
 * So the page can say "Set a password for asha@company.in" — or say the link is
 * dead — instead of letting somebody choose a password and only then telling
 * them it was for nothing.
 */
export async function inspectLink(token: string, now = new Date()): Promise<LinkInfo> {
  const found = await liveLink(token, now)
  return { email: found.user.email, purpose: found.purpose, expiresAt: found.expiresAt }
}

export async function redeemLink(
  token: string,
  password: string,
  meta: { requestId?: string | undefined } = {},
  now = new Date(),
): Promise<{ email: string; purpose: PasswordTokenPurpose }> {
  const found = await liveLink(token, now)

  // Checked BEFORE the link is spent. A password that fails the policy must
  // leave the link usable, or one typo would cost the person their invitation.
  const problem = passwordProblem(password)
  if (problem) throw ValidationFailed(problem, [{ field: 'password', message: problem }])

  const result = await repo.redeem({
    tokenId: found.id,
    userId: found.userId,
    purpose: found.purpose,
    passwordHash: await hashPassword(password),
    now,
  })

  if (!result) {
    // Spent by a second submission in the moment between the check and here.
    logger.warn('Dead password link presented', { userId: found.userId, reason: 'lost_race' })
    throw BadRequest(DEAD_LINK)
  }

  logger.info('Password link redeemed', {
    userId: found.userId,
    purpose: found.purpose,
    membershipsActivated: result.activated,
  })

  const owner = await findIdentityByUserId(found.userId)
  if (owner) {
    await recordSecurityEvent({
      organizationId: owner.organizationId,
      actorUserId: found.userId,
      action: 'auth.password_link_used',
      entityType: 'user',
      entityId: found.userId,
      details: { purpose: found.purpose, membershipsActivated: result.activated },
      requestId: meta.requestId,
    })
    // A reset changes a password somebody already had: the same security
    // notice as changing it while signed in. A first password is not a change.
    if (found.purpose === 'reset') await tellPasswordChanged(owner.organizationId, found.userId, 'reset')
  }

  return { email: found.user.email, purpose: found.purpose }
}
