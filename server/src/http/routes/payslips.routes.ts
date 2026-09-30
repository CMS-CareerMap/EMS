import { Router } from 'express'
import { getMyBankAccount, getMyPayslips, getPayslipPdf, putMyBankAccount } from '../controllers/payslip.controller'
import { singleFile } from '../upload'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/payslips.
 *
 * `payslip:read` is held by every role, and what it reaches is the data scope:
 * SELF for nearly everybody — your own payslips and nobody else's — and the
 * whole company only for Accounts and Super Admin (scope.ts).
 */
export const payslipsRouter = Router()

payslipsRouter.use(authenticate)

payslipsRouter.get('/me', authorize('payslip:read'), getMyPayslips)
// Where those payslips are paid — the person's own account, and only theirs.
payslipsRouter.get('/me/bank-account', authorize('payslip:read'), getMyBankAccount)
// Sending in one's own — with the cheque or passbook page. It waits for Accounts.
payslipsRouter.put('/me/bank-account', authorize('payslip:read'), singleFile('proof'), putMyBankAccount)
payslipsRouter.get('/:id/pdf', authorize('payslip:read'), getPayslipPdf)
