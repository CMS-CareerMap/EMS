import { isPermission, type Permission } from './permissions'
import { isDataScope, SCOPED_RESOURCES, type DataScope, type ScopedResource } from './scope'
import { resourceOf } from './catalogue'

/**
 * A role as the server applies it: what its holders may do and whose rows they
 * reach. Built from the Role row on every request (authenticate.ts reads it in
 * the same query as the session check), so an edit on the Roles screen applies
 * to the very next request, without anybody signing in again.
 *
 * Reading is FAIL-CLOSED. A permission name the code does not know is dropped,
 * and a module with no valid scope stored is the holder's own rows only. A
 * stored value the code cannot read must never come out wider than intended.
 */
export interface RoleGrant {
  key: string
  name: string
  permissions: ReadonlySet<Permission>
  scopes: Readonly<Record<ScopedResource, DataScope>>
}

/** The parts of a Role row a grant is made from. */
export interface RoleRowForGrant {
  key: string
  name: string
  permissions: readonly string[]
  scopes: unknown
}

export function readScopes(raw: unknown): Record<ScopedResource, DataScope> {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const result = {} as Record<ScopedResource, DataScope>
  for (const resource of SCOPED_RESOURCES) {
    const value = stored[resource]
    result[resource] = isDataScope(value) ? value : 'SELF'
  }
  return result
}

/**
 * The scopes that mean something for these permissions: a module the role
 * holds no permission over other people's rows in reaches only the holder's
 * own. A scope left at "Whole company" on a role whose leave permissions were
 * all unticked must not go on reaching the company's leave anywhere — the
 * dashboard, a notice, a comparison of what two roles may do.
 */
export function effectiveScopes(permissions: Iterable<Permission>, scopes: Record<ScopedResource, DataScope>): Record<ScopedResource, DataScope> {
  const reached = new Set<ScopedResource>()
  for (const permission of permissions) {
    const resource = resourceOf(permission)
    if (resource) reached.add(resource)
  }
  const result = {} as Record<ScopedResource, DataScope>
  for (const resource of SCOPED_RESOURCES) result[resource] = reached.has(resource) ? scopes[resource] : 'SELF'
  return result
}

export function toGrant(row: RoleRowForGrant): RoleGrant {
  const permissions = new Set(row.permissions.filter(isPermission))
  return {
    key: row.key,
    name: row.name,
    permissions,
    scopes: effectiveScopes(permissions, readScopes(row.scopes)),
  }
}

/** Does scope `wide` reach every row `narrow` does? TEAM and DEPARTMENT are different groups, so neither covers the other. */
export function scopeCovers(wide: DataScope, narrow: DataScope): boolean {
  if (wide === narrow || wide === 'ORGANIZATION' || narrow === 'SELF') return true
  return false
}

/**
 * Would giving `candidate` hand out something `actor` does not have?
 *
 * Either a permission the actor lacks, or one the actor holds but over more
 * people than the actor reaches — a manager who sees their team's leave must
 * not be able to give a role that approves the whole company's.
 *
 * Compared on the actual permissions and scopes, not on where the roles sit in
 * the order: the order is what the Super Admin chose, this is what the roles
 * really do. user.policy applies both.
 */
export function grantsMoreThan(candidate: RoleGrant, actor: RoleGrant): boolean {
  for (const permission of candidate.permissions) {
    if (!actor.permissions.has(permission)) return true
    const resource = resourceOf(permission)
    if (resource && !scopeCovers(actor.scopes[resource], candidate.scopes[resource])) return true
  }
  return false
}
