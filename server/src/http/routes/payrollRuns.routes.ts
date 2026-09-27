import { Router } from 'express'
import {
  getRuns,
  getReadiness,
  postRun,
  getRun,
  postRecalculate,
  deleteRun,
  getPayslip,
} from '../controllers/payrollRun.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/payroll-runs.
 *
 * "Accounts creates salary structure → creates payroll run (draft) →
 * auto-generates payslips" — the client's own flow (§ Payroll). Reading needs
 * `payroll:structure:read`, the permission that opens the Payroll module;
 * anything that writes a run needs `payroll:run:create`.
 */
export const payrollRunsRouter = Router()

payrollRunsRouter.use(authenticate)

payrollRunsRouter.get('/', authorize('payroll:structure:read'), getRuns)
// Before '/:id', or "readiness" would be read as an id.
payrollRunsRouter.get('/readiness', authorize('payroll:structure:read'), getReadiness)
payrollRunsRouter.post('/', authorize('payroll:run:create'), postRun)
payrollRunsRouter.get('/:id', authorize('payroll:structure:read'), getRun)
payrollRunsRouter.post('/:id/recalculate', authorize('payroll:run:create'), postRecalculate)
payrollRunsRouter.delete('/:id', authorize('payroll:run:create'), deleteRun)
payrollRunsRouter.get('/:id/payslips/:payslipId', authorize('payroll:structure:read'), getPayslip)
