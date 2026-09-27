import { Router } from 'express'
import {
  getRuns,
  getReadiness,
  postRun,
  getRun,
  postRecalculate,
  deleteRun,
  getPayslip,
  postApprove,
  postReopen,
  postMarkPaid,
  getRunPayslipPdf,
} from '../controllers/payrollRun.controller'
import { getBankFile, getBankFilePreview } from '../controllers/bankAccount.controller'
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
payrollRunsRouter.get('/:id/payslips/:payslipId/pdf', authorize('payroll:structure:read'), getRunPayslipPdf)

// Signing off is a different right from preparing: Accounts prepares, and the
// approver — Super Admin by default — signs. Recording the payment goes back to
// whoever moved the money.
payrollRunsRouter.post('/:id/approve', authorize('payroll:run:approve'), postApprove)
payrollRunsRouter.post('/:id/reopen', authorize('payroll:run:approve'), postReopen)
payrollRunsRouter.post('/:id/mark-paid', authorize('payroll:run:create'), postMarkPaid)

// The bank transfer file: from an approved or paid run, for whoever pays.
payrollRunsRouter.get('/:id/bank-file/preview', authorize('payroll:run:create'), getBankFilePreview)
payrollRunsRouter.get('/:id/bank-file', authorize('payroll:run:create'), getBankFile)
