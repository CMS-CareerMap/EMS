import type { RequestHandler } from 'express'
import { Unauthorized } from '../../platform/errors/AppError'
import { verifyAccessToken } from '../../platform/auth/jwt'
import { findAuthState, findTreePlace } from '../../modules/auth/session.repository'
import { TREE_SCOPES } from '../../platform/authz/scope'
import { setAuthContext } from '../context'

/**
 * Establishes who is calling, from the Authorization header.
 *
 * The signature check alone is not enough. A signed token stays
 * cryptographically valid until it expires, so terminating someone, or their
 * password being changed after a theft, would have no effect for up to fifteen
 * minutes. The tokenVersion comparison closes that window: the version is
 * raised on termination, password change and refresh-token reuse, and any token
 * carrying an older one dies at its very next request.
 *
 * THE ROLE COMES FROM THE DATABASE, NOT FROM THE TOKEN. The token carries a
 * role claim, but it is used only for logging, never for a decision. Trusting
 * it would mean a demotion took fifteen minutes to bite — and the fifteen
 * minutes right after someone is demoted is exactly when it matters. Since the
 * tokenVersion check already costs one read, the current role comes back in the
 * same query and costs nothing extra.
 *
 * That read is a deliberate trade. A stateless check would be marginally faster
 * and would make instant revocation impossible, which for a payroll system is
 * the wrong side of the bargain.
 */
export const authenticate: RequestHandler = async (req, res, next) => {
  const header = req.get('authorization')

  if (!header?.startsWith('Bearer ')) {
    throw Unauthorized('Not authenticated')
  }

  const claims = verifyAccessToken(header.slice('Bearer '.length).trim())

  const state = await findAuthState(claims.mem)
  if (!state) throw Unauthorized('Not authenticated')

  if (state.tokenVersion !== claims.ver) {
    throw Unauthorized('Your session has ended. Please sign in again.')
  }

  // Deactivated while holding a live token.
  if (state.status !== 'active') {
    throw Unauthorized('This account is no longer active.')
  }

  // A role whose scopes follow the company tree (Day 22) needs the caller's
  // place in it; the rest never pay for the read.
  const followsTree = Object.values(state.grant.scopes).some((scope) => TREE_SCOPES.has(scope))
  const tree = followsTree ? await findTreePlace(claims.org, state.employeeId) : undefined

  setAuthContext(res, {
    userId: state.userId,
    organizationId: claims.org,
    membershipId: claims.mem,
    grant: state.grant,
    employeeId: state.employeeId,
    departmentId: state.departmentId,
    selfServiceOnly: state.selfServiceOnly,
    tree,
  })

  next()
}
