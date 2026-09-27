import type { Request, RequestHandler } from 'express'
import { login } from '../../modules/auth/auth.service'
import {
  refreshSession,
  logout,
  changePassword,
  type SessionMeta,
} from '../../modules/auth/session.service'
import { findIdentityByUserId } from '../../modules/auth/auth.repository'
import { Unauthorized } from '../../platform/errors/AppError'
import {
  loginSchema,
  changePasswordSchema,
  inspectLinkSchema,
  redeemLinkSchema,
} from '../validators/auth.validator'
import { inspectLink, redeemLink } from '../../modules/auth/invite.service'
import { parseBody } from '../validators/parse'
import { setRefreshCookie, clearRefreshCookie, REFRESH_COOKIE } from '../cookies'
import { serializeSessionUser } from '../serializers/session.serializer'
import { authContext } from '../context'
import { isoInstant } from '../../domain/shared/dates'

/**
 * The rule that governs every handler in this file: the refresh token goes into
 * the cookie and NOWHERE ELSE. Not the body, not a log, not a redirect. The
 * moment it appears in a response body it is readable by JavaScript, and
 * httpOnly has bought nothing.
 *
 * No try/catch anywhere. Services throw AppError, Express 5 forwards it, and
 * errorHandler is the only place a status code is set.
 */

function metaFrom(req: Request): SessionMeta {
  return { userAgent: req.get('user-agent'), ip: req.ip }
}

/** POST /api/auth/login */
export const postLogin: RequestHandler = async (req, res) => {
  const input = parseBody(loginSchema, req.body)
  const session = await login(input, metaFrom(req))

  setRefreshCookie(res, session.refreshToken)

  res.status(200).json({
    data: {
      accessToken: session.accessToken,
      user: serializeSessionUser(session.identity),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/**
 * POST /api/auth/refresh
 *
 * Authenticated by the cookie alone, which is why csrfGuard sits in front of it.
 */
export const postRefresh: RequestHandler = async (req, res) => {
  const raw = (req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE]

  if (!raw) {
    throw Unauthorized('Your session has expired. Please sign in again.')
  }

  try {
    const session = await refreshSession(raw, metaFrom(req))

    setRefreshCookie(res, session.refreshToken)

    res.status(200).json({
      data: {
        accessToken: session.accessToken,
        user: serializeSessionUser(session.identity),
      },
      meta: { requestId: res.locals.requestId },
    })
  } catch (err) {
    // The one catch in the file, and it re-throws. Its only job is to make sure
    // a browser holding a dead token stops sending it — otherwise the client
    // retries the same bad cookie on every page load forever.
    clearRefreshCookie(res)
    throw err
  }
}

/**
 * POST /api/auth/logout
 *
 * Always 204, even with no cookie or a token that was already revoked. Someone
 * who clicks sign out must end up signed out; telling them their logout failed
 * would be both useless and alarming.
 */
export const postLogout: RequestHandler = async (req, res) => {
  const raw = (req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE]

  await logout(raw)
  clearRefreshCookie(res)

  res.status(204).end()
}

/**
 * GET /api/auth/session
 *
 * Read on page load, so the app knows who it is showing before it renders.
 * Deliberately re-reads the database rather than decoding the access token: a
 * role changed a minute ago should be visible on the next reload, not in
 * fifteen minutes.
 *
 * Day 6 adds `permissions` here, once platform/authz/roles.ts exists. The
 * frontend's can() reads that list; it must never infer permissions from the
 * role name.
 */
export const getSession: RequestHandler = async (_req, res) => {
  const ctx = authContext(res)

  const identity = await findIdentityByUserId(ctx.userId)
  if (!identity || identity.status !== 'active') {
    throw Unauthorized('Your session has ended. Please sign in again.')
  }

  res.status(200).json({
    data: { user: serializeSessionUser(identity) },
    meta: { requestId: res.locals.requestId },
  })
}

/**
 * POST /api/auth/change-password
 *
 * Ends every other session and hands this one a new pair, so the person who
 * made the change stays signed in and everybody else is thrown out.
 */
export const postChangePassword: RequestHandler = async (req, res) => {
  const ctx = authContext(res)
  const input = parseBody(changePasswordSchema, req.body)

  const session = await changePassword(
    ctx.userId,
    input.currentPassword,
    input.newPassword,
    metaFrom(req),
  )

  setRefreshCookie(res, session.refreshToken)

  res.status(200).json({
    data: {
      accessToken: session.accessToken,
      user: serializeSessionUser(session.identity),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/**
 * POST /api/auth/password-link/inspect
 *
 * What a link is for, before anybody chooses a password. POST rather than GET
 * so the token travels in a body — a query string lands in access logs.
 */
export const postInspectLink: RequestHandler = async (req, res) => {
  const { token } = parseBody(inspectLinkSchema, req.body)
  const link = await inspectLink(token)

  res.status(200).json({
    data: {
      email: link.email,
      purpose: link.purpose,
      expires_at: isoInstant(link.expiresAt),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/**
 * POST /api/auth/password-link/redeem
 *
 * Sets the password and spends the link. Does NOT sign the person in: the next
 * screen asks for the password they just chose, which is the first time anyone
 * finds out whether they typed what they meant to.
 */
export const postRedeemLink: RequestHandler = async (req, res) => {
  const { token, password } = parseBody(redeemLinkSchema, req.body)
  const result = await redeemLink(token, password)

  res.status(200).json({
    data: { email: result.email, purpose: result.purpose },
    meta: { requestId: res.locals.requestId },
  })
}
