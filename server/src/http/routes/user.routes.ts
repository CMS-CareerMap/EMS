import { Router } from 'express'
import { postPasswordLink,
  postWithdraw,
  getUsers,
  postInvite,
  putRole,
  patchStatus,
  deleteUser,
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
userRouter.get('/', authorize(['user:invite', 'membership:role:assign', 'user:status:update', 'user:delete']), getUsers)
userRouter.post('/invite', authorize('user:invite'), postInvite)
userRouter.post('/:id/password-link', authorize('user:invite'), postPasswordLink)
// An invitation nobody used, taken back — a mistyped address (Day 23 wrap-up).
userRouter.post('/:id/withdraw', authorize('user:invite'), postWithdraw)
userRouter.put('/:id/role', authorize('membership:role:assign'), putRole)
userRouter.patch('/:id/status', authorize('user:status:update'), patchStatus)
userRouter.delete('/:id', authorize('user:delete'), deleteUser)
