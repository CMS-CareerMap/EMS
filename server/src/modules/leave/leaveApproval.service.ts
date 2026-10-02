import type { AppContext } from '../../platform/context'
import type { TxDb } from '../../platform/db/transaction'
import { Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { toDateColumn, fromDateColumn, type CalendarDate } from '../../domain/shared/dates'
import { workingDays, type Weekday } from '../../domain/leave/leaveDays'
import * as repo from './leave.repository'
import * as attendanceRepo from '../attendance/attendance.repository'
import { getCurrentPolicy } from '../settings/settings.repository'
import { listDaysOff } from '../holidays/holidays.repository'
import { audit } from '../audit/audit.service'
import { assertMonthsOpen, monthsBetween } from '../payroll/payrollLock.service'
import { tellApplicant } from './leaveNotices'
import { requestToAct } from './leaveApprover.service'

/**
 * Deciding on leave.
 *
 * THIS IS WHERE THE BALANCE ACTUALLY MOVES. Applying holds days; approving
 * spends them. The ledger entry is written here, in the same transaction as the
 * status change, so there is no moment where a request says approved and the
 * balance disagrees.
 *
 * Approval also writes ATTENDANCE rows for the days taken, with
 * `source = leave`. Without them a week of approved leave is a gap in the
 * attendance table, and every report has to guess whether a gap means leave,
 * a holiday, or somebody who simply never punched.
 *
 * WHO DECIDES is the company tree since Day 22, not a permission: the
 * requester's reporting manager, the Super Admin for somebody with nobody
 * above, a backup per Settings → Approvals — and nobody for the owner, whose
 * leave is recorded directly (leaveApprover.service, domain/leave/approval).
 */

async function leaveSettings(ctx: AppContext, from: CalendarDate, to: CalendarDate) {
  const [policy, holidays] = await Promise.all([
    getCurrentPolicy(ctx.db),
    listDaysOff(ctx.db, toDateColumn(from), toDateColumn(to)),
  ])

  return {
    weeklyOffDays: (policy?.weeklyOffDays ?? [0]) as Weekday[],
    holidays: holidays.map((h) => fromDateColumn(h.date)),
  }
}

/** A request as approving needs it — read before the transaction, written inside it. */
export interface ApprovableRequest {
  id: string
  employeeId: string
  leaveTypeId: string
  leaveYear: number
  days: unknown
  fromDate: Date
  toDate: Date
  halfDayDates: string[]
}

/**
 * The approval itself: the status, the days taken from the ledger, and the
 * attendance rows — in the caller's transaction, under the person's leave lock.
 * Used by an approver's decision and by the owner's leave, which is recorded
 * directly (`direct`): approved by nobody, said so in the log.
 */
export async function recordApproval(
  ctx: AppContext,
  tx: TxDb,
  request: ApprovableRequest,
  how: { note?: string | null | undefined; asBackup?: boolean; direct?: boolean },
): Promise<void> {
  const from = fromDateColumn(request.fromDate)
  const to = fromDateColumn(request.toDate)
  const settings = await leaveSettings(ctx, from, to)

  // The person's leave lock, which applications and balance corrections take
  // too: a correction reading balance and days applied for must not see this
  // request half-way from one to the other.
  await lockFor(tx, `leave-apply:${request.employeeId}`)

  // Approved only if still pending, compared and changed in one statement.
  // Two approvers clicking at the same moment — or one double click — would
  // otherwise both see `pending` and both write a ledger entry, taking the
  // days twice.
  const decided = await repo.changeStatusIf(tx, request.id, 'pending', {
    status: 'approved',
    reviewedByUserId: ctx.userId,
    reviewedAt: new Date(),
    reviewNote: how.note?.trim() || (how.direct ? 'Recorded directly: the owner’s leave needs no approval.' : null),
  })
  if (!decided) throw Conflict('Somebody else has already decided on that request.')

  // NEGATIVE days. The balance is the sum of these rows, so consuming leave
  // is an entry that subtracts — never an edit to a number somewhere.
  await repo.addLedgerEntry(tx, {
    organizationId: ctx.organizationId,
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    leaveYear: request.leaveYear,
    days: -Number(request.days),
    reason: 'consumed',
    leaveRequestId: request.id,
    createdByUserId: ctx.userId,
  })

  // Attendance for the days taken, so leave is a row rather than a gap.
  const counted = workingDays({
    from,
    to,
    weeklyOffDays: settings.weeklyOffDays,
    holidays: settings.holidays,
    halfDays: request.halfDayDates as CalendarDate[],
  })

  for (const day of counted.breakdown) {
    if (day.counted === 0) continue

    const existing = await attendanceRepo.findDay(tx, request.employeeId, toDateColumn(day.date))

    // An existing row is NOT overwritten. Somebody who punched in and then
    // had leave approved for the same day has a real punch on record, and
    // replacing it would destroy evidence of work they actually did. The
    // clash is worth a human looking at, not a silent decision.
    if (existing) {
      logger.warn('Leave day already has attendance; left as it is', {
        employeeId: request.employeeId,
        date: day.date,
        existingSource: existing.source,
      })
      continue
    }

    await attendanceRepo.createDay(tx, {
      organizationId: ctx.organizationId,
      employeeId: request.employeeId,
      date: toDateColumn(day.date),
      status: 'on_leave',
      source: 'leave',
      // Half a day of leave is half a day of work, and the hours for that
      // half are whatever they actually punched — not something this can
      // invent. Null says "not recorded", which is true.
      hoursWorked: null,
      note: day.counted === 0.5 ? 'Half day leave' : null,
      markedByUserId: ctx.userId,
    })
  }

  // In the same transaction as the decision (guide, the request lifecycle:
  // "write audit row").
  await audit(ctx, {
    action: how.direct ? 'leave.recorded_directly' : 'leave.approved',
    entityType: 'leave_request',
    entityId: request.id,
    details: {
      employeeId: request.employeeId,
      days: Number(request.days),
      fromDate: from,
      toDate: to,
      ...(how.asBackup ? { asBackup: true } : {}),
    },
  }, tx)
  if (!how.direct) await tellApplicant(ctx, tx, request.id, 'approved', how.note)
}

export async function approveLeave(
  ctx: AppContext,
  id: string,
  note?: string,
): Promise<repo.LeaveRequestRow> {
  // Who decides is the company tree; somebody who may not is told who does,
  // or — when they cannot even see the request — that it does not exist.
  const { request, asBackup } = await requestToAct(ctx, id, 'decide')

  if (request.status !== 'pending') {
    throw Conflict(`That request is already ${request.status}.`)
  }

  // Approving turns absent days into leave, and unpaid leave into loss of pay:
  // either way it changes what a signed-off month should have paid.
  await assertMonthsOpen(ctx, monthsBetween(fromDateColumn(request.fromDate), fromDateColumn(request.toDate)), 'approving this leave')

  await withTransaction(ctx.db, (tx) => recordApproval(ctx, tx, request, { note, asBackup }))

  logger.info('Leave approved', {
    by: ctx.userId,
    requestId: id,
    employeeId: request.employeeId,
    days: Number(request.days),
    asBackup,
  })

  return readBack(ctx, id)
}

export async function rejectLeave(
  ctx: AppContext,
  id: string,
  note?: string,
): Promise<repo.LeaveRequestRow> {
  const { request, asBackup } = await requestToAct(ctx, id, 'decide')

  if (request.status !== 'pending') {
    throw Conflict(`That request is already ${request.status}.`)
  }

  // No ledger entry. A rejected request never took any days, so there is
  // nothing to record against the balance — the held days are released simply
  // by no longer being pending.
  // Only if still pending, in the same statement as the change. Checked
  // separately, an approval landing at the same moment was overwritten —
  // leaving a request marked rejected whose days had been taken.
  await withTransaction(ctx.db, async (tx) => {
    const decided = await repo.changeStatusIf(tx, id, 'pending', {
      status: 'rejected',
      reviewedByUserId: ctx.userId,
      reviewedAt: new Date(),
      reviewNote: note?.trim() || null,
    })
    if (!decided) throw Conflict('Somebody else has already decided on that request.')
    await audit(ctx, {
      action: 'leave.rejected',
      entityType: 'leave_request',
      entityId: id,
      details: { employeeId: request.employeeId, days: Number(request.days), ...(asBackup ? { asBackup: true } : {}) },
    }, tx)
    await tellApplicant(ctx, tx, id, 'rejected', note)
  })

  logger.info('Leave rejected', { by: ctx.userId, requestId: id, asBackup })

  return readBack(ctx, id)
}

/**
 * Reversing an approval.
 *
 * The days come back through a REVERSING entry, not by deleting the one that
 * took them. Both facts survive: it was taken, and it was given back. Deleting
 * would leave a balance that is right and a history that cannot explain it.
 *
 * Who may: the reporting manager or the Super Admin, or only the Super Admin
 * (Settings → Approvals). Never the person whose leave it is — giving yourself
 * your days back is deciding your own leave.
 */
export async function reverseLeave(
  ctx: AppContext,
  id: string,
  note?: string,
): Promise<repo.LeaveRequestRow> {
  const { request } = await requestToAct(ctx, id, 'reverse')

  if (request.status !== 'approved') {
    throw Conflict(`Only approved leave can be reversed. That request is ${request.status}.`)
  }

  await assertMonthsOpen(
    ctx,
    monthsBetween(fromDateColumn(request.fromDate), fromDateColumn(request.toDate)),
    'reversing this leave',
  )

  await withTransaction(ctx.db, async (tx) => {
    // Reversed only if still approved — one statement, so two reversals cannot
    // both give the days back.
    const reversed = await repo.changeStatusIf(tx, id, 'approved', {
      status: 'cancelled',
      reviewedByUserId: ctx.userId,
      reviewedAt: new Date(),
      reviewNote: note?.trim() || 'Reversed after approval',
    })
    if (!reversed) throw Conflict('That request has already been changed.')

    await repo.addLedgerEntry(tx, {
      organizationId: ctx.organizationId,
      employeeId: request.employeeId,
      leaveTypeId: request.leaveTypeId,
      leaveYear: request.leaveYear,
      days: Number(request.days),
      reason: 'reversal',
      leaveRequestId: id,
      note: 'Approved leave reversed',
      createdByUserId: ctx.userId,
    })

    // Only the rows this approval created. A punch on one of those days was
    // never ours to remove.
    await attendanceRepo.deleteLeaveDays(tx, request.employeeId, request.fromDate, request.toDate)

    await audit(ctx, {
      action: 'leave.reversed',
      entityType: 'leave_request',
      entityId: id,
      details: { employeeId: request.employeeId, daysReturned: Number(request.days) },
    }, tx)
    await tellApplicant(ctx, tx, id, 'reversed', note)
  })

  logger.info('Leave reversed', { by: ctx.userId, requestId: id })

  return readBack(ctx, id)
}

/**
 * The request as it now stands, for the answer. Whoever decided it may see
 * it, whether or not their leave scope reaches it: deciding comes from the
 * tree, and the decision was theirs.
 */
async function readBack(ctx: AppContext, id: string): Promise<repo.LeaveRequestRow> {
  const updated = await repo.findRequestInCompany(ctx.db, id)
  if (!updated) throw NotFound('Leave request not found')
  return updated
}
