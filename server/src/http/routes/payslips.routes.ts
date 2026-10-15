import { Router } from 'express'
import { getMyBankAccount, getMyPayslips, getPayslipPdf, getPeoplesPayslips, putMyBankAccount } from '../controllers/payslip.controller'
import { singleFile } from '../upload'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/payslips.
 *
 * `payslip:read` is held by every role, and what it reaches is the data scope,
 * "Whose payslips" — any of the six choices (15 Oct 2026): SELF to start for
 * nearly everybody, the whole company for Accounts and the Super Admin.
 */
export const payslipsRouter = Router()

payslipsRouter.use(authenticate)

// The people "Whose payslips" reaches, a month at a time (client, 15 Oct 2026).
payslipsRouter.get('/', authorize('payslip:read'), getPeoplesPayslips)
payslipsRouter.get('/me', authorize('payslip:read'), getMyPayslips)
// Where those payslips are paid — the person's own account, and only theirs.
payslipsRouter.get('/me/bank-account', authorize('payslip:read'), getMyBankAccount)
// Sending in one's own — with the cheque or passbook page. It waits for Accounts.
payslipsRouter.put('/me/bank-account', authorize('payslip:read'), singleFile('proof'), putMyBankAccount)
payslipsRouter.get('/:id/pdf', authorize('payslip:read'), getPayslipPdf)
