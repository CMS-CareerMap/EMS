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

/**
 * What each scope reaches at the least, wherever its holder sits: the scopes
 * it covers. Team and department are different groups, so neither covers the
 * other; a department can hold somebody's seniors, so "the company except
 * seniors" does not cover it. Everybody under somebody is never above them —
 * the tree cannot loop — so it covers both team scopes.
 */
const COVERS: Readonly<Record<DataScope, readonly DataScope[]>> = {
  SELF: ['SELF'],
  DIRECT_REPORTS: ['SELF', 'DIRECT_REPORTS'],
  ALL_REPORTS: ['SELF', 'DIRECT_REPORTS', 'ALL_REPORTS'],
  DEPARTMENT: ['SELF', 'DEPARTMENT'],
  ORGANIZATION_EXCEPT_ABOVE: ['SELF', 'DIRECT_REPORTS', 'ALL_REPORTS', 'ORGANIZATION_EXCEPT_ABOVE'],
  ORGANIZATION: ['SELF', 'DIRECT_REPORTS', 'ALL_REPORTS', 'DEPARTMENT', 'ORGANIZATION_EXCEPT_ABOVE', 'ORGANIZATION'],
}

/** Does scope `wide` reach every row `narrow` does, wherever the holder sits? */
export function scopeCovers(wide: DataScope, narrow: DataScope): boolean {
  return COVERS[wide].includes(narrow)
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
 *
 * The role goes to SOMEBODY ELSE, so a scope measured from its holder — their
 * team, everybody under them, their department, the company except their
 * seniors — reaches from where THAT person sits, not from the actor's place.
 * "The company except seniors" given by an HR head to a new joiner with nobody
 * above them would reach the HR head's own seniors. So such a scope is
 * covered only by the whole company; "only their own" is always covered.
 * (`scopeCovers` is for one holder's two scopes, where the place is the same.)
 */
export function grantsMoreThan(candidate: RoleGrant, actor: RoleGrant): boolean {
  for (const permission of candidate.permissions) {
    if (!actor.permissions.has(permission)) return true
    const resource = resourceOf(permission)
    if (!resource) continue
    const theirs = candidate.scopes[resource]
    if (theirs !== 'SELF' && actor.scopes[resource] !== 'ORGANIZATION') return true
  }
  return false
}
