import type { Response } from 'express'
import { Unauthorized } from '../platform/errors/AppError'
import type { RoleGrant } from '../platform/authz/grant'
import { forOrg } from '../platform/db/scoped'
import type { AppContext } from '../platform/context'

/**
 * Builds the AppContext for a request and hands it back to controllers.
 *
 * Stored on res.locals rather than bolted onto req, and read back through
 * appContext() rather than accessed directly, so a controller cannot quietly
 * proceed with `undefined` when the middleware was forgotten. An exception is
 * the right outcome there; `undefined` where an organizationId belongs is how
 * data crosses between companies.
 *
 * The scoped Prisma client is built ONCE here, from the organization on the
 * verified token. No service constructs one, so none can choose a different
 * organization than the one the caller is authenticated for.
 */
export interface AuthContextInput {
  userId: string
  organizationId: string
  membershipId: string
  /** The caller's role, read from its row on this request (findAuthState). */
  grant: RoleGrant
  employeeId: string | null
  departmentId: string | null
}

export function setAuthContext(res: Response, input: AuthContextInput): void {
  const { grant } = input
  const ctx: AppContext = {
    userId: input.userId,
    organizationId: input.organizationId,
    membershipId: input.membershipId,
    role: grant.key,
    roleName: grant.name,
    grant,
    employeeId: input.employeeId,
    can: (permission) => grant.permissions.has(permission),
    scopeFor: (resource) => ({
      scope: grant.scopes[resource],
      employeeId: input.employeeId,
      departmentId: input.departmentId,
    }),
    db: forOrg(input.organizationId),
    requestId: res.locals.requestId as string | undefined,
  }
  res.locals.auth = ctx
}

export function appContext(res: Response): AppContext {
  const ctx = res.locals.auth as AppContext | undefined
  if (!ctx) throw Unauthorized('Not authenticated')
  return ctx
}

/** Kept for the auth routes written on Day 5, which predate AppContext. */
export const authContext = appContext
