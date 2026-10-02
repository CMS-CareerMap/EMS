import type { RequestHandler } from 'express'
import * as inputs from '../../modules/payroll/payrollInputs.service'
import type { ListedDirective, EntryRow } from '../../modules/payroll/payrollInputs.repository'
import { financialYearLabel } from '../../domain/payroll/tds'
import { fromDateColumn, isoInstant } from '../../domain/shared/dates'
import {
  financialYearQuerySchema,
  monthlyEntryParamSchema,
  monthlyEntrySchema,
  payrollMonthSchema,
  tdsDirectiveSchema,
} from '../validators/payroll.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'

/**
 * What people enter before a payroll run: TDS directives and monthly entries.
 */

const reply = (res: Parameters<RequestHandler>[1], status: number, data: unknown) =>
  res.status(status).json({ data, meta: { requestId: res.locals.requestId } })

function directivePayload(row: ListedDirective) {
  return {
    id: row.id,
    employee_id: row.employee.id,
    employee_code: row.employee.employeeCode,
    full_name: row.employee.fullName,
    financial_year: row.financialYear,
    financial_year_label: financialYearLabel(row.financialYear),
    effective_from: fromDateColumn(row.effectiveFrom),
    monthly_amount: Number(row.monthlyAmount),
    reason: row.reason,
    entered_by_user_id: row.enteredByUserId,
    updated_at: isoInstant(row.updatedAt),
  }
}

function entryPayload(row: EntryRow) {
  return {
    id: row.id,
    employee_id: row.employee.id,
    employee_code: row.employee.employeeCode,
    full_name: row.employee.fullName,
    component_code: row.component.code,
    component_label: row.component.label,
    component_type: row.component.type,
    year: row.year,
    month: row.month,
    amount: Number(row.amount),
    note: row.note,
    entered_by_user_id: row.enteredByUserId,
    updated_at: isoInstant(row.updatedAt),
  }
}

/** GET /api/payroll/tds-directives?financialYear=2026 — every directive of FY 2026-27. */
export const getTdsDirectives: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { financialYear } = parseBody(financialYearQuerySchema, req.query)
  const rows = await inputs.listTdsDirectives(ctx, financialYear)
  // Whether TDS is deducted at all: Accounts cannot read Settings to find out.
  res.status(200).json({
    data: rows.map(directivePayload),
    meta: { requestId: res.locals.requestId, tds_enabled: await inputs.tdsEnabledToday(ctx) },
  })
}

/** PUT /api/payroll/tds-directives — from this month, deduct this much. */
export const putTdsDirective: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(tdsDirectiveSchema, req.body)
  reply(res, 200, directivePayload(await inputs.setTdsDirective(ctx, input)))
}

/** GET /api/payroll/monthly-entries?year=&month= */
export const getMonthlyEntries: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { year, month } = parseBody(payrollMonthSchema, req.query)
  const { entries, blocked } = await inputs.listMonthlyEntries(ctx, year, month)
  res.status(200).json({
    data: entries.map(entryPayload),
    meta: {
      requestId: res.locals.requestId,
      // People whose amounts go to somebody above them (Day 22), and whom to ask.
      blocked: blocked.map((b) => ({ employee_id: b.employeeId, own: b.own, ask: b.ask })),
    },
  })
}

/** PUT /api/payroll/monthly-entries — sets this month's amount; replaces, never adds. */
export const putMonthlyEntry: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(monthlyEntrySchema, req.body)
  reply(res, 200, entryPayload(await inputs.setMonthlyEntry(ctx, input)))
}

/** DELETE /api/payroll/monthly-entries/:id */
export const deleteMonthlyEntry: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(monthlyEntryParamSchema, req.params)
  await inputs.deleteMonthlyEntry(ctx, id)
  reply(res, 200, null)
}
