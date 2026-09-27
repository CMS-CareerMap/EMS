import type { Response } from 'express'
import type { Role } from '@prisma/client'
import { Unauthorized } from '../platform/errors/AppError'
import { roleCan } from '../platform/authz/roles'
import { scopeFor } from '../platform/authz/scope'
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
  role: Role
  employeeId: string | null
}

export function setAuthContext(res: Response, input: AuthContextInput): void {
  const ctx: AppContext = {
    ...input,
    can: (permission) => roleCan(input.role, permission),
    scopeFor: (resource) => ({
      scope: scopeFor(input.role, resource),
      employeeId: input.employeeId,
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
