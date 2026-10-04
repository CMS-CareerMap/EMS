import { Router } from 'express'
import {
  getComponents,
  postCalculate,
  postEsiRedecide,
  getSalaryRoster,
  getSalaryHistory,
  putSalary,
} from '../controllers/payroll.controller'
import {
  getTdsDirectives,
  putTdsDirective,
  getMonthlyEntries,
  putMonthlyEntry,
  deleteMonthlyEntry,
} from '../controllers/payrollInputs.controller'
import {
  getBankAccounts,
  putBankAccount,
  postVerifyBankAccount,
  getBankAccountProof,
  getBankFileTemplate,
  putBankFileTemplate,
} from '../controllers/bankAccount.controller'
import {
  getAllComponents,
  postComponent,
  patchComponent,
  deleteComponent,
  getLoans,
  postLoan,
  postCloseLoan,
  deleteLoan,
} from '../controllers/payrollExtras.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'
import { singleFile } from '../upload'

/**
 * Mounted at /api/payroll.
 *
 * The salary engine, reachable. Day 16 adds payroll RUNS on top — the thing
 * that snapshots a month into payslips — and they will call the same
 * calculation rather than repeat it.
 *
 * `payroll:structure:read` to see figures, `payroll:structure:manage` to change
 * a statutory decision. Held by Accounts and above; HR and managers see none
 * of it, which is the client's own matrix (§3.1).
 */
export const payrollRouter = Router()

payrollRouter.use(authenticate)

// The catalogue is no secret: HR needs it to enter an incentive.
payrollRouter.get('/components', authorize(['payroll:structure:read', 'payroll:entry:manage']), getComponents)
// The company's own components (client §40): the accountant's to add, change and archive.
payrollRouter.get('/components/all', authorize('payroll:structure:read'), getAllComponents)
payrollRouter.post('/components', authorize('payroll:structure:manage'), postComponent)
payrollRouter.patch('/components/:id', authorize('payroll:structure:manage'), patchComponent)
payrollRouter.delete('/components/:id', authorize('payroll:structure:manage'), deleteComponent)

// Loans and salary advances (client §40), recovered from pay.
payrollRouter.get('/loans', authorize('payroll:structure:read'), getLoans)
payrollRouter.post('/loans', authorize('payroll:structure:manage'), postLoan)
payrollRouter.post('/loans/:id/close', authorize('payroll:structure:manage'), postCloseLoan)
payrollRouter.delete('/loans/:id', authorize('payroll:structure:manage'), deleteLoan)
payrollRouter.post('/calculate', authorize('payroll:structure:read'), postCalculate)
payrollRouter.post(
  '/esi-coverage/redecide',
  authorize('payroll:structure:manage'),
  postEsiRedecide,
)

// Salary structures — "Accounts creates salary structure → creates payroll run".
payrollRouter.get('/employees', authorize('payroll:structure:read'), getSalaryRoster)
payrollRouter.get('/employees/:id/salary', authorize('payroll:structure:read'), getSalaryHistory)
payrollRouter.put('/employees/:id/salary', authorize('payroll:structure:manage'), putSalary)

// TDS, manual mode (Day 16): the accountant's call, so the same right as a salary.
payrollRouter.get('/tds-directives', authorize('payroll:structure:read'), getTdsDirectives)
payrollRouter.put('/tds-directives', authorize('payroll:structure:manage'), putTdsDirective)

// Incentive and any other monthly component: "an authorised role (HR/Accounts)
// sets the amount per employee per month" (§A1.5) — its own permission,
// because HR holds it without holding anything else in payroll.
payrollRouter.get('/monthly-entries', authorize('payroll:entry:manage'), getMonthlyEntries)
payrollRouter.put('/monthly-entries', authorize('payroll:entry:manage'), putMonthlyEntry)
payrollRouter.delete('/monthly-entries/:id', authorize('payroll:entry:manage'), deleteMonthlyEntry)

// Bank accounts for salary: read to pay, manage to enter and check. The
// employee's own submission is PUT /payslips/me/bank-account.
payrollRouter.get('/bank-accounts', authorize('employee:bank:read'), getBankAccounts)
// JSON, or multipart with the cheque or passbook page as "proof".
payrollRouter.put('/employees/:id/bank-account', authorize('employee:bank:manage'), singleFile('proof'), putBankAccount)
payrollRouter.get('/employees/:id/bank-account/proof', authorize('employee:bank:read'), getBankAccountProof)
payrollRouter.post('/employees/:id/bank-account/verify', authorize('employee:bank:manage'), postVerifyBankAccount)

// The bank file's layout, set once from the bank's sample.
payrollRouter.get('/bank-file-template', authorize('payroll:structure:read'), getBankFileTemplate)
payrollRouter.put('/bank-file-template', authorize('payroll:structure:manage'), putBankFileTemplate)
