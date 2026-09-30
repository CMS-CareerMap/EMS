import { Unauthorized, ValidationFailed } from '../../platform/errors/AppError'
import { tellPasswordChanged } from './passwordNotice'
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  millisUntilExpiry,
} from '../../platform/auth/jwt'
import { hashRefreshToken } from '../../platform/auth/tokenHash'
import { hashPassword, verifyPassword, passwordProblem } from '../../platform/auth/password'
import { logger } from '../../platform/logger'
import { findIdentityByUserId, type AuthIdentity } from './auth.repository'
import * as sessions from './session.repository'
import { recordSecurityEvent } from '../audit/audit.service'

export interface SessionMeta {
  userAgent?: string | undefined
  ip?: string | undefined
  /** For the audit row: which request, to find its log lines. */
  requestId?: string | undefined
}

export interface IssuedSession {
  accessToken: string
  refreshToken: string
  identity: AuthIdentity
}

function accessClaimsFor(identity: AuthIdentity) {
  return {
    sub: identity.userId,
    org: identity.organizationId,
    mem: identity.membershipId,
    role: identity.role,
    ver: identity.tokenVersion,
  }
}

/**
 * Mints a pair and records the refresh half.
 *
 * Passing an existing familyId continues a chain (a rotation); omitting it
 * starts a new one (a login).
 */
export async function issueSession(
  identity: AuthIdentity,
  meta: SessionMeta,
  familyId?: string,
): Promise<IssuedSession> {
  const refresh = signRefreshToken(identity.userId, familyId)

  await sessions.storeToken({
    userId: identity.userId,
    tokenHash: hashRefreshToken(refresh.token),
    familyId: refresh.familyId,
    expiresAt: new Date(Date.now() + millisUntilExpiry(refresh.token)),
    userAgent: meta.userAgent,
    ip: meta.ip,
  })

  return {
    accessToken: signAccessToken(accessClaimsFor(identity)),
    refreshToken: refresh.token,
    identity,
  }
}

/**
 * Exchanges a refresh token for a new pair, and catches theft while doing it.
 *
 * The detection works because rotation is mandatory. Every successful refresh
 * retires the token it was given, so a token can be spent exactly once. If one
 * is presented twice, two parties are holding copies of it — the legitimate
 * user and whoever took it. There is no way to tell which one is asking now,
 * so the only safe answer is to end the whole family and make the real user log
 * in again. An attacker who steals a token therefore gets, at most, until the
 * victim's next refresh — and announces themselves in the process.
 */
export async function refreshSession(
  rawToken: string,
  meta: SessionMeta,
): Promise<IssuedSession> {
  const claims = verifyRefreshToken(rawToken)
  const stored = await sessions.findByHash(hashRefreshToken(rawToken))

  // A correctly signed token with no row means it was already cleaned up, or
  // this server's database was reset. Either way it is not a live session.
  if (!stored) {
    logger.warn('Refresh rejected', { userId: claims.sub, reason: 'unknown_token' })
    throw Unauthorized('Your session has expired. Please sign in again.')
  }

  if (stored.revokedAt) {
    const killed = await sessions.revokeFamily(stored.familyId)
    const version = await sessions.bumpTokenVersion(stored.userId)

    // Deliberately logged at error, not warn. This is not a user mistake; it
    // means a token left the browser it was issued to, and somebody should
    // look at it.
    logger.error('Refresh token reuse detected', {
      userId: stored.userId,
      familyId: stored.familyId,
      tokensRevoked: killed,
      tokenVersion: version,
      userAgent: meta.userAgent,
      ip: meta.ip,
    })

    // In the company's own record too: somebody there should know an
    // account's session was copied, and when.
    const owner = await findIdentityByUserId(stored.userId)
    if (owner) {
      await recordSecurityEvent({
        organizationId: owner.organizationId,
        actorUserId: null,
        action: 'auth.refresh_token_reused',
        entityType: 'user',
        entityId: stored.userId,
        details: { tokensRevoked: killed, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
        requestId: meta.requestId,
      })
    }

    throw Unauthorized('Your session has expired. Please sign in again.')
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    await sessions.revokeOne(stored.id)
    throw Unauthorized('Your session has expired. Please sign in again.')
  }

  // Read the identity again rather than trusting the old token's claims. A role
  // lowered or an account deactivated five minutes ago must take effect here,
  // which is the entire reason the access token is short-lived.
  const identity = await findIdentityByUserId(stored.userId)
  if (!identity || identity.status !== 'active') {
    await sessions.revokeFamily(stored.familyId)
    logger.warn('Refresh rejected', { userId: stored.userId, reason: 'not_active' })
    throw Unauthorized('Your session has expired. Please sign in again.')
  }

  const next = signRefreshToken(identity.userId, stored.familyId)

  await sessions.rotate({
    previousId: stored.id,
    next: {
      userId: identity.userId,
      tokenHash: hashRefreshToken(next.token),
      familyId: stored.familyId,
      expiresAt: new Date(Date.now() + millisUntilExpiry(next.token)),
      userAgent: meta.userAgent,
      ip: meta.ip,
    },
  })

  return {
    accessToken: signAccessToken(accessClaimsFor(identity)),
    refreshToken: next.token,
    identity,
  }
}

/**
 * Ends one session. Best effort by design: a user who clicks sign out must end
 * up signed out, so a token that is already invalid is not an error worth
 * showing them. The controller clears the cookie either way.
 */
export async function logout(rawToken: string | undefined, meta: SessionMeta): Promise<void> {
  if (!rawToken) return

  try {
    const stored = await sessions.findByHash(hashRefreshToken(rawToken))
    // A token already revoked is somebody signing out twice, not a sign-out.
    if (stored && !stored.revokedAt) {
      await sessions.revokeOne(stored.id)
      logger.info('Logged out', { userId: stored.userId })
      const owner = await findIdentityByUserId(stored.userId)
      if (owner) {
        await recordSecurityEvent({
          organizationId: owner.organizationId,
          actorUserId: stored.userId,
          actorRole: owner.role,
          action: 'auth.logged_out',
          entityType: 'user',
          entityId: stored.userId,
          details: { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
          requestId: meta.requestId,
        })
      }
    }
  } catch (err) {
    logger.warn('Logout could not revoke the token', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}


/**
 * Changes a password and ends every session it opened.
 *
 * The current password is required even though the caller is already
 * authenticated. That is what stops an unattended laptop, or a stolen access
 * token, from becoming a permanent takeover — knowing the old password is the
 * one thing an attacker in that position does not have.
 *
 * Afterwards every refresh token is revoked and tokenVersion is raised, which
 * kills outstanding ACCESS tokens too. The caller is then given a fresh
 * session, so the person who made the change stays signed in and everyone else
 * is thrown out — which is the behaviour someone changing their password after
 * a scare actually wants.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  meta: SessionMeta,
): Promise<IssuedSession> {
  const credentials = await sessions.findUserCredentials(userId)
  if (!credentials) throw Unauthorized('Not authenticated')

  const ok = await verifyPassword(currentPassword, credentials.passwordHash)
  if (!ok) {
    logger.warn('Password change refused', { userId, reason: 'wrong_current_password' })
    throw Unauthorized('Your current password is not correct')
  }

  const problem = passwordProblem(newPassword)
  if (problem) throw ValidationFailed(problem, [{ field: 'newPassword', message: problem }])

  if (newPassword === currentPassword) {
    throw ValidationFailed('Choose a password you have not used here before', [
      { field: 'newPassword', message: 'The new password must be different from the current one' },
    ])
  }

  await sessions.setPasswordHash(userId, await hashPassword(newPassword))
  const revoked = await sessions.revokeAllForUser(userId)
  const version = await sessions.bumpTokenVersion(userId)

  logger.info('Password changed', { userId, sessionsRevoked: revoked, tokenVersion: version })

  const identity = await findIdentityByUserId(userId)
  if (!identity) throw Unauthorized('Not authenticated')

  await recordSecurityEvent({
    organizationId: identity.organizationId,
    actorUserId: userId,
    actorRole: identity.role,
    action: 'auth.password_changed',
    entityType: 'user',
    entityId: userId,
    details: { sessionsEnded: revoked },
    requestId: meta.requestId,
  })

  await tellPasswordChanged(identity.organizationId, userId, 'changed')

  return issueSession(identity, meta)
}
