import type { RequestHandler } from 'express'
import * as payroll from '../../modules/payroll/payroll.service'
import { redecide, type Coverage } from '../../modules/payroll/esiCoverage.service'
import {
  calculationSchema,
  esiRedecideSchema,
  payrollEmployeeParamSchema,
  salaryStructureSchema,
} from '../validators/payroll.validator'
import * as salary from '../../modules/payroll/salaryStructure.service'
import { fromDateColumn } from '../../domain/shared/dates'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'

/**
 * Payroll. Snake_case out, matching the rest of v1.
 */

const ok = (res: Parameters<RequestHandler>[1], data: unknown) =>
  res.status(200).json({ data, meta: { requestId: res.locals.requestId } })

function coveragePayload(coverage: Coverage) {
  return {
    covered: coverage.covered,
    period_start: coverage.periodStart,
    period_end: coverage.periodEnd,
    locked_wage_rate: coverage.lockedWageRate,
    reason: coverage.reason,
  }
}

/** GET /api/payroll/components */
export const getComponents: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const rows = await payroll.listComponents(ctx)

  ok(
    res,
    rows.map((row) => ({
      id: row.id,
      code: row.code,
      label: row.label,
      type: row.type,
      counts_for_pf: row.countsForPf,
      // "monthly" means entered per employee per month, never on a salary.
      entry: row.entry,
      taxable: row.taxable,
      display_order: row.displayOrder,
    })),
  )
}

/**
 * POST /api/payroll/calculate
 *
 * POST rather than GET for two reasons. It takes inputs that are not
 * identifiers — loss of pay, TDS — and it can WRITE: the first calculation to
 * touch an ESI contribution period locks that period's coverage decision.
 * The decision is taken against the wage rate at the period's start, so it
 * comes out the same whoever triggers it and whenever, but it is still a
 * write, and a GET that writes is a GET a crawler or a prefetch can trigger.
 */
export const postCalculate: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(calculationSchema, req.body)

  const calc = await payroll.calculate(ctx, input.employeeId, input.year, input.month, {
    ...(input.lopDays !== undefined ? { lopDays: input.lopDays } : {}),
    ...(input.tds !== undefined ? { tds: input.tds } : {}),
    ...(input.monthlyAmounts !== undefined ? { monthlyAmounts: input.monthlyAmounts } : {}),
  })

  const r = calc.result

  ok(res, {
    employee: {
      id: calc.employee.id,
      full_name: calc.employee.fullName,
      employee_code: calc.employee.employeeCode,
    },
    year: calc.year,
    month: calc.month,

    earnings: r.earnings,
    deductions: r.deductions,

    gross_earnings: r.grossEarnings,
    pf_wages: r.pfWages,
    employee_pf: r.employeePf,
    employee_esi: r.employeeEsi,
    professional_tax: r.professionalTax,
    tds: r.tds,
    other_deductions: r.otherDeductions,
    total_deductions: r.totalDeductions,
    net_payable: r.netPayable,

    employer: {
      pf_total: r.employer.pfTotal,
      eps: r.employer.eps,
      epf: r.employer.epf,
      esi: r.employer.esi,
    },

    days_in_month: r.daysInMonth,
    employment_days: calc.basis.employmentDays,
    paid_days: r.paidDays,
    lop_days: r.lopDays,

    basis: {
      salary_effective_from: calc.basis.salaryEffectiveFrom,
      policy_effective_from: calc.basis.policyEffectiveFrom,
      esi: coveragePayload(calc.basis.esi),
      eps_member: calc.basis.epsMember,
      pt_state: calc.basis.ptState,
      pt_gender: calc.basis.ptGender,
    },

    // Not an error list. Each is a fact the calculation had to assume around,
    // shown so that whoever is looking at the figure can close the gap before
    // it reaches a payslip.
    warnings: calc.basis.warnings,

    // Said in the payload rather than left to the screen to remember. Day 16's
    // payroll run is what makes a payslip; this is what it would say.
    is_preview: true,
  })
}

/**
 * POST /api/payroll/esi-coverage/redecide
 *
 * For a salary that was entered wrongly at the period's start — not for a
 * raise, which is the locked rule working as intended.
 */
export const postEsiRedecide: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(esiRedecideSchema, req.body)

  // 404 for somebody outside the organization, the same as everywhere else.
  // The calculation would say so too, but redeciding must not write a
  // coverage row for an id the caller cannot see.
  await payroll.assertEmployeeVisible(ctx, input.employeeId)

  const coverage = await redecide(ctx, input.employeeId, input.year, input.month)
  ok(res, coveragePayload(coverage))
}

type SalaryRecord = ReturnType<typeof salary.toRecord>

function salaryPayload(record: SalaryRecord) {
  return {
    effective_from: record.effectiveFrom,
    effective_to: record.effectiveTo,
    ctc: record.ctc,
    gross_monthly: record.grossMonthly,
    components: record.components,
  }
}

/**
 * GET /api/payroll/employees
 *
 * Everybody on the payroll with their current salary, or `salary: null` —
 * which means NONE RECORDED, and is exactly the list Accounts has to work
 * through before the first payroll run.
 */
export const getSalaryRoster: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const rows = await salary.roster(ctx)

  ok(
    res,
    rows.map(({ row: employee, check }) => {
      const current = employee.financials[0]
      return {
        employee_id: employee.id,
        employee_code: employee.employeeCode,
        full_name: employee.fullName,
        department: employee.department?.name ?? null,
        designation: employee.designation?.name ?? null,
        date_of_joining: employee.dateOfJoining ? fromDateColumn(employee.dateOfJoining) : null,
        last_working_date: employee.lastWorkingDate ? fromDateColumn(employee.lastWorkingDate) : null,
        salary: current ? salaryPayload(salary.toRecord(current)) : null,
        // Whether the caller may enter this salary (Day 22: own work goes up the
        // tree), and if not, whom to ask.
        may_enter: check.allowed,
        own: check.own,
        entry_goes_to: check.allowed ? null : check.ask,
      }
    }),
  )
}

/** GET /api/payroll/employees/:id/salary — every salary this person has had. */
export const getSalaryHistory: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollEmployeeParamSchema, req.params)
  const result = await salary.history(ctx, id)

  ok(res, {
    employee_id: result.employee.id,
    full_name: result.employee.fullName,
    date_of_joining: result.employee.dateOfJoining ? fromDateColumn(result.employee.dateOfJoining) : null,
    history: result.history.map(salaryPayload),
  })
}

/**
 * PUT /api/payroll/employees/:id/salary
 *
 * Sets a salary from a date. A later date is a raise (the old record closes
 * the day before); the same date as the current record is a correction.
 */
export const putSalary: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollEmployeeParamSchema, req.params)
  const input = parseBody(salaryStructureSchema, req.body)

  const result = await salary.setSalary(ctx, id, input)

  ok(res, {
    employee_id: result.employee.id,
    full_name: result.employee.fullName,
    date_of_joining: result.employee.dateOfJoining ? fromDateColumn(result.employee.dateOfJoining) : null,
    history: result.history.map(salaryPayload),
  })
}
