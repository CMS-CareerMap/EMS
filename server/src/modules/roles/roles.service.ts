import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { effectiveScopes, readScopes, toGrant } from '../../platform/authz/grant'
import { wouldLoop } from '../../platform/authz/roleOrder'
import { defaultRole } from '../../platform/authz/defaultRoles'
import { PERMISSION_MODULES, SCOPE_HINTS, SCOPE_LABELS, permissionLabel } from '../../platform/authz/catalogue'
import { DATA_SCOPES } from '../../platform/authz/scope'
import { audit } from '../audit/audit.service'
import { mayGive } from '../user/user.policy'
import { rolesLock } from '../user/user.service'
import * as repo from './roles.repository'
import {
  checkRoleInput,
  describeChange,
  keyFor,
  reachOf,
  refuseDelete,
  refuseEdit,
  ROLE_REFUSALS,
  type CleanRole,
  type RoleInput,
} from './roles.policy'

/**
 * Settings → Roles & Permissions (Day 21): the Super Admin creates roles and
 * decides what each one may do and whose information it reaches.
 *
 * Every change runs under the same lock as handing roles out (user.service),
 * so a role cannot change shape in the instant somebody is being given it.
 * Every change is written to the audit log in the screen's own words.
 *
 * A change applies to the people holding the role at their very next request
 * — the server reads the role on every one. Their access tokens are also
 * ended (not their sessions): the browser trades its refresh cookie for a new
 * token at once, and gets the new list of what it may show with it.
 */

export interface RoleView {
  key: string
  name: string
  description: string
  parentKey: string | null
  builtIn: boolean
  locked: boolean
  permissions: string[]
  scopes: ReturnType<typeof readScopes>
  holders: number
  /** The `updatedAt` an edit must quote back, so two tabs cannot overwrite each other. */
  version: string
  /** Whether this role is the caller's own — which nobody may edit. */
  own: boolean
  /** Built-in only: whether it differs from how EMS started it. */
  changedFromDefault: boolean
}

function viewOf(row: repo.RoleRecord, order: Map<string, { parentKey: string | null }>, ctx: AppContext): RoleView {
  // The scopes as they apply — what the editor shows and what a save keeps.
  const scopes = toGrant(row).scopes
  const base = defaultRole(row.key)
  const baseScopes = base ? effectiveScopes(base.permissions, { ...base.scopes }) : null
  const changed = row.builtIn && base && baseScopes
    ? base.name !== row.name ||
      base.description !== row.description ||
      base.parentKey !== (order.get(row.key)?.parentKey ?? null) ||
      [...base.permissions].sort().join() !== [...row.permissions].sort().join() ||
      Object.entries(baseScopes).some(([r, s]) => scopes[r as keyof typeof scopes] !== s)
    : false
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    parentKey: order.get(row.key)?.parentKey ?? null,
    builtIn: row.builtIn,
    locked: row.locked,
    permissions: row.permissions,
    scopes,
    holders: row._count.memberships,
    version: String(row.updatedAt.getTime()),
    own: row.key === ctx.role,
    changedFromDefault: changed,
  }
}

/** Every role, with what the screen needs to explain the choices in words. */
export async function listRoles(ctx: AppContext) {
  const rows = await repo.listRoles(ctx.db)
  const order = repo.orderOf(rows)
  return {
    roles: rows.map((r) => viewOf(r, order, ctx)),
    catalogue: {
      modules: PERMISSION_MODULES.map((m) => ({
        key: m.key,
        label: m.label,
        resource: m.resource,
        scopeQuestion: m.scopeQuestion ?? null,
        // Only the choices this module can honour, so the screen never offers another.
        scopes: m.resource ? [...(m.scopes ?? DATA_SCOPES)] : [],
        note: m.note ?? null,
        permissions: m.permissions.map((p) => ({ key: p.key, label: p.label, requires: p.requires ?? [] })),
      })),
      scopes: DATA_SCOPES.map((s) => ({ key: s, label: SCOPE_LABELS[s], hint: SCOPE_HINTS[s] })),
    },
  }
}

/**
 * The roles the caller may hand out — below their own, with nothing they
 * cannot do themselves. What the invite form, the Add employee form and the
 * Users screen offer; the server checks the same rule again when one is chosen.
 */
export async function assignableRoles(ctx: AppContext) {
  const { roles, order } = await repo.policyRoles(ctx.db)
  const actor = roles.get(ctx.role)
  if (!actor) return []
  return [...roles.values()]
    .filter((r) => mayGive(actor, r, order))
    .map((r) => ({ key: r.key, name: r.grant.name, locked: r.locked }))
}

async function readForChange(tx: TxDb, key: string) {
  const role = await repo.findRole(tx, key)
  if (!role) throw NotFound('Role not found')
  return role
}

/**
 * Ends the access tokens of everybody holding a role, so their screens pick up
 * the change. Called AFTER the change commits: ended earlier, a holder's
 * browser could refresh in between and be handed the role as it was.
 */
async function refreshHolders(users: string[]) {
  await repo.endAccessTokens(users)
  return users.length
}

function cleanOrRefuse(input: RoleInput, key: string | null, others: repo.RoleRecord[], order: ReturnType<typeof repo.orderOf>) {
  const checked = checkRoleInput(input, key, others, order)
  if (!checked.ok) throw BadRequest(checked.message)
  return checked
}

function parentIdOf(rows: repo.RoleRecord[], parentKey: string): string {
  const parent = rows.find((r) => r.key === parentKey)
  if (!parent) throw BadRequest('Choose which role this one comes under.')
  return parent.id
}

function write(role: CleanRole, parentId: string): repo.RoleWrite {
  return { name: role.name, description: role.description, parentId, permissions: role.permissions, scopes: role.scopes }
}

export async function createRole(ctx: AppContext, input: RoleInput) {
  const result = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const rows = await repo.listRoles(tx)
    const order = repo.orderOf(rows)
    const { role, warnings } = cleanOrRefuse(input, null, rows, order)
    const key = keyFor(role.name, new Set(rows.map((r) => r.key)))
    await repo.createRole(tx, ctx.organizationId, key, write(role, parentIdOf(rows, role.parentKey)))
    await audit(ctx, {
      action: 'role.created',
      entityType: 'role',
      entityId: key,
      details: {
        key,
        name: role.name,
        parentName: rows.find((r) => r.key === role.parentKey)?.name ?? null,
        permissions: role.permissions.map(permissionLabel),
        // Whose information it reaches, from the start — later edits are logged as changes from this.
        reach: reachOf(role.permissions, role.scopes),
      },
    }, tx)
    return { key, warnings }
  })
  logger.info('Role created', { by: ctx.userId, key: result.key })
  return result
}

export async function updateRole(ctx: AppContext, key: string, input: RoleInput & { version: string }) {
  const result = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const current = await readForChange(tx, key)
    const refusal = refuseEdit(current, ctx.role)
    if (refusal) throw Forbidden(ROLE_REFUSALS[refusal])
    if (String(current.updatedAt.getTime()) !== input.version) {
      throw Conflict('Somebody changed this role while you were editing it. Reload it to see their change, then make yours.')
    }

    const rows = await repo.listRoles(tx)
    const order = repo.orderOf(rows)
    const { role, warnings } = cleanOrRefuse(input, key, rows, order)
    const changed = await repo.updateRole(tx, current.id, current.updatedAt, write(role, parentIdOf(rows, role.parentKey)))
    if (changed === 0) throw Conflict('Somebody changed this role a moment ago. Reload it and try again.')

    const before = { permissions: current.permissions, scopes: toGrant(current).scopes }
    const parentBefore = order.get(key)?.parentKey ?? null
    await audit(ctx, {
      action: 'role.updated',
      entityType: 'role',
      entityId: key,
      details: {
        key,
        name: role.name,
        previousName: current.name,
        parentChanged: parentBefore !== role.parentKey,
        parentName: rows.find((r) => r.key === role.parentKey)?.name ?? null,
        descriptionChanged: current.description !== role.description,
        ...describeChange(before, role),
      },
    }, tx)
    return { key, warnings, holders: await repo.holderUserIds(tx, key) }
  })
  const holders = await refreshHolders(result.holders)
  logger.info('Role changed', { by: ctx.userId, key, holders })
  return { key: result.key, warnings: result.warnings, holders }
}

/** A built-in role, back to how EMS started it. */
export async function resetRole(ctx: AppContext, key: string, version: string) {
  const base = defaultRole(key)
  const result = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const current = await readForChange(tx, key)
    if (!current.builtIn || !base) throw BadRequest('Only the roles EMS starts with can be reset. A role you made can be changed or deleted.')
    const refusal = refuseEdit(current, ctx.role)
    if (refusal) throw Forbidden(ROLE_REFUSALS[refusal])
    if (String(current.updatedAt.getTime()) !== version) {
      throw Conflict('Somebody changed this role while you were looking at it. Reload it, then reset it.')
    }

    const rows = await repo.listRoles(tx)
    const order = repo.orderOf(rows)
    // The default's place in the order may no longer be possible — its parent
    // could have been moved under this role since. Then it is refused rather
    // than put somewhere it did not start.
    const parentKey = base.parentKey
    if (!parentKey || !order.has(parentKey) || wouldLoop(key, parentKey, order)) {
      throw Conflict('This role cannot be put back where it started, because of how the other roles are arranged now. Move them first.')
    }
    const restored: CleanRole = {
      name: base.name,
      description: base.description,
      parentKey,
      permissions: [...base.permissions],
      scopes: effectiveScopes(base.permissions, { ...base.scopes }),
    }
    // Its name may be taken by a role made since.
    const clash = rows.find((r) => r.key !== key && r.name.toLocaleLowerCase('en-IN') === base.name.toLocaleLowerCase('en-IN'))
    if (clash) throw Conflict(`Another role is called “${clash.name}” now. Rename it first, then reset this one.`)

    const changed = await repo.updateRole(tx, current.id, current.updatedAt, write(restored, parentIdOf(rows, parentKey)))
    if (changed === 0) throw Conflict('Somebody changed this role a moment ago. Reload it and try again.')
    await audit(ctx, {
      action: 'role.reset',
      entityType: 'role',
      entityId: key,
      details: {
        key,
        name: base.name,
        previousName: current.name,
        parentChanged: (order.get(key)?.parentKey ?? null) !== parentKey,
        parentName: rows.find((r) => r.key === parentKey)?.name ?? null,
        ...describeChange({ permissions: current.permissions, scopes: toGrant(current).scopes }, restored),
      },
    }, tx)
    return { key, holders: await repo.holderUserIds(tx, key) }
  })
  const holders = await refreshHolders(result.holders)
  logger.info('Role reset', { by: ctx.userId, key, holders })
  return { key: result.key, holders }
}

export async function deleteRole(ctx: AppContext, key: string) {
  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    const current = await readForChange(tx, key)
    const refusal = refuseDelete(current, ctx.role, current._count.memberships, await repo.childCount(tx, current.id))
    // Not yours to delete is forbidden, as it is for an edit; a role that is
    // still needed is a conflict the Super Admin can resolve first.
    if (refusal === 'locked' || refusal === 'own_role') throw Forbidden(ROLE_REFUSALS[refusal])
    if (refusal) throw Conflict(ROLE_REFUSALS[refusal])
    await repo.deleteRole(tx, current.id)
    // What the role was, in full: once it is gone, this row is the only record of it.
    const grant = toGrant(current)
    await audit(ctx, {
      action: 'role.deleted',
      entityType: 'role',
      entityId: key,
      details: { key, name: current.name, permissions: [...grant.permissions].map(permissionLabel), reach: reachOf([...grant.permissions], grant.scopes) },
    }, tx)
  })
  logger.info('Role deleted', { by: ctx.userId, key })
}
