import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { zonedToday, toDateColumn, fromDateColumn, type CalendarDate } from '../../domain/shared/dates'
import {
  workingDays,
  checkBalance,
  InvalidRangeError,
  type Weekday,
  type WorkingDaysResult,
} from '../../domain/leave/leaveDays'
import * as repo from './leave.repository'
import { companyTimezone } from '../organization/organization.service'
import { getCurrentPolicy, findLeaveType } from '../settings/settings.repository'
import { listDaysOff } from '../holidays/holidays.repository'
import { audit } from '../audit/audit.service'

/**
 * Applying for leave.
 *
 * WHEN THE BALANCE MOVES. The ledger entry is written on APPROVAL, not on
 * application — the balance should say what has actually been taken. But the
 * check when applying counts pending requests too, or somebody applies for
 * their whole entitlement three times and three different managers approve all
 * of it on the same afternoon.
 *
 * So: `available = ledger balance − pending days`. Two numbers, both honest.
 */

interface LeaveContext {
  timezone: string
  leaveYearStartMonth: number
  weeklyOffDays: Weekday[]
  holidays: CalendarDate[]
}

/** Everything the day count depends on, read once per request. */
async function leaveContext(ctx: AppContext, from: CalendarDate, to: CalendarDate): Promise<LeaveContext> {
  const [timezone, policy, holidays] = await Promise.all([
    companyTimezone(ctx),
    getCurrentPolicy(ctx.db),
    listDaysOff(ctx.db, toDateColumn(from), toDateColumn(to)),
  ])

  return {
    timezone,
    leaveYearStartMonth: policy?.leaveYearStartMonth ?? 4,
    weeklyOffDays: (policy?.weeklyOffDays ?? [0]) as Weekday[],
    holidays: holidays.map((h) => fromDateColumn(h.date)),
  }
}

/**
 * Which leave year a date falls in.
 *
 * A leave year starting in April means 2026-03-31 belongs to leave year 2025.
 * Getting this wrong moves somebody's leave into the wrong year's entitlement,
 * which is invisible until March.
 */
export function leaveYearOf(date: CalendarDate, startMonth: number): number {
  const [year, month] = date.split('-').map(Number)
  return month! >= startMonth ? year! : year! - 1
}

export interface PreviewInput {
  employeeId?: string | undefined
  leaveTypeId: string
  fromDate: CalendarDate
  toDate: CalendarDate
  halfDayDates?: CalendarDate[] | undefined
}

export interface PreviewResult {
  days: number
  breakdown: WorkingDaysResult['breakdown']
  leaveYear: number
  balance: { balance: number; pending: number; available: number; annualQuota: number }
  /** Null when the request would be accepted. */
  problem: { reason: string; message: string } | null
}

/** Whose leave this is. An employee may only ever act on their own. */
function resolveEmployee(ctx: AppContext, requested?: string): string {
  if (!requested) {
    if (!ctx.employeeId) {
      throw Forbidden('Your account has no employee record, so leave does not apply to you.')
    }
    return ctx.employeeId
  }

  // Applying on somebody else's behalf is HR's job, and needs the permission
  // that says so. Without this an employee could apply as anybody by sending
  // an id — the request would be theirs in every respect except the name.
  if (requested !== ctx.employeeId && !ctx.can('leave:approve')) {
    throw Forbidden('You can only apply for your own leave.')
  }

  return requested
}

/**
 * What a request would cost, without saving anything.
 *
 * Its own endpoint because the answer is not obvious: five calendar days can be
 * three working days, and somebody about to use three of their four remaining
 * days should see that before they commit, not after.
 */
export async function previewLeave(ctx: AppContext, input: PreviewInput): Promise<PreviewResult> {
  const employeeId = resolveEmployee(ctx, input.employeeId)
  const context = await leaveContext(ctx, input.fromDate, input.toDate)

  let counted: WorkingDaysResult
  try {
    counted = workingDays({
      from: input.fromDate,
      to: input.toDate,
      weeklyOffDays: context.weeklyOffDays,
      holidays: context.holidays,
      halfDays: input.halfDayDates ?? [],
    })
  } catch (err) {
    if (err instanceof InvalidRangeError) throw BadRequest(err.message)
    throw err
  }

  const leaveYear = leaveYearOf(input.fromDate, context.leaveYearStartMonth)

  const leaveType = await findLeaveType(ctx.db, input.leaveTypeId)
  if (!leaveType) throw NotFound('That leave type does not exist')

  const [balance, pending] = await Promise.all([
    repo.ledgerBalance(ctx.db, employeeId, input.leaveTypeId, leaveYear),
    repo.pendingDays(ctx.db, employeeId, input.leaveTypeId, leaveYear),
  ])

  const available = Math.round((balance - pending) * 2) / 2
  const annualQuota = Number(leaveType.annualQuota)

  let problem: PreviewResult['problem'] = null

  if (counted.days === 0) {
    problem = {
      reason: 'no_working_days',
      message: 'Those dates are all weekends or holidays, so there is no leave to apply for.',
    }
  } else {
    const check = checkBalance(counted.days, available, annualQuota)
    if (!check.ok) {
      problem =
        check.reason === 'no_quota'
          ? {
              reason: 'no_quota',
              message: `${leaveType.name} has no balance to draw on. It is granted rather than accrued — ask HR.`,
            }
          : {
              reason: 'insufficient',
              // The number of days short, not just "insufficient balance".
              // One is actionable; the other sends somebody to ask HR what it
              // means.
              message: `You are ${check.shortBy} day${check.shortBy === 1 ? '' : 's'} short. You have ${available} available.`,
            }
    }
  }

  // Overlaps are a problem worth seeing in the preview too.
  if (!problem) {
    const clashes = await repo.overlapping(
      ctx.db,
      employeeId,
      toDateColumn(input.fromDate),
      toDateColumn(input.toDate),
    )
    if (clashes.length > 0) {
      const clash = clashes[0]!
      problem = {
        reason: 'overlap',
        message: `That overlaps leave you already have from ${fromDateColumn(clash.fromDate)} to ${fromDateColumn(clash.toDate)}.`,
      }
    }
  }

  return {
    days: counted.days,
    breakdown: counted.breakdown,
    leaveYear,
    balance: { balance, pending, available, annualQuota },
    problem,
  }
}

export interface ApplyInput extends PreviewInput {
  reason: string
}

export async function applyForLeave(ctx: AppContext, input: ApplyInput): Promise<repo.LeaveRequestRow> {
  const employeeId = resolveEmployee(ctx, input.employeeId)
  const context = await leaveContext(ctx, input.fromDate, input.toDate)

  const today = zonedToday(new Date(), context.timezone)

  // Backdated leave is a real thing — somebody falls ill and applies on
  // returning — so this is not blocked outright. But a year in the past is a
  // typo, and the day it lands in a payroll run is the day somebody notices.
  if (input.fromDate < today) {
    const daysBack = Math.round(
      (Date.parse(today) - Date.parse(input.fromDate)) / 86_400_000,
    )
    if (daysBack > 90) {
      throw BadRequest('That start date is more than 90 days ago. Ask HR to record it for you.')
    }
  }

  // The preview does every check. Running it again here rather than trusting
  // what the client saw means a stale page cannot apply for days that were
  // available ten minutes ago.
  const preview = await previewLeave(ctx, input)

  if (preview.problem) {
    throw preview.problem.reason === 'overlap'
      ? Conflict(preview.problem.message)
      : BadRequest(preview.problem.message)
  }

  const created = await withTransaction(ctx.db, async (tx) => {
    // One application per person at a time. Re-checking inside a transaction
    // was not enough on its own: two requests sent together each read the
    // balance before the other had written, and both went in. Holding this
    // lock, the second waits and then reads what the first left behind.
    await lockFor(tx, `leave-apply:${employeeId}`)

    const held = await repo.pendingDays(tx, employeeId, input.leaveTypeId, preview.leaveYear)
    if (preview.balance.balance - held < preview.days) {
      throw Conflict('Your balance changed while you were applying. Check it and try again.')
    }

    const clash = (await repo.overlapping(tx, employeeId, toDateColumn(input.fromDate), toDateColumn(input.toDate)))[0]
    if (clash) {
      throw Conflict(
        `That overlaps leave you already have from ${fromDateColumn(clash.fromDate)} to ${fromDateColumn(clash.toDate)}.`,
      )
    }

    const request = await repo.createRequest(tx, {
      organizationId: ctx.organizationId,
      employeeId,
      leaveTypeId: input.leaveTypeId,
      fromDate: toDateColumn(input.fromDate),
      toDate: toDateColumn(input.toDate),
      halfDayDates: input.halfDayDates ?? [],
      days: preview.days,
      leaveYear: preview.leaveYear,
      reason: input.reason.trim(),
      status: 'pending',
    })

    // Somebody's own application is the request itself. One made FOR them —
    // HR applying on their behalf — is a decision about their leave by
    // somebody else, and is recorded as one.
    if (employeeId !== ctx.employeeId) {
      await audit(ctx, {
        action: 'leave.applied_for',
        entityType: 'leave_request',
        entityId: request.id,
        details: { employeeId, fromDate: input.fromDate, toDate: input.toDate, days: preview.days },
      }, tx)
    }

    return request
  })

  logger.info('Leave applied', {
    by: ctx.userId,
    employeeId,
    days: preview.days,
    leaveYear: preview.leaveYear,
  })

  const row = await repo.findRequest(ctx.db, ctx.scopeFor('leave'), created.id)
  if (!row) throw NotFound('Leave request was created but could not be read back')
  return row
}

export async function listLeave(ctx: AppContext, filters: repo.LeaveFilters = {}) {
  return repo.listRequests(ctx.db, ctx.scopeFor('leave'), filters)
}

export async function myBalances(ctx: AppContext, employeeId?: string) {
  const target = resolveEmployee(ctx, employeeId)

  const [policy, timezone] = await Promise.all([getCurrentPolicy(ctx.db), companyTimezone(ctx)])

  const today = zonedToday(new Date(), timezone)
  const leaveYear = leaveYearOf(today, policy?.leaveYearStartMonth ?? 4)

  return { leaveYear, balances: await repo.balancesFor(ctx.db, target, leaveYear) }
}

/**
 * Withdrawing a request.
 *
 * Only while it is still pending, and only your own. Once approved it has to be
 * reversed by whoever approved it (Day 14) — otherwise somebody cancels leave
 * that has already been taken and the attendance rows stop matching.
 */
export async function cancelLeave(ctx: AppContext, id: string): Promise<repo.LeaveRequestRow> {
  const request = await repo.findRequest(ctx.db, ctx.scopeFor('leave'), id)
  if (!request) throw NotFound('Leave request not found')

  if (request.employeeId !== ctx.employeeId && !ctx.can('leave:approve')) {
    throw Forbidden('You can only withdraw your own leave.')
  }

  if (request.status !== 'pending') {
    throw Conflict(
      request.status === 'approved'
        ? 'That leave has already been approved. Ask your manager to reverse it.'
        : `That request is already ${request.status}.`,
    )
  }

  // Changed only if still pending, in the same statement — an approval
  // landing at the same moment wins cleanly instead of being overwritten.
  await withTransaction(ctx.db, async (tx) => {
    const withdrawn = await repo.changeStatusIf(tx, id, 'pending', { status: 'cancelled' })
    if (!withdrawn) throw Conflict('That request was decided a moment ago. Refresh to see how.')
    await audit(ctx, {
      action: 'leave.withdrawn',
      entityType: 'leave_request',
      entityId: id,
      details: { employeeId: request.employeeId, days: Number(request.days) },
    }, tx)
  })

  logger.info('Leave withdrawn', { by: ctx.userId, requestId: id })

  const updated = await repo.findRequest(ctx.db, ctx.scopeFor('leave'), id)
  if (!updated) throw NotFound('Leave request not found')
  return updated
}
