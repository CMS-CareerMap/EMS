import { Unauthorized } from '../../platform/errors/AppError'
import { verifyPassword } from '../../platform/auth/password'
import { logger } from '../../platform/logger'
import { issueSession, type IssuedSession, type SessionMeta } from './session.service'
import { recordSecurityEvent } from '../audit/audit.service'
import {
  findIdentityByEmail,
  findIdentityByEmployeeCode,
  type AuthIdentity,
} from './auth.repository'

export interface LoginInput {
  /// Email address or employee code. The user is not asked which.
  identifier: string
  password: string
}

/** Anything with an @ is treated as an email. Employee codes never contain one. */
function looksLikeEmail(identifier: string): boolean {
  return identifier.includes('@')
}

async function resolveIdentity(identifier: string): Promise<AuthIdentity | null> {
  return looksLikeEmail(identifier)
    ? findIdentityByEmail(identifier)
    : findIdentityByEmployeeCode(identifier)
}

export async function login(input: LoginInput, meta: SessionMeta): Promise<IssuedSession> {
  const identity = await resolveIdentity(input.identifier)

  // Verify unconditionally. When there is no such user we still spend the
  // ~250ms bcrypt costs, because a fast rejection and a slow one are
  // distinguishable over the network — and that difference is a free list of
  // which email addresses have accounts.
  const passwordOk = await verifyPassword(input.password, identity?.passwordHash ?? null)

  if (!identity || !passwordOk) {
    logger.warn('Login failed', { identifier: input.identifier, reason: 'bad_credentials' })
    // Recorded against the company only when the account is real: a wrong
    // password on somebody's account is theirs to know about. An address that
    // matches nobody has no company to belong to, and stays in the log.
    if (identity) {
      await recordSecurityEvent({
        organizationId: identity.organizationId,
        actorUserId: null,
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: identity.userId,
        details: { reason: 'wrong_password', ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
        requestId: meta.requestId,
      })
    }
    throw Unauthorized('Incorrect email or password')
  }

  // Only past this line do we know the caller actually owns this account. That
  // is what makes a specific message safe here: an attacker without the
  // password never reaches it, and a real suspended employee deserves to be
  // told why they cannot get in rather than doubting their own password.
  if (identity.status !== 'active') {
    logger.warn('Login blocked', {
      userId: identity.userId,
      reason: identity.status === 'invited' ? 'not_activated' : 'inactive',
    })
    await recordSecurityEvent({
      organizationId: identity.organizationId,
      actorUserId: null,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: identity.userId,
      details: {
        reason: identity.status === 'invited' ? 'not_activated' : 'inactive',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
      requestId: meta.requestId,
    })
    throw Unauthorized(
      identity.status === 'invited'
        ? 'This account has not been activated yet. Use the invitation link sent to you.'
        : 'This account is not active. Contact your administrator.',
    )
  }

  logger.info('Login succeeded', {
    userId: identity.userId,
    organizationId: identity.organizationId,
    role: identity.role,
  })
  await recordSecurityEvent({
    organizationId: identity.organizationId,
    actorUserId: identity.userId,
    action: 'auth.login_succeeded',
    entityType: 'user',
    entityId: identity.userId,
    details: { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
    requestId: meta.requestId,
  })

  // No familyId: a login always starts a fresh chain, which is what makes a
  // token from an older chain detectable as reuse.
  return issueSession(identity, meta)
}
