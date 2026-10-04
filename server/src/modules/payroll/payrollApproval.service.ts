import type { AppContext } from '../../platform/context'
import { BadRequest, BusinessRule, Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { payDecidedSince } from '../requests/requests.repository'
import { logger } from '../../platform/logger'
import { storage, storageKey } from '../../platform/storage'
import { audit } from '../audit/audit.service'
import { notify } from '../notifications/notify.service'
import { companyToday } from '../organization/organization.service'
import { reopenAllowed } from '../../domain/payroll/runStatus'
import { payslipDifferences, runTotals, type ComparablePayslip } from '../../domain/payroll/run'
import { addressOf } from '../../domain/payroll/payslipView'
import { monthKey, monthName, toDateColumn, type CalendarDate } from '../../domain/shared/dates'
import { assertCan, buildPayslips, getRun, planMonth, runLock, who } from './payrollRun.service'
import { renderSlip, sha256, viewInputOf } from './payslip.service'
import * as repo from './payrollRun.repository'

/**
 * Signing a payroll off, and recording that it was paid (guide, Day 17).
 *
 * APPROVE checks the figures are still true before anybody signs them: the
 * month is worked out again from the records as they stand, and if a single
 * payslip would come out differently the approval is refused with who and
 * what. Then it asks about the days payroll had no record for — counted as
 * paid, and only approved once somebody has said they accept that. Then it
 * copies what the payslips will print — the employer, each person's UAN, PF,
 * ESIC and PAN — so the documents say what was true on the day.
 *
 * MARK PAID writes every payslip's PDF to storage, content-hashed, and only
 * then moves the run: a paid run whose documents do not exist cannot happen.
 */

/** People rendered at once when a run is paid. */
const CONCURRENCY = 4

const FIGURES = [
  'grossEarnings',
  'pfWages',
  'employeePf',
  'employeeEsi',
  'professionalTax',
  'tds',
  'otherDeductions',
  'totalDeductions',
  'netPayable',
  'employerPf',
  'employerEps',
  'employerEpf',
  'employerEsi',
  'lopDays',
  'paidDays',
  'payableDays',
  'payBasisDays',
] as const

function comparable(slip: {
  employeeId: string
  employeeName: string
  lines: readonly { kind: string; code: string; amount: unknown }[]
} & Record<(typeof FIGURES)[number], unknown>): ComparablePayslip {
  return {
    employeeId: slip.employeeId,
    employeeName: slip.employeeName,
    figures: Object.fromEntries(FIGURES.map((key) => [key, Number(slip[key])])),
    lines: slip.lines.map((line) => ({ kind: line.kind, code: line.code, amount: Number(line.amount) })),
  }
}

export interface ApproveInput {
  /** "I have seen the days counted as paid with nothing recorded, and accept them." */
  confirmAssumedDays?: boolean | undefined
}

export async function approveRun(ctx: AppContext, id: string, input: ApproveInput = {}) {
  const run = await repo.findRun(ctx.db, id)
  if (!run) throw NotFound('Payroll run not found')
  assertCan(run, 'approve')

  const label = monthName(run.year, run.month)

  // 1. The figures on the page must still be what the records say.
  const plan = await planMonth(ctx, run.year, run.month)
  const fresh = await buildPayslips(ctx, plan)
  const stored = await repo.payslipsWithLines(ctx.db, id)

  const changed = payslipDifferences(stored.map(comparable), fresh.map(comparable))
  if (changed.length > 0) {
    throw BusinessRule(
      `The records behind the ${label} payroll have changed since it was calculated. Recalculate it, check the figures, then approve.`,
      {
        changed: changed.map((c) => ({
          employee_id: c.employeeId,
          full_name: c.employeeName,
          change: c.change,
          fields: c.fields,
        })),
      },
    )
  }

  // 2. The days paid for on no record at all.
  const assumed = plan.people
    .map((person) => ({
      employee: who(person.employee),
      unmarked: person.lop?.unmarked ?? [],
      notYet: person.lop?.notYet ?? [],
      markedLeave: person.lop?.markedLeave ?? [],
    }))
    .filter((a) => a.unmarked.length + a.notYet.length + a.markedLeave.length > 0)
  const assumedDays = assumed.reduce((n, a) => n + a.unmarked.length + a.notYet.length + a.markedLeave.length, 0)

  if (assumedDays > 0 && !input.confirmAssumedDays) {
    throw BusinessRule(
      `${assumedDays === 1 ? 'One day' : `${assumedDays} days`} in ${label} ${assumedDays === 1 ? 'was' : 'were'} counted as paid with no attendance behind ${assumedDays === 1 ? 'it' : 'them'}. Check them — mark what was not worked and recalculate — or approve again confirming you accept them.`,
      {
        assumed_days: assumedDays,
        confirm_with: 'confirmAssumedDays',
        employees: assumed.map((a) => ({
          employee_id: a.employee.id,
          employee_code: a.employee.employeeCode,
          full_name: a.employee.fullName,
          unmarked_days: a.unmarked,
          days_not_yet_happened: a.notYet,
          marked_on_leave_without_request: a.markedLeave,
        })),
      },
    )
  }

  // 3. What the payslips will print, as it is today.
  const employer = await repo.findEmployer(ctx.db, ctx.organizationId)
  const employerName = employer?.legalName || employer?.name || ''
  const employerAddress = employer ? addressOf(employer) : null
  const identities = new Map(
    (await repo.identitiesOf(ctx.db, stored.map((slip) => slip.employeeId))).map((row) => [row.employeeId, row]),
  )

  // Totals recomputed from the payslips themselves, never carried over.
  const totals = runTotals(
    stored.map((slip) => ({
      grossEarnings: Number(slip.grossEarnings),
      totalDeductions: Number(slip.totalDeductions),
      netPayable: Number(slip.netPayable),
      employerPf: Number(slip.employerPf),
      employerEsi: Number(slip.employerEsi),
    })),
  )

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, runLock(ctx, run.year, run.month))

    // Recalculated while this was checking: the payslips just compared are gone.
    const current = await repo.findRunForMonth(tx, run.year, run.month)
    if (!current || current.id !== id) throw NotFound('Payroll run not found')
    if (current.calculatedAt.getTime() !== run.calculatedAt.getTime()) {
      throw Conflict('The draft was recalculated a moment ago. Check the new figures, then approve.')
    }
    // Overtime or an encashment approved for this month since it was
    // calculated is not in these payslips: recalculated first, it is paid.
    if ((await payDecidedSince(tx, run.year, run.month, current.calculatedAt)) > 0) {
      throw Conflict('Overtime or a leave encashment for this month was approved after it was calculated. Recalculate, check the figures, then approve.')
    }

    const moved = await repo.moveRunIf(tx, id, 'draft', {
      status: 'approved',
      approvedAt: new Date(),
      approvedByUserId: ctx.userId,
      assumedDays,
      employerName,
      employerAddress,
      employeeCount: totals.employeeCount,
      grossEarnings: totals.grossEarnings,
      totalDeductions: totals.totalDeductions,
      netPayable: totals.netPayable,
      employerPf: totals.employerPf,
      employerEsi: totals.employerEsi,
    })
    if (moved === 0) throw Conflict('Somebody changed this payroll a moment ago. Refresh to see where it stands.')

    for (const slip of stored) {
      const identity = identities.get(slip.employeeId)
      await repo.updatePayslip(tx, slip.id, {
        uan: identity?.uan ?? null,
        pfMemberId: identity?.pfAccountNumber ?? null,
        esicNumber: identity?.esiNumber ?? null,
        pan: identity?.pan ?? null,
      })
    }

    await audit(ctx, {
      action: 'payroll.run_approved',
      entityType: 'payroll_run',
      entityId: id,
      details: {
        year: run.year,
        month: run.month,
        employees: totals.employeeCount,
        netPayable: totals.netPayable,
        assumedDays,
        confirmedAssumedDays: assumedDays > 0,
        createdByUserId: run.createdByUserId,
      },
    }, tx)

    await notify(ctx, tx, {
      event: 'payroll.approved',
      to: { holding: 'payroll:run:create' },
      title: 'Payroll approved',
      message: `The ${label} payroll is approved. Take the bank file, pay it, then mark it paid.`,
      link: '/payroll',
      entity: { type: 'payroll_run', id },
    })
  })

  logger.info('Payroll run approved', { by: ctx.userId, runId: id, month: monthKey(run.year, run.month), assumedDays })
  return getRun(ctx, id)
}

/**
 * Back to draft, while it is only approved and the company's lock day has not
 * passed. Everything approval copied is forgotten; approving again copies it
 * afresh.
 */
export async function reopenRun(ctx: AppContext, id: string) {
  const run = await repo.findRun(ctx.db, id)
  if (!run) throw NotFound('Payroll run not found')
  assertCan(run, 'reopen')

  const today = await companyToday(ctx)
  const rules = await repo.lockDayOn(ctx.db, toDateColumn(today))
  const lockDay = rules?.payslipLockDay ?? null
  if (!reopenAllowed({ year: run.year, month: run.month, payslipLockDay: lockDay, today })) {
    throw Conflict(
      `The ${monthName(run.year, run.month)} payroll locked on day ${lockDay} of the following month and can no longer be reopened.`,
    )
  }

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, runLock(ctx, run.year, run.month))
    const moved = await repo.moveRunIf(tx, id, 'approved', {
      status: 'draft',
      approvedAt: null,
      approvedByUserId: null,
      assumedDays: null,
      employerName: null,
      employerAddress: null,
    })
    if (moved === 0) throw Conflict('Somebody changed this payroll a moment ago. Refresh to see where it stands.')

    await repo.clearApprovalCopies(tx, id)
    await audit(ctx, {
      action: 'payroll.run_reopened',
      entityType: 'payroll_run',
      entityId: id,
      details: { year: run.year, month: run.month, approvedByUserId: run.approvedByUserId },
    }, tx)
  })

  logger.warn('Payroll run reopened', { by: ctx.userId, runId: id, month: monthKey(run.year, run.month) })
  return getRun(ctx, id)
}

export interface MarkPaidInput {
  /** The day the salaries were credited. */
  paidOn: CalendarDate
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

/**
 * The money has gone. Every payslip becomes a stored, hashed PDF, and the run
 * becomes a record nothing can move.
 *
 * Files first, then the rows, in one transaction. A file is named by its own
 * hash, so a second attempt — or two accountants at once — writes new names
 * instead of overwriting the file a winning attempt already points at; the
 * loser's files are simply never referenced.
 */
export async function markRunPaid(ctx: AppContext, id: string, input: MarkPaidInput) {
  const run = await repo.findRun(ctx.db, id)
  if (!run) throw NotFound('Payroll run not found')
  assertCan(run, 'mark_paid')

  const monthStart = `${monthKey(run.year, run.month)}-01`
  const today = await companyToday(ctx)
  if (input.paidOn < monthStart) {
    throw BadRequest(`The ${monthName(run.year, run.month)} payroll cannot have been paid before the month began.`)
  }
  if (input.paidOn > today) {
    throw BadRequest('A payment is recorded once it has been made — that day has not come yet.')
  }

  const stored = await repo.payslipsWithLines(ctx.db, id)
  const employer = { name: run.employerName ?? '', address: run.employerAddress }
  const createdAt = toDateColumn(input.paidOn)

  const files = await inBatches(stored, CONCURRENCY, async (slip) => {
    const { bytes } = await renderSlip(
      viewInputOf(slip, {
        status: 'paid',
        payDate: input.paidOn,
        employer,
        identifiers: { uan: slip.uan, pfMemberId: slip.pfMemberId, esicNumber: slip.esicNumber, pan: slip.pan },
      }),
      createdAt,
    )
    const hash = sha256(bytes)
    const key = storageKey({
      organizationId: ctx.organizationId,
      kind: 'payslip',
      ownerId: slip.employeeId,
      fileId: `${slip.id}-${hash.slice(0, 16)}`,
      extension: 'pdf',
    })
    await storage().put(key, bytes, 'application/pdf')
    return { payslipId: slip.id, key, hash, size: bytes.length }
  })

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, runLock(ctx, run.year, run.month))

    // Reopened and approved again while the files were being written: they
    // were drawn from payslips that no longer exist.
    const current = await repo.findRunForMonth(tx, run.year, run.month)
    if (!current || current.id !== id) throw NotFound('Payroll run not found')
    if (current.approvedAt?.getTime() !== run.approvedAt?.getTime()) {
      throw Conflict('The payroll was reopened a moment ago. Check it, then record the payment again.')
    }

    const moved = await repo.moveRunIf(tx, id, 'approved', {
      status: 'paid',
      paidOn: toDateColumn(input.paidOn),
      paidAt: new Date(),
      paidByUserId: ctx.userId,
    })
    if (moved === 0) throw Conflict('Somebody changed this payroll a moment ago. Refresh to see where it stands.')

    const now = new Date()
    for (const file of files) {
      await repo.updatePayslip(tx, file.payslipId, {
        pdfKey: file.key,
        pdfSha256: file.hash,
        pdfBytes: file.size,
        pdfGeneratedAt: now,
      })
    }

    await audit(ctx, {
      action: 'payroll.run_paid',
      entityType: 'payroll_run',
      entityId: id,
      details: {
        year: run.year,
        month: run.month,
        employees: run.employeeCount,
        netPayable: Number(run.netPayable),
        paidOn: input.paidOn,
      },
    }, tx)

    // Each employee with a login hears that their payslip is there — linking
    // to their own page, not /payroll, which is not theirs to open.
    await notify(ctx, tx, {
      event: 'payslip.ready',
      to: { employees: stored.map((slip) => slip.employeeId) },
      title: 'Your payslip is ready',
      message: `Your payslip for ${monthName(run.year, run.month)} is ready to download.`,
      link: '/payslips',
      entity: { type: 'payroll_run', id },
    })
  })

  logger.info('Payroll run paid', { by: ctx.userId, runId: id, month: monthKey(run.year, run.month), payslips: files.length })
  return getRun(ctx, id)
}
