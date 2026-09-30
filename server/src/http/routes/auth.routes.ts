import { Router } from 'express'
import {
  postLogin,
  postRefresh,
  postLogout,
  getSession,
  postChangePassword,
  postInspectLink,
  postRedeemLink,
} from '../controllers/auth.controller'
import { authenticate } from '../middleware/authenticate'
import { csrfGuard } from '../middleware/csrfGuard'
import {
  loginLimiter,
  authIpLimiter,
  refreshLimiter,
  passwordLinkLimiter,
} from '../middleware/rateLimit'

/**
 * Mounted at /api/auth, which is also the refresh cookie's Path — so this
 * router is the only part of the API that ever receives that cookie.
 *
 * Three ways in, and each route uses exactly one:
 *
 *   login             nothing; it is how you get a token
 *   password-link     the link's own token, in the body — whoever holds it
 *                     is not signed in yet
 *   refresh, logout   the cookie, so both need csrfGuard
 *   session, change   the Authorization header, so neither does
 */
export const authRouter = Router()

// The spray guard sits on the routes where a password or a link token is
// tried, and only there. It used to cover the whole router, so the refresh
// every page load makes counted against it too: an office sharing one IP
// could run out by mid-morning without a single wrong password. Refresh,
// logout and session answer to a cookie or a token that cannot be guessed,
// and refresh keeps its own loop guard.
authRouter.post('/login', authIpLimiter, loginLimiter, postLogin)

authRouter.post('/refresh', refreshLimiter, csrfGuard, postRefresh)
authRouter.post('/logout', csrfGuard, postLogout)

authRouter.get('/session', authenticate, getSession)
// Checks the current password, so it is a place to guess one.
authRouter.post('/change-password', authIpLimiter, authenticate, postChangePassword)

authRouter.post('/password-link/inspect', authIpLimiter, passwordLinkLimiter, postInspectLink)
authRouter.post('/password-link/redeem', authIpLimiter, passwordLinkLimiter, postRedeemLink)
