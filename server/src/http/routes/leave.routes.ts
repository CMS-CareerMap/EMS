import { Router } from 'express'
import {
  postPreview,
  postLeave,
  getLeave,
  getTeamLeave,
  getBalances,
  getStatement,
  deleteLeave,
  postApprove,
  postReject,
  postReverse,
} from '../controllers/leave.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/leave-requests.
 *
 * `leave:apply` is held by everybody who can take leave; `leave:read` decides
 * whose requests you see, narrowed further by the data scope — the company for
 * HR, direct reports for a manager, their own for an employee.
 *
 * DECIDING needs no permission since Day 22. It follows the company tree: the
 * person somebody reports to decides their leave, whatever that person's role
 * (an Accounts head approves the accountant's), the Super Admin decides for
 * somebody with nobody above, and Settings → Approvals names the backups. The
 * service checks it on every decision (leave/leaveApprover.service), and
 * anybody else is told who decides — or, if they cannot see the request, that
 * it does not exist. So these routes need only a signed-in caller.
 *
 * `/balances` and `/team` are registered before nothing that could shadow
 * them — there is no GET /:id here, so a literal path cannot be swallowed by a
 * parameter.
 */
export const leaveRouter = Router()

leaveRouter.use(authenticate)

leaveRouter.post('/preview', authorize('leave:apply'), postPreview)
leaveRouter.post('/', authorize('leave:apply'), postLeave)
// Withdrawing your own — or, for whoever decides it, somebody else's.
leaveRouter.delete('/:id', deleteLeave)

leaveRouter.get('/balances', authorize('leave:read'), getBalances)
// One type's passbook for a leave year — one's own, or that of somebody whose leave one decides.
leaveRouter.get('/statement', authorize('leave:read'), getStatement)
leaveRouter.get('/team', getTeamLeave)
leaveRouter.get('/', authorize('leave:read'), getLeave)

leaveRouter.post('/:id/approve', postApprove)
leaveRouter.post('/:id/reject', postReject)
leaveRouter.post('/:id/reverse', postReverse)
