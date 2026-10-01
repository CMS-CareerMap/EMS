import type { RequestHandler } from 'express'
import { assignableRoles, createRole, deleteRole, listRoles, resetRole, updateRole } from '../../modules/roles/roles.service'
import { createRoleSchema, resetRoleSchema, roleKeyParamSchema, updateRoleSchema } from '../validators/roles.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'

/**
 * GET    /api/roles             every role, and the words the screen explains them in
 * GET    /api/roles/assignable  the roles the caller may hand out
 * POST   /api/roles             a new role
 * PUT    /api/roles/:key        change a role
 * POST   /api/roles/:key/reset  a built-in role back to how EMS started it
 * DELETE /api/roles/:key        a role nobody holds
 */

export const getRoles: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const r = await listRoles(ctx)
  res.status(200).json({
    data: {
      roles: r.roles.map((role) => ({
        key: role.key,
        name: role.name,
        description: role.description,
        parent_key: role.parentKey,
        built_in: role.builtIn,
        locked: role.locked,
        permissions: role.permissions,
        scopes: role.scopes,
        holders: role.holders,
        version: role.version,
        own: role.own,
        changed_from_default: role.changedFromDefault,
      })),
      catalogue: {
        modules: r.catalogue.modules.map((m) => ({
          key: m.key,
          label: m.label,
          resource: m.resource,
          scope_question: m.scopeQuestion,
          scopes: m.scopes,
          note: m.note,
          permissions: m.permissions,
        })),
        scopes: r.catalogue.scopes,
      },
    },
    meta: { requestId: res.locals.requestId },
  })
}

export const getAssignableRoles: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const roles = await assignableRoles(ctx)
  res.status(200).json({
    data: roles.map((r) => ({ key: r.key, name: r.name, locked: r.locked })),
    meta: { requestId: res.locals.requestId },
  })
}

export const postRole: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const body = parseBody(createRoleSchema, req.body)
  const r = await createRole(ctx, body)
  res.status(201).json({ data: { key: r.key, warnings: r.warnings }, meta: { requestId: res.locals.requestId } })
}

export const putRole: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { key } = parseBody(roleKeyParamSchema, req.params)
  const body = parseBody(updateRoleSchema, req.body)
  const r = await updateRole(ctx, key, body)
  res.status(200).json({ data: { key: r.key, warnings: r.warnings, holders: r.holders }, meta: { requestId: res.locals.requestId } })
}

export const postRoleReset: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { key } = parseBody(roleKeyParamSchema, req.params)
  const body = parseBody(resetRoleSchema, req.body)
  const r = await resetRole(ctx, key, body.version)
  res.status(200).json({ data: { key: r.key, holders: r.holders }, meta: { requestId: res.locals.requestId } })
}

export const deleteRoleHandler: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { key } = parseBody(roleKeyParamSchema, req.params)
  await deleteRole(ctx, key)
  res.status(204).end()
}
