import { Router } from 'express'
import { deleteRoleHandler, getAssignableRoles, getRoles, postRole, postRoleReset, putRole } from '../controllers/roles.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/roles (Day 21).
 *
 * Seeing and changing roles is `role:manage`, which the Super Admin holds and
 * the Roles screen will not give to anybody else.
 *
 * The roles one may HAND OUT are needed wherever a login is made or changed —
 * inviting, adding an employee with a login, changing somebody's role,
 * switching a login off — so that list goes to whoever may do any of those,
 * and holds only the roles below their own.
 */
export const rolesRouter = Router()

rolesRouter.use(authenticate)
rolesRouter.get('/', authorize('role:manage'), getRoles)
// Also for switching logins on and off and removing them: the Users screen
// offers those only on the people whose role is one the caller could give.
rolesRouter.get(
  '/assignable',
  authorize(['user:invite', 'membership:role:assign', 'employee:create', 'user:status:update', 'user:delete']),
  getAssignableRoles,
)
rolesRouter.post('/', authorize('role:manage'), postRole)
rolesRouter.put('/:key', authorize('role:manage'), putRole)
rolesRouter.post('/:key/reset', authorize('role:manage'), postRoleReset)
rolesRouter.delete('/:key', authorize('role:manage'), deleteRoleHandler)
