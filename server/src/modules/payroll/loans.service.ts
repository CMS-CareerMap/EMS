import type { LoanKind } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { employeesInScope } from '../../platform/authz/scopeWhere'
import { monthName, monthOfDay } from '../../domain/shared/dates'
import { audit } from '../audit/audit.service'
import { companyToday } from '../organization/organization.service'
import { assertWorkGoesUp } from '../organization/workRules.service'
import { assertMonthsOpen, holdPayrollFrom } from './payrollLock.service'
import * as repo from './loans.repository'

/**
 * Loans and salary advances (client §40): lent once, recovered from pay a
 * fixed amount a month until paid back.
 *
 * What is left is worked out, never stored: the amount less what payslips
 * recovered. So a draft payroll recalculated twice recovers once, and one
 * discarded recovers nothing. Finance's, within its reach on compensation —
 * and never one's own (own work goes up the company tree, Day 22).
 */

const paise = (v: number) => Math.round(v * 100) / 100

export interface LoanView {
  row: repo.LoanRow
  /** Recovered by payslips of approved or paid payrolls. */
  recovered: number
  /** Recovered by a draft payroll still being worked on. */
  inDraft: number
  /** Still owed, after both. */
  left: number
  status: 'active' | 'repaid' | 'closed'
}

function viewOf(row: repo.LoanRow): LoanView {
  const settled = row.recoveries.filter((r) => r.payslip.run.status !== 'draft').reduce((s, r) => s + Number(r.amount), 0)
  const drafted = row.recoveries.filter((r) => r.payslip.run.status === 'draft').reduce((s, r) => s + Number(r.amount), 0)
  const left = paise(Math.max(0, Number(row.amount) - settled - drafted))
  return { row, recovered: paise(settled), inDraft: paise(drafted), left, status: row.closedAt ? 'closed' : left <= 0 ? 'repaid' : 'active' }
}

const reach = (ctx: AppContext) => employeesInScope(ctx.scopeFor('compensation'))

export async function listLoans(ctx: AppContext): Promise<LoanView[]> {
  return (await repo.listLoans(ctx.db, reach(ctx))).map(viewOf)
}

export interface LoanInput {
  employeeId: string
  kind: LoanKind
  amount: number
  installment: number
  startYear: number
  startMonth: number
  note?: string | null | undefined
}

export async function recordLoan(ctx: AppContext, input: LoanInput): Promise<LoanView> {
  const person = await repo.borrower(ctx.db, input.employeeId, reach(ctx))
  if (!person) throw NotFound('Employee not found')
  // Your own loan — or that of somebody who enters salaries too — is recorded by the people above you.
  await assertWorkGoesUp(ctx, ctx.db, 'salary', input.employeeId)
  if (input.installment > input.amount) throw BadRequest('The monthly recovery cannot be more than the amount lent.')
  // Recovery starts in a month whose payroll is still open: an approved month cannot gain a deduction.
  const today = monthOfDay(await companyToday(ctx))
  if (input.startYear * 12 + input.startMonth < today.year * 12 + today.month - 1) {
    throw BadRequest(`Recovery cannot start before last month. Start it in ${monthName(today.year, today.month)} or later.`)
  }
  await assertMonthsOpen(ctx, [{ year: input.startYear, month: input.startMonth }], 'a loan recovered from that month')

  const id = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, `loans:${input.employeeId}`)
    // Again under that month's payroll lock: approved since the check above, refused rather than missed.
    await assertMonthsOpen(ctx, [{ year: input.startYear, month: input.startMonth }], 'a loan recovered from that month', tx)
    const created = await repo.createLoan(tx, {
      organizationId: ctx.organizationId,
      employeeId: input.employeeId,
      kind: input.kind,
      amount: input.amount,
      installment: input.installment,
      startYear: input.startYear,
      startMonth: input.startMonth,
      note: input.note?.trim() || null,
      createdByUserId: ctx.userId,
    })
    await audit(ctx, {
      action: 'loan.recorded',
      entityType: 'employee_loan',
      entityId: created.id,
      details: { employeeId: input.employeeId, kind: input.kind, amount: input.amount, installment: input.installment, startYear: input.startYear, startMonth: input.startMonth, note: input.note ?? null },
    }, tx)
    return created.id
  })
  logger.info('Loan recorded', { by: ctx.userId, employeeId: input.employeeId, kind: input.kind })
  return view(ctx, id)
}

async function view(ctx: AppContext, id: string): Promise<LoanView> {
  const row = await repo.findLoan(ctx.db, id)
  if (!row) throw NotFound('Loan not found')
  return viewOf(row)
}

/** Within reach, and not the caller's own to act on. */
async function loanToAct(ctx: AppContext, id: string): Promise<repo.LoanRow> {
  const row = await repo.findLoan(ctx.db, id)
  if (!row || !(await repo.borrower(ctx.db, row.employeeId, reach(ctx)))) throw NotFound('Loan not found')
  await assertWorkGoesUp(ctx, ctx.db, 'salary', row.employeeId)
  return row
}

/**
 * Stops recovering: written off, or repaid in cash. What payslips already
 * recovered stays recovered; nothing more is taken from a payroll calculated
 * after this. A draft already calculated takes it back when recalculated.
 */
export async function closeLoan(ctx: AppContext, id: string, note: string): Promise<LoanView> {
  const row = await loanToAct(ctx, id)
  if (row.closedAt) throw Conflict('This is already closed.')
  const left = viewOf(row).left
  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, `loans:${row.employeeId}`)
    // A month being approved this moment keeps the recovery it was calculated
    // with: the close waits for it, rather than landing between its check and its approval.
    await holdPayrollFrom(ctx, tx, `${row.startYear}-${String(row.startMonth).padStart(2, '0')}-01`)
    const moved = await repo.closeLoan(tx, id, { closedAt: new Date(), closedNote: note.trim(), closedByUserId: ctx.userId })
    if (moved === 0) throw Conflict('This was closed a moment ago. Reload to see it.')
    await audit(ctx, { action: 'loan.closed', entityType: 'employee_loan', entityId: id, details: { employeeId: row.employeeId, kind: row.kind, left, note: note.trim() } }, tx)
  })
  return view(ctx, id)
}

/** Removes one recorded by mistake — only while no payslip has recovered any of it. */
export async function deleteLoan(ctx: AppContext, id: string): Promise<void> {
  const row = await loanToAct(ctx, id)
  if (row.recoveries.length > 0) {
    throw Conflict('Payslips have already recovered some of this, so it cannot be removed. Close it instead.')
  }
  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, `loans:${row.employeeId}`)
    await repo.deleteLoan(tx, id)
    await audit(ctx, { action: 'loan.deleted', entityType: 'employee_loan', entityId: id, details: { employeeId: row.employeeId, kind: row.kind, amount: Number(row.amount) } }, tx)
  })
}
