import type { Prisma } from '@prisma/client'
import type { RequestHandler } from 'express'
import * as runs from '../../modules/payroll/payrollRun.service'
import * as approval from '../../modules/payroll/payrollApproval.service'
import { runPayslipPdf } from '../../modules/payroll/payslip.service'
import type { RunRow, PayslipRow } from '../../modules/payroll/payrollRun.repository'
import { fromDateColumn, isoInstant } from '../../domain/shared/dates'
import {
  approveRunSchema,
  markPaidSchema,
  payrollMonthSchema,
  payrollRunParamSchema,
  payslipParamSchema,
} from '../validators/payroll.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { sendPdf } from '../pdf'

/**
 * Payroll runs. Snake_case out, matching the rest of v1; money in rupees.
 */

const reply = (res: Parameters<RequestHandler>[1], status: number, data: unknown) =>
  res.status(status).json({ data, meta: { requestId: res.locals.requestId } })

const num = (value: Prisma.Decimal) => Number(value)

function runPayload(run: RunRow) {
  return {
    id: run.id,
    year: run.year,
    month: run.month,
    status: run.status,
    lop_basis: run.lopBasis,
    sandwich_rule: run.sandwichRule,
    employee_count: run.employeeCount,
    gross_earnings: num(run.grossEarnings),
    total_deductions: num(run.totalDeductions),
    net_payable: num(run.netPayable),
    employer_pf: num(run.employerPf),
    employer_esi: num(run.employerEsi),
    warnings: run.warnings,
    created_by_user_id: run.createdByUserId,
    calculated_at: isoInstant(run.calculatedAt),
    created_at: isoInstant(run.createdAt),
    approved_by_user_id: run.approvedByUserId,
    approved_at: isoInstant(run.approvedAt),
    // How many days the approver accepted as paid with nothing recorded.
    assumed_days: run.assumedDays,
    employer_name: run.employerName,
    employer_address: run.employerAddress,
    paid_on: fromDateColumn(run.paidOn),
    paid_by_user_id: run.paidByUserId,
    paid_at: isoInstant(run.paidAt),
  }
}

type RunWithPayslips = Awaited<ReturnType<typeof runs.getRun>>

function runDetailPayload({ run, payslips }: RunWithPayslips) {
  return {
    ...runPayload(run),
    payslips: payslips.map((slip) => ({
      id: slip.id,
      employee_id: slip.employeeId,
      employee_code: slip.employeeCode,
      full_name: slip.employeeName,
      days_in_month: slip.daysInMonth,
      employment_days: slip.employmentDays,
      lop_days: num(slip.lopDays),
      paid_days: num(slip.paidDays),
      gross_earnings: num(slip.grossEarnings),
      total_deductions: num(slip.totalDeductions),
      net_payable: num(slip.netPayable),
      warnings: slip.warnings,
    })),
  }
}

function payslipPayload(slip: PayslipRow) {
  const line = (row: PayslipRow['lines'][number]) => ({
    code: row.code,
    label: row.label,
    rate: row.rate === null ? null : num(row.rate),
    amount: num(row.amount),
  })

  return {
    id: slip.id,
    payroll_run_id: slip.payrollRunId,
    employee_id: slip.employeeId,
    employee_code: slip.employeeCode,
    full_name: slip.employeeName,
    designation: slip.designation,
    department: slip.department,
    date_of_joining: fromDateColumn(slip.dateOfJoining),
    country: slip.country,
    currency: slip.currency,
    year: slip.year,
    month: slip.month,

    // Copied at approval; null before it, and null when none is on record.
    uan: slip.uan,
    pf_member_id: slip.pfMemberId,
    esic_number: slip.esicNumber,
    pan: slip.pan,

    days_in_month: slip.daysInMonth,
    employment_days: slip.employmentDays,
    lop_days: num(slip.lopDays),
    paid_days: num(slip.paidDays),
    ncp_days: num(slip.ncpDays),
    lop_basis: slip.lopBasis,
    pay_basis_days: slip.payBasisDays,
    payable_days: num(slip.payableDays),

    earnings: slip.lines.filter((row) => row.kind === 'earning').map(line),
    deductions: slip.lines.filter((row) => row.kind === 'deduction').map(line),

    gross_earnings: num(slip.grossEarnings),
    pf_wages: num(slip.pfWages),
    employee_pf: num(slip.employeePf),
    employee_esi: num(slip.employeeEsi),
    professional_tax: num(slip.professionalTax),
    tds: num(slip.tds),
    other_deductions: num(slip.otherDeductions),
    total_deductions: num(slip.totalDeductions),
    net_payable: num(slip.netPayable),

    employer: {
      pf_total: num(slip.employerPf),
      eps: num(slip.employerEps),
      epf: num(slip.employerEpf),
      esi: num(slip.employerEsi),
    },

    // Stored as the calculation wrote it, and returned as it was stored: the
    // facts behind the figures, for "why is my PF ₹1,800?".
    basis: slip.basis,
    warnings: slip.warnings,
    created_at: isoInstant(slip.createdAt),

    // The stored document, once the run is paid.
    pdf: slip.pdfKey
      ? { sha256: slip.pdfSha256, bytes: slip.pdfBytes, generated_at: isoInstant(slip.pdfGeneratedAt) }
      : null,
  }
}

/** GET /api/payroll-runs */
export const getRuns: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  reply(res, 200, (await runs.listRuns(ctx)).map(runPayload))
}

/**
 * GET /api/payroll-runs/readiness?year=&month=
 *
 * What a run would find — everybody in it, their loss of pay, what blocks it —
 * without writing anything.
 */
export const getReadiness: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { year, month } = parseBody(payrollMonthSchema, req.query)
  const result = await runs.readiness(ctx, year, month)

  reply(res, 200, {
    year: result.year,
    month: result.month,
    tds_enabled: result.tdsEnabled,
    run: result.run,
    blocked: result.blockers.length > 0,
    blockers: result.blockers.map((b) => ({
      code: b.code,
      message: b.message,
      employee_id: b.employee.id,
      employee_code: b.employee.employeeCode,
      full_name: b.employee.fullName,
    })),
    warnings: result.warnings,
    employees: result.employees.map((e) => ({
      employee_id: e.employee.id,
      employee_code: e.employee.employeeCode,
      full_name: e.employee.fullName,
      employment_from: e.employmentFrom,
      employment_to: e.employmentTo,
      lop_days: e.lopDays,
      unmarked_days: e.unmarkedDays,
      tds: e.tds,
      entries: e.entries,
      warnings: e.warnings,
    })),
  })
}

/**
 * POST /api/payroll-runs  { year, month }
 *
 * 422 BUSINESS_RULE with `details.blockers` when anybody in the month cannot
 * be paid yet — every problem at once, so they can all be fixed at once.
 */
export const postRun: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { year, month } = parseBody(payrollMonthSchema, req.body)
  reply(res, 201, runDetailPayload(await runs.createRun(ctx, year, month)))
}

/** GET /api/payroll-runs/:id */
export const getRun: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollRunParamSchema, req.params)
  reply(res, 200, runDetailPayload(await runs.getRun(ctx, id)))
}

/** POST /api/payroll-runs/:id/recalculate — a draft, from the records as they are now. */
export const postRecalculate: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollRunParamSchema, req.params)
  reply(res, 200, runDetailPayload(await runs.recalculateRun(ctx, id)))
}

/** DELETE /api/payroll-runs/:id — a draft only. */
export const deleteRun: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollRunParamSchema, req.params)
  await runs.discardRun(ctx, id)
  reply(res, 200, null)
}

/** GET /api/payroll-runs/:id/payslips/:payslipId */
export const getPayslip: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id, payslipId } = parseBody(payslipParamSchema, req.params)
  reply(res, 200, payslipPayload(await runs.getPayslip(ctx, id, payslipId)))
}

/**
 * POST /api/payroll-runs/:id/approve  { confirmAssumedDays? }
 *
 * 422 BUSINESS_RULE with `details.changed` when the records moved since the
 * draft was calculated, or `details.employees` when days were counted as paid
 * on no record and nobody has yet said they accept that.
 */
export const postApprove: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollRunParamSchema, req.params)
  const input = parseBody(approveRunSchema, req.body ?? {})
  reply(res, 200, runDetailPayload(await approval.approveRun(ctx, id, input)))
}

/** POST /api/payroll-runs/:id/reopen — approved back to draft, until the lock day. */
export const postReopen: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollRunParamSchema, req.params)
  reply(res, 200, runDetailPayload(await approval.reopenRun(ctx, id)))
}

/** POST /api/payroll-runs/:id/mark-paid  { paidOn } — writes every payslip's PDF. */
export const postMarkPaid: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollRunParamSchema, req.params)
  const input = parseBody(markPaidSchema, req.body)
  reply(res, 200, runDetailPayload(await approval.markRunPaid(ctx, id, input)))
}

/**
 * GET /api/payroll-runs/:id/payslips/:payslipId/pdf
 *
 * The stored file once paid; before that, drawn fresh and stamped as not being
 * a payslip.
 */
export const getRunPayslipPdf: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id, payslipId } = parseBody(payslipParamSchema, req.params)
  sendPdf(res, await runPayslipPdf(ctx, id, payslipId))
}
