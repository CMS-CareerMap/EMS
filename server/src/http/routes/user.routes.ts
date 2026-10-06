import { Router } from 'express'
import { postPasswordLink,
  postWithdraw,
  getUsers,
  postInvite,
  putRole,
  patchStatus,
  deleteUser,
  postSetPassword,
  getPasswordRules,
  putPasswordRules,
} from '../controllers/user.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/users.
 *
 * Every route here is super_admin-only in practice, because §3.2 gives "Invite
 * users", "Manage roles/status" and "Delete users" to that role alone. That is
 * expressed as four separate permissions rather than one `is_super_admin`
 * check, so the client can move any of them to another role later without a
 * code change here.
 *
 * `membership:role:assign` is deliberately its own permission and not folded
 * into `user:status:update`. Deactivating somebody and promoting somebody are
 * different powers, and an organisation that wants to delegate the first
 * without the second must be able to.
 */
export const userRouter = Router()

userRouter.use(authenticate)

// The list is what every one of the four works from. Since Day 21 a role can
// hold, say, "turn a login on or off" without "invite", and needs the list to
// do it.
// Setting passwords too (client, 6 Oct 2026): HR finds there the logins still
// waiting for one.
userRouter.get('/', authorize(['user:invite', 'membership:role:assign', 'user:status:update', 'user:delete', 'user:password:set']), getUsers)
// Settings → Users & Roles → Passwords: who sets each kind of login's password, and how long one must be.
userRouter.get('/password-rules', authorize('settings:read'), getPasswordRules)
// Who sets passwords is user management, the Super Admin's alone — not a
// company setting any role given settings:update may flip.
userRouter.put('/password-rules', authorize('role:manage'), putPasswordRules)
userRouter.post('/invite', authorize('user:invite'), postInvite)
userRouter.post('/:id/password-link', authorize('user:invite'), postPasswordLink)
// HR sets an employee login's password; the Super Admin anybody's (the service decides which).
userRouter.post('/:id/password', authorize('user:password:set'), postSetPassword)
// An invitation nobody used, taken back — a mistyped address (Day 23 wrap-up).
userRouter.post('/:id/withdraw', authorize('user:invite'), postWithdraw)
userRouter.put('/:id/role', authorize('membership:role:assign'), putRole)
userRouter.patch('/:id/status', authorize('user:status:update'), patchStatus)
userRouter.delete('/:id', authorize('user:delete'), deleteUser)
