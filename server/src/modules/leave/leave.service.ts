import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { tellApprovers } from './leaveNotices'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { zonedToday, toDateColumn, fromDateColumn, dayLabel, type CalendarDate } from '../../domain/shared/dates'
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
import { findApprovalRules } from '../organization/organization.repository'
import { assertMonthsOpen, monthsBetween } from '../payroll/payrollLock.service'
import { mayDecide } from '../../domain/leave/approval'
import { approvalWorld, approverNames, assertSomebodyDecides, deciderOf, peopleDecidedBy, rightsOn, type ApprovalWorld, type RequestRights } from './leaveApprover.service'
import { recordApproval } from './leaveApproval.service'
import { ruleProblem, type HalfDaySession } from '../../domain/leave/rules'
import { accruedBy, leaveYearBounds } from '../../domain/leave/grant'
import { pendingEncashDays } from '../requests/requests.repository'

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
  /** Which half of each half day (client §37). */
  halfDaySessions?: Record<CalendarDate, HalfDaySession> | undefined
}

/**
 * What of a monthly-accrual type's year is not earned yet by a day (client
 * §36): the grant less what has accrued by that day's month. Nothing for a type
 * granted yearly. Days carried in from last year are all earned already.
 */
export async function unearnedDays(
  db: AppContext['db'] | TxDb,
  employeeId: string,
  type: { id: string; accrual: 'yearly' | 'monthly' },
  leaveYear: number,
  startMonth: number,
  joined: CalendarDate | null,
  asOf: CalendarDate,
): Promise<number> {
  if (type.accrual !== 'monthly') return 0
  const grant = (await repo.openingGrants(db, employeeId, leaveYear)).get(type.id) ?? 0
  return Math.max(0, grant - accruedBy({ grant, leaveYear, startMonth, joined, asOf }))
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
async function resolveEmployee(ctx: AppContext, requested?: string): Promise<string> {
  if (!requested || requested === ctx.employeeId) {
    if (!ctx.employeeId) {
      throw Forbidden('Your account has no employee record, so leave does not apply to you.')
    }
    return ctx.employeeId
  }

  // Acting on somebody else's leave is for whoever decides it (Day 22: the
  // company tree — their reporting manager, or the Super Admin). Without this
  // an employee could apply as anybody by sending an id — the request would be
  // theirs in every respect except the name. Checked BEFORE anything is
  // written.
  const target = await repo.activeEmployee(ctx.db, { scope: 'ORGANIZATION', employeeId: ctx.employeeId }, requested)
  const world = target ? await approvalWorld(ctx.db, ctx.organizationId) : null
  if (!target || !world || !mayDecide(world.tree, world.rules, requested, deciderOf(ctx)).allowed) {
    // Out of reach reads as absent to anybody whose leave scope does not show
    // the person; to the rest, the reason.
    const visible = await repo.activeEmployee(ctx.db, ctx.scopeFor('leave'), requested)
    if (!visible) throw NotFound('Employee not found')
    throw Forbidden('You can act on the leave of the people whose leave you decide, and your own.')
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
  const employeeId = await resolveEmployee(ctx, input.employeeId)
  const context = await leaveContext(ctx, input.fromDate, input.toDate)

  const leaveType = await findLeaveType(ctx.db, input.leaveTypeId)
  if (!leaveType) throw NotFound('That leave type does not exist')

  for (const day of Object.keys(input.halfDaySessions ?? {})) {
    if (!(input.halfDayDates ?? []).includes(day)) throw BadRequest(`${day} is not one of the half days.`)
  }

  let counted: WorkingDaysResult
  try {
    // A type counted in calendar days (maternity leave) counts the weekends
    // and holidays inside it too (client §36).
    counted = workingDays({
      from: input.fromDate,
      to: input.toDate,
      weeklyOffDays: leaveType.countsNonWorkingDays ? [] : context.weeklyOffDays,
      holidays: leaveType.countsNonWorkingDays ? [] : context.holidays,
      halfDays: input.halfDayDates ?? [],
    })
  } catch (err) {
    if (err instanceof InvalidRangeError) throw BadRequest(err.message)
    throw err
  }

  const leaveYear = leaveYearOf(input.fromDate, context.leaveYearStartMonth)

  // The employee lifecycle: leave is from days of their employment — not
  // before they join, nor after their last working day.
  const window = await repo.employmentWindow(ctx.db, employeeId)
  const joined = fromDateColumn(window?.dateOfJoining)
  const lastDay = fromDateColumn(window?.lastWorkingDate)

  const [balance, pendingLeave, encashing, unearned] = await Promise.all([
    repo.ledgerBalance(ctx.db, employeeId, input.leaveTypeId, leaveYear),
    repo.pendingDays(ctx.db, employeeId, input.leaveTypeId, leaveYear),
    // Days waiting to be encashed are spoken for, as days applied for are.
    pendingEncashDays(ctx.db, employeeId, input.leaveTypeId, leaveYear),
    // Earned a month at a time: what is not earned by the month the leave starts is not there to take.
    unearnedDays(ctx.db, employeeId, leaveType, leaveYear, context.leaveYearStartMonth, joined, input.fromDate),
  ])

  const pending = pendingLeave + encashing
  const available = Math.round((balance - pending - unearned) * 2) / 2
  const annualQuota = Number(leaveType.annualQuota)

  let problem: PreviewResult['problem'] = null
  const typeProblem = ruleProblem(
    {
      name: leaveType.name,
      minNoticeDays: leaveType.minNoticeDays,
      maxDaysPerRequest: leaveType.maxDaysPerRequest === null ? null : Number(leaveType.maxDaysPerRequest),
      eligibleAfterDays: leaveType.eligibleAfterDays,
      eligibleGender: leaveType.eligibleGender,
      halfDayAllowed: leaveType.halfDayAllowed,
    },
    {
      days: counted.days,
      fromDate: input.fromDate,
      today: zonedToday(new Date(), context.timezone),
      ownApplication: employeeId === ctx.employeeId,
      joined,
      gender: window?.gender ?? null,
      halfDays: (input.halfDayDates ?? []).length,
    },
  )

  if (typeProblem) {
    problem = typeProblem
  } else if (joined && input.fromDate < joined) {
    problem = { reason: 'outside_employment', message: `That starts before the joining date, ${dayLabel(joined)}. Leave is for days of employment.` }
  } else if (lastDay && input.toDate > lastDay) {
    problem = { reason: 'outside_employment', message: `That runs past the last working day, ${dayLabel(lastDay)}. Leave is for days of employment.` }
  } else if (leaveYearOf(input.toDate, context.leaveYearStartMonth) !== leaveYear) {
    // Each leave year's days come from that year's balance. Charging a range
    // across the boundary to the year it starts in let lapsed days pay for
    // the new year's — round the carry-forward rule and its cap.
    const nextYearStarts = leaveYearBounds(leaveYear, context.leaveYearStartMonth).nextFrom
    problem = {
      reason: 'crosses_leave_year',
      message: `That runs into the next leave year, which starts on ${dayLabel(nextYearStarts)}. Apply for the days before it and from it separately — each comes from its own year's balance.`,
    }
  } else if (counted.days === 0) {
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
              message: `You are ${check.shortBy} day${check.shortBy === 1 ? '' : 's'} short. You have ${available} available${unearned > 0 ? ` by then — ${leaveType.name} is earned a month at a time` : ''}.`,
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
  const employeeId = await resolveEmployee(ctx, input.employeeId)
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

  const rules = await findApprovalRules(ctx.db, ctx.organizationId)
  const ownerApplying = Boolean(rules?.ownerEmployeeId) && rules?.ownerEmployeeId === employeeId
  // Recording the owner's leave approves it, which changes a month's pay:
  // refused, like any approval, once that month is signed off.
  if (ownerApplying) {
    await assertMonthsOpen(ctx, monthsBetween(input.fromDate, input.toDate), 'recording this leave')
  } else {
    await assertSomebodyDecides(ctx.db, await approvalWorld(ctx.db, ctx.organizationId), employeeId)
  }

  const created = await withTransaction(ctx.db, async (tx) => {
    // One application per person at a time. Re-checking inside a transaction
    // was not enough on its own: two requests sent together each read the
    // balance before the other had written, and both went in. Holding this
    // lock, the second waits and then reads what the first left behind.
    await lockFor(tx, `leave-apply:${employeeId}`)

    // Both read again under the lock: the balance too, because HR may have
    // corrected it between the preview and now.
    const [balanceNow, heldLeave, heldEncashing] = await Promise.all([
      repo.balanceOn(tx, employeeId, input.leaveTypeId, preview.leaveYear),
      repo.pendingDays(tx, employeeId, input.leaveTypeId, preview.leaveYear),
      pendingEncashDays(tx, employeeId, input.leaveTypeId, preview.leaveYear),
    ])
    const held = heldLeave + heldEncashing
    // What a monthly-accrual type has not earned yet is no more there now than in the preview.
    const unearned = preview.balance.balance - preview.balance.pending - preview.balance.available
    if (balanceNow - held - unearned < preview.days) {
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
      halfDaySessions: input.halfDaySessions ?? {},
      days: preview.days,
      leaveYear: preview.leaveYear,
      reason: input.reason.trim(),
      status: 'pending',
    })

    // Somebody's own application is the request itself. One made FOR them —
    // their manager applying on their behalf — is a decision about their
    // leave by somebody else, and is recorded as one.
    if (employeeId !== ctx.employeeId) {
      await audit(ctx, {
        action: 'leave.applied_for',
        entityType: 'leave_request',
        entityId: request.id,
        details: { employeeId, fromDate: input.fromDate, toDate: input.toDate, days: preview.days },
      }, tx)
    }

    // The owner's leave needs nobody's approval (Devesh, 1 Oct 2026): it is
    // recorded directly, in this transaction, and the log says so.
    if (ownerApplying) {
      // It checks the months again, under their payroll locks.
      await recordApproval(ctx, tx, { ...request, halfDayDates: input.halfDayDates ?? [] }, { direct: true })
    } else {
      await tellApprovers(ctx, tx, request.id, 'leave.submitted')
    }

    return request
  })

  logger.info('Leave applied', {
    by: ctx.userId,
    employeeId,
    days: preview.days,
    leaveYear: preview.leaveYear,
    recordedDirectly: ownerApplying,
  })

  // Read back whatever the caller's leave scope: a manager filing for their
  // team member may hold a leave scope of their own rows only.
  const row = await repo.findRequestInCompany(ctx.db, created.id)
  if (!row) throw NotFound('Leave request was created but could not be read back')
  return row
}

/** Requests, each with what the caller may do with it and who decides it — for the buttons a screen draws. */
export interface LeaveList {
  rows: repo.LeaveRequestRow[]
  rights: Map<string, RequestRights>
  approvers: Map<string, string>
}

async function withRights(ctx: AppContext, world: ApprovalWorld, rows: repo.LeaveRequestRow[]): Promise<LeaveList> {
  const decider = deciderOf(ctx)
  return {
    rows,
    rights: new Map(rows.map((r) => [r.id, rightsOn(world, decider, r)])),
    approvers: await approverNames(ctx.db, world, rows.map((r) => r.employeeId)),
  }
}

/** The requests the caller's leave scope shows — HR sees every one, and decides none of them. */
export async function listLeave(ctx: AppContext, filters: repo.LeaveFilters = {}): Promise<LeaveList> {
  const [rows, world] = await Promise.all([repo.listRequests(ctx.db, ctx.scopeFor('leave'), filters), approvalWorld(ctx.db, ctx.organizationId)])
  return withRights(ctx, world, rows)
}

/**
 * Team requests (Day 22): the leave of the people whose leave the caller
 * decides in the company tree — their direct reports, and for the Super Admin
 * the people with nobody above — whatever the caller's role or leave scope. An
 * Accounts head with an accountant under them gets the accountant's requests.
 *
 * `backup` is the waiting requests the caller may decide only as the stand-in
 * (Settings → Approvals), kept apart so nobody decides one by mistake.
 */
export async function teamLeave(ctx: AppContext, status?: repo.LeaveFilters['status']): Promise<LeaveList & { backup: repo.LeaveRequestRow[]; decidesFor: number }> {
  const world = await approvalWorld(ctx.db, ctx.organizationId)
  const decider = deciderOf(ctx)
  const people = peopleDecidedBy(world, decider)
  const rows = await repo.requestsOf(ctx.db, people, { status })

  // The people the caller may decide for only as the stand-in, found from the
  // tree itself — every person, asked of the same rule that decides — then
  // their waiting requests. (A count of who is below the caller used to
  // decide whether to look at all, and missed a named approver's stand-ins.)
  const standIns = world.tree.ids().filter((id) => id !== decider.employeeId && !people.includes(id) && mayDecide(world.tree, world.rules, id, decider).asBackup)
  const backup = standIns.length > 0 ? await repo.requestsOf(ctx.db, standIns, { status: 'pending' }) : []

  const listed = await withRights(ctx, world, [...rows, ...backup])
  return { ...listed, rows, backup, decidesFor: people.length }
}

export async function myBalances(ctx: AppContext, employeeId?: string) {
  const target = await resolveEmployee(ctx, employeeId)

  const [policy, timezone] = await Promise.all([getCurrentPolicy(ctx.db), companyTimezone(ctx)])

  const today = zonedToday(new Date(), timezone)
  const leaveYear = leaveYearOf(today, policy?.leaveYearStartMonth ?? 4)

  const balances = await repo.balancesFor(ctx.db, target, leaveYear)
  if (balances.some((b) => b.accrual === 'monthly')) {
    const joined = fromDateColumn((await repo.employmentWindow(ctx.db, target))?.dateOfJoining)
    for (const b of balances) {
      b.unearned = await unearnedDays(ctx.db, target, { id: b.leaveTypeId, accrual: b.accrual }, leaveYear, policy?.leaveYearStartMonth ?? 4, joined, today)
      b.available = Math.round((b.available - b.unearned) * 2) / 2
    }
  }
  return { leaveYear, balances }
}

/**
 * Withdrawing a request.
 *
 * Only while it is still pending, and only your own. Once approved it has to be
 * reversed by whoever approved it (Day 14) — otherwise somebody cancels leave
 * that has already been taken and the attendance rows stop matching.
 */
export async function cancelLeave(ctx: AppContext, id: string): Promise<repo.LeaveRequestRow> {
  // Your own, or one you may decide (Day 22: the company tree) — withdrawing a
  // request for somebody is their approver's call, not their scope's.
  const request = await repo.findRequestInCompany(ctx.db, id)
  if (!request) throw NotFound('Leave request not found')

  if (request.employeeId !== ctx.employeeId) {
    const world = await approvalWorld(ctx.db, ctx.organizationId)
    if (!mayDecide(world.tree, world.rules, request.employeeId, deciderOf(ctx)).allowed) {
      if (!(await repo.findRequest(ctx.db, ctx.scopeFor('leave'), id))) throw NotFound('Leave request not found')
      throw Forbidden('You can only withdraw your own leave.')
    }
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
    await tellApprovers(ctx, tx, id, 'leave.withdrawn')
  })

  logger.info('Leave withdrawn', { by: ctx.userId, requestId: id })

  const updated = await repo.findRequestInCompany(ctx.db, id)
  if (!updated) throw NotFound('Leave request not found')
  return updated
}
