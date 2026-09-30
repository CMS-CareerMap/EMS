import type { Prisma } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { recordSecurityEvent, audit } from '../audit/audit.service'
import { companyToday } from '../organization/organization.service'
import {
  bankFileRows,
  DEFAULT_BANK_FILE_TEMPLATE,
  exclusionOf,
  formatAmount,
  templateProblems,
  type BankExclusion,
  type BankFileColumn,
  type BankFileDateFormat,
  type BankFileTemplate,
  type BankPayment,
} from '../../domain/payroll/bankFile'
import { runTotals } from '../../domain/payroll/run'
import { toCsv } from '../../domain/shared/csv'
import { fromDateColumn, monthKey, type CalendarDate } from '../../domain/shared/dates'
import * as bankRepo from './bankAccount.repository'
import * as runRepo from './payrollRun.repository'

/**
 * The bank transfer advice: the file Accounts uploads to the bank to pay the
 * month's salaries.
 *
 * Only from an approved or paid run — a draft's figures can still change, and
 * a file that pays last hour's figures is how somebody is paid twice. The
 * amount on each line is the payslip's net pay, never recalculated.
 *
 * Everybody left out is listed, with why, before the file is used: no account,
 * an account nobody has checked, or nothing to pay.
 */

// ── The layout ──────────────────────────────────────────────────────────────

export async function getTemplate(ctx: AppContext): Promise<BankFileTemplate & { saved: boolean }> {
  const row = await bankRepo.findTemplate(ctx.db)
  if (!row) return { ...DEFAULT_BANK_FILE_TEMPLATE, saved: false }
  return {
    columns: row.columns as unknown as BankFileColumn[],
    includeHeader: row.includeHeader,
    dateFormat: row.dateFormat as BankFileDateFormat,
    narration: row.narration,
    onlyVerified: row.onlyVerified,
    saved: true,
  }
}

export async function saveTemplate(ctx: AppContext, input: BankFileTemplate) {
  const template: BankFileTemplate = {
    ...input,
    columns: input.columns.map((column) => ({
      header: column.header.trim(),
      field: column.field,
      ...(column.field === 'fixed' ? { text: (column.text ?? '').trim() } : {}),
    })),
    narration: input.narration.trim(),
  }

  const problems = templateProblems(template)
  if (problems.length > 0) throw BadRequest(problems.join(' '), problems)

  await withTransaction(ctx.db, async (tx) => {
    await bankRepo.saveTemplate(tx, ctx.organizationId, {
      columns: template.columns as unknown as Prisma.InputJsonValue,
      includeHeader: template.includeHeader,
      dateFormat: template.dateFormat,
      narration: template.narration,
      onlyVerified: template.onlyVerified,
      updatedByUserId: ctx.userId,
    })
    await audit(ctx, {
      action: 'bank_file_template.saved',
      entityType: 'bank_file_template',
      details: { columns: template.columns.map((c) => c.field), onlyVerified: template.onlyVerified },
    }, tx)
  })

  return getTemplate(ctx)
}

// ── The file for one run ────────────────────────────────────────────────────

export interface BankFilePlan {
  run: { id: string; year: number; month: number; status: string }
  payDate: CalendarDate
  template: BankFileTemplate & { saved: boolean }
  payments: (BankPayment & { payslipId: string; employeeId: string })[]
  excluded: { payslipId: string; employeeId: string; employeeCode: string; fullName: string; netPayable: number; reason: BankExclusion }[]
  total: number
}

async function planFile(ctx: AppContext, runId: string, payDate?: CalendarDate): Promise<BankFilePlan> {
  // Bank details are their own data class: holding the payroll right is not
  // enough to read them.
  if (!ctx.can('employee:bank:read')) throw Forbidden('You do not have permission to see bank details')

  const run = await runRepo.findRun(ctx.db, runId)
  if (!run) throw NotFound('Payroll run not found')
  if (run.status === 'draft') {
    throw Conflict('Approve the payroll first. A draft can still change, and a bank file pays exactly what it says.')
  }

  const template = await getTemplate(ctx)
  const slips = await runRepo.payslipSummaries(ctx.db, runId)
  const accounts = new Map(
    (await bankRepo.accountsOf(ctx.db, slips.map((s) => s.employeeId))).map((a) => [a.employeeId, a]),
  )

  const payments: BankFilePlan['payments'] = []
  const excluded: BankFilePlan['excluded'] = []

  for (const slip of slips) {
    const account = accounts.get(slip.employeeId) ?? null
    const net = Number(slip.netPayable)
    const reason = exclusionOf({ netPayable: net, account, onlyVerified: template.onlyVerified })
    if (reason || !account) {
      excluded.push({
        payslipId: slip.id,
        employeeId: slip.employeeId,
        employeeCode: slip.employeeCode,
        fullName: slip.employeeName,
        netPayable: net,
        reason: reason ?? 'no_bank_account',
      })
      continue
    }
    payments.push({
      payslipId: slip.id,
      employeeId: slip.employeeId,
      employeeName: slip.employeeName,
      employeeCode: slip.employeeCode,
      beneficiaryName: account.accountHolderName,
      accountNumber: account.accountNumber,
      ifsc: account.ifsc,
      bankName: account.bankName,
      amount: net,
    })
  }

  const total = runTotals(
    payments.map((p) => ({ grossEarnings: 0, totalDeductions: 0, netPayable: p.amount, employerPf: 0, employerEsi: 0 })),
  ).netPayable

  return {
    run: { id: run.id, year: run.year, month: run.month, status: run.status },
    payDate: payDate ?? fromDateColumn(run.paidOn) ?? (await companyToday(ctx)),
    template,
    payments,
    excluded,
    total,
  }
}

export async function bankFilePreview(ctx: AppContext, runId: string, payDate?: CalendarDate) {
  return planFile(ctx, runId, payDate)
}

export async function bankFileCsv(ctx: AppContext, runId: string, payDate?: CalendarDate) {
  const plan = await planFile(ctx, runId, payDate)
  if (plan.payments.length === 0) {
    throw Conflict('Nobody in this payroll can be paid by bank transfer yet — see who is left out, and why.')
  }

  const rows = bankFileRows(plan.template, plan.payments, { year: plan.run.year, month: plan.run.month, payDate: plan.payDate })

  // An export of everybody's account numbers: who took it, and when.
  await recordSecurityEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    requestId: ctx.requestId,
    action: 'payroll.bank_file_downloaded',
    entityType: 'payroll_run',
    entityId: plan.run.id,
    details: { year: plan.run.year, month: plan.run.month, payments: plan.payments.length, total: formatAmount(plan.total), excluded: plan.excluded.length },
  })

  return {
    filename: `bank-transfer-${monthKey(plan.run.year, plan.run.month)}.csv`,
    bytes: Buffer.from(toCsv(rows), 'utf8'),
  }
}
