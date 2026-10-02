import type { Permission } from './authz/permissions'
import type { ScopedResource, ScopeContext } from './authz/scope'
import type { RoleGrant } from './authz/grant'
import type { ScopedDb } from './db/scoped'

/**
 * Everything a service needs to know about the caller, in one object.
 *
 * It lives in `platform/` rather than in `http/` because of the dependency
 * direction: http → modules → domain, never the reverse. A service that
 * imported the request context from http would invert that, and the first
 * consequence would be a service that cannot be called from a CLI script or a
 * scheduled job because it wants an Express response object.
 *
 * `db` is already scoped to the caller's organization. A service never builds
 * its own client and never sees the raw one, so there is no way to widen the
 * company filter from inside a module.
 */
export interface AppContext {
  userId: string
  organizationId: string
  membershipId: string
  /**
   * The key of the caller's role — for the audit log and for logging. Never
   * for a decision: since Day 21 roles are whatever the Super Admin makes them,
   * and a name says nothing about what a role may do. Ask `can()`.
   */
  role: string
  /** The role as it reads on screen, e.g. "Reporting Manager". */
  roleName: string
  /** What the role allows, read from its row on this very request. */
  grant: RoleGrant
  /** The caller's own Employee row, when they have one. Null for an operator. */
  employeeId: string | null
  /**
   * Signed in with their employee login while they also have a live role
   * login (Day 23): their own things only. The company tree's decisions —
   * their team's leave — are made from the role login.
   */
  selfServiceOnly: boolean

  /** Never compare roles. Ask this. */
  can(permission: Permission): boolean
  /** Whose rows the caller may touch for a given resource. */
  scopeFor(resource: ScopedResource): ScopeContext

  /** Prisma, already confined to this organization. */
  db: ScopedDb

  /** The request this is happening in — what ties an audit row to its log lines. */
  requestId?: string | undefined
}
