import { isPermission, RETIRED, SUPER_ADMIN_ONLY, type Permission } from '../../platform/authz/permissions'
import { isDataScope, SCOPED_RESOURCES, type DataScope, type ScopedResource } from '../../platform/authz/scope'
import { missingRequirements, permissionLabel, RESOURCE_LABELS, SCOPE_LABELS, scopesFor } from '../../platform/authz/catalogue'
import { wouldLoop, type RoleNode } from '../../platform/authz/roleOrder'
import { effectiveScopes } from '../../platform/authz/grant'

/**
 * What the Roles & Permissions screen may save (Day 21), as pure functions —
 * every rule here is tested without a database.
 *
 * The rules, in the client's words: the Super Admin role cannot be edited or
 * removed; nobody edits a role they hold; a role somebody still holds cannot
 * be deleted; a warning when one role could both prepare and approve the
 * payroll. And underneath, what keeps a role coherent: every permission is a
 * real one, none is the Super Admin's alone, each comes with what it needs to
 * work, and the order of roles never loops.
 */

export interface RoleInput {
  name: string
  description: string
  /** The role this one comes under. */
  parentKey: string
  permissions: string[]
  scopes: Record<string, unknown>
}

/** A role as the rules see the others, for name clashes and the order. */
export interface ExistingRole {
  key: string
  name: string
}

export interface CleanRole {
  name: string
  description: string
  parentKey: string
  permissions: Permission[]
  scopes: Record<ScopedResource, DataScope>
}

export type RoleInputResult = { ok: true; role: CleanRole; warnings: string[] } | { ok: false; message: string }

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} &/().,'-]*$/u

/**
 * Checks a role as it is to be saved, and returns it cleaned — permissions
 * de-duplicated in a stable order, every module given a scope.
 *
 * `key` is the role's own key when it is being edited, null when it is new.
 */
export function checkRoleInput(
  input: RoleInput,
  key: string | null,
  others: readonly ExistingRole[],
  order: ReadonlyMap<string, RoleNode>,
): RoleInputResult {
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (name.length < 2 || name.length > 40) return { ok: false, message: 'Give the role a name of 2 to 40 characters.' }
  if (!NAME.test(name)) return { ok: false, message: 'A role name can use letters, numbers, spaces and & / ( ) . , \' -' }
  const clash = others.find((r) => r.key !== key && r.name.toLocaleLowerCase('en-IN') === name.toLocaleLowerCase('en-IN'))
  if (clash) return { ok: false, message: `There is already a role called “${clash.name}”.` }

  const description = input.description.trim()
  if (description.length > 200) return { ok: false, message: 'Keep the description to 200 characters.' }

  if (!order.has(input.parentKey)) return { ok: false, message: 'Choose which role this one comes under.' }
  if (key && wouldLoop(key, input.parentKey, order)) {
    return { ok: false, message: 'A role cannot come under itself, or under a role that comes under it.' }
  }

  const permissions: Permission[] = []
  for (const raw of input.permissions) {
    if (!isPermission(raw)) return { ok: false, message: 'One of the ticked permissions is not one EMS knows. Reload the page and try again.' }
    // One nothing checks any more: dropped, not refused — a role that still lists it saves.
    if (RETIRED.has(raw)) continue
    if (SUPER_ADMIN_ONLY.has(raw)) return { ok: false, message: `“${permissionLabel(raw)}” stays with the Super Admin and cannot be given to another role.` }
    if (!permissions.includes(raw)) permissions.push(raw)
  }
  const missing = missingRequirements(new Set(permissions))[0]
  if (missing) {
    return { ok: false, message: `“${permissionLabel(missing.permission)}” needs “${permissionLabel(missing.needs)}” ticked too.` }
  }

  const scopes = {} as Record<ScopedResource, DataScope>
  for (const resource of SCOPED_RESOURCES) {
    const value = input.scopes[resource]
    if (value !== undefined && !isDataScope(value)) {
      return { ok: false, message: `Choose whose ${RESOURCE_LABELS[resource].toLowerCase()} the role reaches.` }
    }
    const scope = value ?? 'SELF'
    // A choice the module cannot honour would be a promise the screen breaks.
    if (!scopesFor(resource).includes(scope)) {
      return {
        ok: false,
        message: `For ${RESOURCE_LABELS[resource].toLowerCase()}, choose ${scopesFor(resource).map((s) => `“${SCOPE_LABELS[s]}”`).join(' or ')}.`,
      }
    }
    scopes[resource] = scope
  }
  for (const resource of Object.keys(input.scopes)) {
    if (!(SCOPED_RESOURCES as readonly string[]).includes(resource)) {
      return { ok: false, message: 'One of the choices of whose information the role reaches is not one EMS knows. Reload the page and try again.' }
    }
  }

  // Saved as it will be applied: a module with no permission reaching others'
  // rows is stored as "Only their own", so the screen never shows a reach the
  // role does not have.
  return {
    ok: true,
    role: { name, description, parentKey: input.parentKey, permissions, scopes: effectiveScopes(permissions, scopes) },
    warnings: warningsFor(permissions),
  }
}

/** Not refusals: things the Super Admin should see before saving, and may save anyway. */
export function warningsFor(permissions: readonly Permission[]): string[] {
  const warnings: string[] = []
  if (permissions.includes('payroll:run:create') && permissions.includes('payroll:run:approve')) {
    warnings.push(
      'This role can both prepare and approve the payroll, so one person could pay out a payroll nobody else has checked. Usually Accounts prepares it and the Super Admin approves it.',
    )
  }
  if (permissions.includes('audit:read')) {
    warnings.push(
      'The audit log shows everything that happened in EMS, for the whole company: every salary change with its amount, and who opened whose documents. Give it only to somebody trusted with all of that.',
    )
  }
  return warnings
}

export type RoleChangeRefusal = 'locked' | 'own_role' | 'built_in' | 'in_use' | 'has_children'

export const ROLE_REFUSALS: Record<RoleChangeRefusal, string> = {
  locked: 'The Super Admin role cannot be changed or deleted.',
  own_role: 'You cannot change a role you hold yourself. Ask another Super Admin.',
  built_in: 'This is one of the roles EMS starts with. It can be changed or reset, but not deleted.',
  in_use: 'Somebody still holds this role. Give them another role first.',
  has_children: 'Other roles come under this one. Move them under another role first.',
}

/** May this role be edited, or reset, by somebody holding `actorRole`? */
export function refuseEdit(role: { key: string; locked: boolean }, actorRole: string): RoleChangeRefusal | null {
  if (role.locked) return 'locked'
  if (role.key === actorRole) return 'own_role'
  return null
}

/** May this role be deleted? */
export function refuseDelete(
  role: { key: string; locked: boolean; builtIn: boolean },
  actorRole: string,
  holders: number,
  children: number,
): RoleChangeRefusal | null {
  const edit = refuseEdit(role, actorRole)
  if (edit) return edit
  if (role.builtIn) return 'built_in'
  if (holders > 0) return 'in_use'
  if (children > 0) return 'has_children'
  return null
}

/**
 * A key for a new role, from its name: lower case, words joined by `_`, unique
 * in the company. Made once and never changed, whatever the role is renamed to.
 */
export function keyFor(name: string, taken: ReadonlySet<string>): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30)
  const stem = /^[a-z]/.test(base) && base.length >= 2 ? base : `role_${base}`.slice(0, 30)
  if (!taken.has(stem)) return stem
  for (let n = 2; ; n++) {
    const candidate = `${stem}_${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Whose information a role reaches, in words, for the modules where it reaches
 * anybody but the holder — "Leave: Their team". What a role was given at the
 * start, or had when it was deleted, so the log holds the whole of it.
 */
export function reachOf(permissions: readonly Permission[], scopes: Record<ScopedResource, DataScope>): string[] {
  const effective = effectiveScopes(permissions, scopes)
  return SCOPED_RESOURCES.filter((r) => effective[r] !== 'SELF').map((r) => `${RESOURCE_LABELS[r]}: ${SCOPE_LABELS[effective[r]]}`)
}

/**
 * What changed, in the words the screen used — for the audit log, which is in
 * the domain and cannot look a permission's label up itself.
 */
export function describeChange(
  before: { permissions: readonly string[]; scopes: Record<ScopedResource, DataScope> },
  after: { permissions: readonly string[]; scopes: Record<ScopedResource, DataScope> },
) {
  const had = new Set(before.permissions)
  const has = new Set(after.permissions)
  return {
    added: after.permissions.filter((p) => !had.has(p)).map(permissionLabel),
    removed: before.permissions.filter((p) => !has.has(p)).map(permissionLabel),
    scopeChanges: SCOPED_RESOURCES.filter((r) => before.scopes[r] !== after.scopes[r]).map(
      (r) => `${RESOURCE_LABELS[r]}: ${SCOPE_LABELS[before.scopes[r]]} → ${SCOPE_LABELS[after.scopes[r]]}`,
    ),
  }
}
