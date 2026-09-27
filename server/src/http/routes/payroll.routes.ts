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
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

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

payrollRouter.get('/components', authorize('payroll:structure:read'), getComponents)
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
