import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit'
import type { Request, Response } from 'express'
import { env } from '../../config/env'

/**
 * Rate limits for the auth routes.
 *
 * Built on Day 5 rather than at the end, because a login endpoint with no limit is
 * an open invitation from the moment it is reachable, and "we will add it at
 * the end" is how it ends up shipped without one.
 *
 * The design problem here is that everyone in the client's office arrives from
 * ONE IP address. A naive "ten attempts per IP" would mean the eleventh person
 * to sign in on Monday morning is locked out — and the obvious fix, raising the
 * limit, is also what makes it useless against an attacker. So there are two
 * limits doing two different jobs:
 *
 *   per identifier   Ten tries at ONE account. This is the one that actually
 *                    stops password guessing, and a shared office IP does not
 *                    affect it, because colleagues are not all signing in as
 *                    each other.
 *   per IP           Generous, and aimed at a different attack: spraying one
 *                    common password across many accounts, which never trips
 *                    the per-identifier limit because each account is tried
 *                    only once.
 */

const WINDOW_MS = 15 * 60 * 1000

/** The envelope from A8, so a 429 looks like every other error to the client. */
function limitHandler(_req: Request, res: Response): void {
  res.status(429).json({
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many attempts. Please wait a few minutes and try again.',
      requestId: res.locals.requestId,
    },
  })
}

/**
 * One builder for all three, exported so a test can construct a limiter with a
 * limit of two and actually exercise it. The production limiters below skip
 * under NODE_ENV=test — without that, a suite doing a dozen logins would trip
 * its own defences — which would otherwise leave this middleware with no
 * coverage at all.
 */
export function createLimiter(options: { limit: number; keyGenerator: Options['keyGenerator']; skip?: boolean }) {
  return rateLimit({
    windowMs: WINDOW_MS,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: limitHandler,
    limit: options.limit,
    keyGenerator: options.keyGenerator,
    skip: () => (options.skip ?? true) && env.NODE_ENV === 'test',
  })
}

/**
 * ipKeyGenerator normalises IPv6 to a /64 block. Without it, an attacker with
 * an IPv6 range gets a fresh budget from every address they own, which is
 * effectively no limit at all.
 */
function identifierKey(req: Request): string {
  const body = req.body as { identifier?: unknown } | undefined
  const identifier =
    typeof body?.identifier === 'string' ? body.identifier.toLowerCase().trim() : '(none)'
  return `${ipKeyGenerator(req.ip ?? '')}:${identifier}`
}

/** Ten attempts at one account per quarter hour. */
export const loginLimiter = createLimiter({ limit: 10, keyGenerator: identifierKey })

/** The spray guard. Loose enough that a whole office never notices it. */
export const authIpLimiter = createLimiter({
  limit: 100,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
})

/**
 * Refreshes are frequent and legitimate — one on every page load and one every
 * fifteen minutes per open tab, and a whole office arrives from one IP — so
 * this is high. It exists to stop a loop, which makes hundreds a second, not a
 * busy morning.
 */
export const refreshLimiter = createLimiter({
  limit: 1000,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
})

/**
 * Password links. A token is 256 bits, so guessing one is not the threat —
 * this keeps a script from hammering the endpoint regardless.
 */
export const passwordLinkLimiter = createLimiter({
  limit: 20,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
})
