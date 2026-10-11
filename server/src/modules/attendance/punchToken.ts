import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env'
import { Forbidden } from '../../platform/errors/AppError'

/**
 * The start token of a punch (client, 11 Oct 2026).
 *
 * Pressing Check In or Check Out first asks the server for this: a short-lived,
 * signed note of who is punching, which way, and when they started. The punch
 * must bring it back within two minutes, for the same login, the same person
 * and the same way. So a request recorded on one day cannot be sent again on
 * another. (When the readings themselves were taken is the phone's word — its
 * clock — which the "old reading" flag holds against the server's.) Nothing is
 * stored: the signature is the proof.
 */

export type PunchAction = 'in' | 'out'

/** How long a started punch may take: the location burst is ~10 s; two minutes is generous. */
export const PUNCH_TOKEN_SECONDS = 120

/** A punch token from a server whose clock runs a little ahead is still fine. */
const CLOCK_SLACK_MS = 5_000

interface Payload {
  /** The login. */
  u: string
  /** The employee. */
  e: string
  a: PunchAction
  /** Issued at, ms since 1970, the server's clock. */
  t: number
  /** Random, so two tokens are never the same. */
  n: string
}

/** Its own key, derived from the access-token secret, so no new secret has to be set up. */
function key(): Buffer {
  return createHmac('sha256', env.JWT_ACCESS_SECRET).update('ems-punch-token-v1').digest()
}

function sign(body: string): string {
  return createHmac('sha256', key()).update(body).digest('base64url')
}

export function issuePunchToken(who: { userId: string; employeeId: string }, action: PunchAction, now = Date.now()): string {
  const payload: Payload = { u: who.userId, e: who.employeeId, a: action, t: now, n: randomBytes(9).toString('base64url') }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body)}`
}

/** When the punch began (the server's clock), for the evidence. Refuses a token that is not this punch's. */
export function verifyPunchToken(token: string | undefined, who: { userId: string; employeeId: string }, action: PunchAction, now = Date.now()): Date {
  const refuse = () => Forbidden(`This ${action === 'in' ? 'check-in' : 'check-out'} was not started properly or took too long. Press the button again.`)
  if (!token) throw refuse()
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra !== undefined) throw refuse()

  const expected = Buffer.from(sign(body))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw refuse()

  let payload: Payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload
  } catch {
    throw refuse()
  }
  const age = now - payload.t
  if (
    payload.u !== who.userId ||
    payload.e !== who.employeeId ||
    payload.a !== action ||
    typeof payload.t !== 'number' ||
    age < -CLOCK_SLACK_MS ||
    age > PUNCH_TOKEN_SECONDS * 1000
  ) {
    throw refuse()
  }
  return new Date(payload.t)
}
