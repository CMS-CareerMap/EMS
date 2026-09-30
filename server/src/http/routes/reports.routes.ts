import { Router } from 'express'
import { getReport } from '../controllers/reports.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/reports. Super Admin's, as the client's matrix has it (§3.1:
 * Reports ✅ for Super Admin only). Every CSV taken is recorded.
 */
export const reportsRouter = Router()

reportsRouter.use(authenticate)
reportsRouter.get('/:id', authorize('report:read'), getReport)
