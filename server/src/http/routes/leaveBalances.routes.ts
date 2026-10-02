import { Router } from 'express'
import { getGrantPreview, getTeamBalances, postAdjustment, postGrant } from '../controllers/leaveBalances.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/leave-balances.
 *
 * Seeing others' balances goes with seeing their leave (`leave:read`),
 * narrowed by the leave scope: the company for HR and the Super Admin, the
 * team for a manager, their own for everybody else. (It went with
 * `leave:approve` until Day 22, when approving moved to the company tree.)
 * Granting and correcting are `leave:balance:manage`. An employee's own
 * balances stay at /api/leave-requests/balances.
 */
export const leaveBalancesRouter = Router()

leaveBalancesRouter.use(authenticate)
leaveBalancesRouter.get('/', authorize('leave:read'), getTeamBalances)
leaveBalancesRouter.get('/grant-preview', authorize('leave:balance:manage'), getGrantPreview)
leaveBalancesRouter.post('/grant', authorize('leave:balance:manage'), postGrant)
leaveBalancesRouter.post('/adjustments', authorize('leave:balance:manage'), postAdjustment)
