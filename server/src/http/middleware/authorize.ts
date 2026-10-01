import type { RequestHandler } from 'express'
import { Forbidden } from '../../platform/errors/AppError'
import { logger } from '../../platform/logger'
import type { Permission } from '../../platform/authz/permissions'
import { authContext } from '../context'
import { recordSecurityEvent } from '../../modules/audit/audit.service'

/**
 * Gate a route on one permission.
 *
 *   router.post('/employees', authenticate, authorize('employee:create'), postEmployee)
 *
 * Always AFTER authenticate — there is no context to read otherwise, and the
 * 401 you would get instead of a 403 would be confusing rather than wrong.
 *
 * This is the second of the four layers in guide §A7, and on its own it is not
 * enough. It answers "may this person create employees at all", not "may they
 * edit THIS one" — that is the data scope, applied in the repository. A route
 * guarded here and unscoped there is still an IDOR hole.
 *
 * The refusal is logged. An employee hitting /payroll once is a mistyped URL;
 * the same employee hitting it forty times in a minute is something else, and
 * neither is visible without a record.
 */
export function authorize(permission: Permission | readonly Permission[]): RequestHandler {
  // Several: any one of them is enough — the catalogue of salary components is
  // needed both by payroll staff and by HR entering an incentive.
  const wanted: readonly Permission[] = Array.isArray(permission) ? permission : [permission as Permission]

  return async (req, res, next) => {
    const ctx = authContext(res)

    if (!wanted.some((p) => ctx.can(p))) {
      logger.warn('Permission denied', {
        userId: ctx.userId,
        role: ctx.role,
        permission,
        path: req.originalUrl,
      })
      // Kept by the company as well as the log (guide, Day 20): who tried to
      // reach what they may not.
      await recordSecurityEvent({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        actorRoleName: ctx.roleName,
        action: 'permission.denied',
        details: { permission, method: req.method, path: req.originalUrl, role: ctx.role, roleName: ctx.roleName },
        requestId: ctx.requestId,
      })
      throw Forbidden('You do not have permission to do that')
    }

    next()
  }
}
