import type { RequestHandler } from 'express'
import { z } from 'zod'
import * as components from '../../modules/payroll/components.service'
import * as loans from '../../modules/payroll/loans.service'
import { componentSchema, componentUpdateSchema, loanCloseSchema, loanSchema } from '../validators/payroll.validator'
import { isoInstant } from '../../domain/shared/dates'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'

/**
 * Salary components and loans (client §40). Snake_case out, as the rest of v1.
 */

const reply = (res: Parameters<RequestHandler>[1], status: number, data: unknown, extra: object = {}) =>
  res.status(status).json({ data, meta: { requestId: res.locals.requestId, ...extra } })

const idParam = z.object({ id: z.uuid('That is not a valid id') })

type Component = Awaited<ReturnType<typeof components.listComponents>>[number]

export function componentPayload(row: Component) {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    type: row.type,
    entry: row.entry,
    counts_for_pf: row.countsForPf,
    counts_for_esi: row.countsForEsi,
    counts_for_pt: row.countsForPt,
    taxable: row.taxable,
    display_order: row.displayOrder,
    archived: row.archivedAt !== null,
  }
}

/** GET /api/payroll/components/all — archived ones too, for Settings. */
export const getAllComponents: RequestHandler = async (_req, res) => {
  reply(res, 200, (await components.listComponents(appContext(res))).map(componentPayload))
}

/** POST /api/payroll/components — adds one, or restores an archived one of that code. */
export const postComponent: RequestHandler = async (req, res) => {
  const { row, restored } = await components.addComponent(appContext(res), parseBody(componentSchema, req.body))
  reply(res, restored ? 200 : 201, componentPayload(row), { restored })
}

/** PATCH /api/payroll/components/:id */
export const patchComponent: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParam, req.params)
  reply(res, 200, componentPayload(await components.changeComponent(appContext(res), id, parseBody(componentUpdateSchema, req.body))))
}

/** DELETE /api/payroll/components/:id — archives. */
export const deleteComponent: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParam, req.params)
  reply(res, 200, componentPayload(await components.archiveComponent(appContext(res), id)))
}

function loanPayload(v: loans.LoanView) {
  return {
    id: v.row.id,
    employee_id: v.row.employeeId,
    employee_code: v.row.employee.employeeCode,
    full_name: v.row.employee.fullName,
    kind: v.row.kind,
    amount: Number(v.row.amount),
    installment: Number(v.row.installment),
    start_year: v.row.startYear,
    start_month: v.row.startMonth,
    note: v.row.note,
    recovered: v.recovered,
    in_draft: v.inDraft,
    left: v.left,
    status: v.status,
    closed_at: isoInstant(v.row.closedAt),
    closed_note: v.row.closedNote,
    recorded_at: isoInstant(v.row.createdAt),
  }
}

/** GET /api/payroll/loans */
export const getLoans: RequestHandler = async (_req, res) => {
  reply(res, 200, (await loans.listLoans(appContext(res))).map(loanPayload))
}

/** POST /api/payroll/loans */
export const postLoan: RequestHandler = async (req, res) => {
  reply(res, 201, loanPayload(await loans.recordLoan(appContext(res), parseBody(loanSchema, req.body))))
}

/** POST /api/payroll/loans/:id/close */
export const postCloseLoan: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParam, req.params)
  const { note } = parseBody(loanCloseSchema, req.body)
  reply(res, 200, loanPayload(await loans.closeLoan(appContext(res), id, note)))
}

/** DELETE /api/payroll/loans/:id — only one nothing was recovered of. */
export const deleteLoan: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParam, req.params)
  await loans.deleteLoan(appContext(res), id)
  res.status(204).end()
}
