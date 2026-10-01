import { Router } from 'express'
import { getGrantPreview, getTeamBalances, postAdjustment, postGrant } from '../controllers/leaveBalances.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/leave-balances.
 *
 * Seeing others' balances goes with deciding their leave (`leave:approve`),
 * narrowed by the leave scope: the company for HR and the Super Admin, the
 * team for a manager. Granting and correcting are `leave:balance:manage`.
 * An employee's own balances stay at /api/leave-requests/balances.
 */
export const leaveBalancesRouter = Router()

leaveBalancesRouter.use(authenticate)
leaveBalancesRouter.get('/', authorize('leave:approve'), getTeamBalances)
leaveBalancesRouter.get('/grant-preview', authorize('leave:balance:manage'), getGrantPreview)
leaveBalancesRouter.post('/grant', authorize('leave:balance:manage'), postGrant)
leaveBalancesRouter.post('/adjustments', authorize('leave:balance:manage'), postAdjustment)
