import { randomUUID } from 'node:crypto'
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
  isUnlimited,
  splitAtBalance,
  InvalidRangeError,
  type Weekday,
  type WorkingDaysResult,
  type LeavePart,
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
import { accruedBy, leaveYearBounds, type JoinerGrant } from '../../domain/leave/grant'
import { asApplications, awayDuring, type AwayLine } from '../../domain/leave/applications'
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
 *
 * NO LIMIT, AND THE REST AS UNPAID (client, 9 Oct 2026). An unpaid type with no
 * days a year — Loss of Pay — is not counted against a balance: it needs
 * approval like any leave, and every day of it is cut from pay. Where a paid
 * type's balance runs out, the preview offers the application in two parts:
 * the earliest whole days the balance covers, and the rest as that unpaid
 * type. Taken, the parts are saved as two requests of their own types sharing
 * a group id, and are decided together (leaveApproval.service).
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
  type: { id: string; accrual: 'yearly' | 'monthly'; joinerGrant?: JoinerGrant | undefined },
  leaveYear: number,
  startMonth: number,
  joined: CalendarDate | null,
  asOf: CalendarDate,
): Promise<number> {
  if (type.accrual !== 'monthly') return 0
  const grant = (await repo.openingGrants(db, employeeId, leaveYear)).get(type.id) ?? 0
  return Math.max(0, grant - accruedBy({ grant, leaveYear, startMonth, joined, asOf, joinerGrant: type.joinerGrant }))
}

/** One part of an application split where its balance runs out — what the form shows, and what is saved. */
export interface OfferPart {
  leaveTypeId: string
  code: string
  name: string
  isPaid: boolean
  fromDate: CalendarDate
  toDate: CalendarDate
  days: number
  halfDayDates: CalendarDate[]
}

/** The application in parts, offered where the balance runs out: what it covers, then the rest unpaid. */
export interface SplitOffer {
  /** The unpaid type the rest is taken as — sent back to apply like this. */
  restLeaveTypeId: string
  message: string
  parts: OfferPart[]
}

export interface PreviewResult {
  days: number
  breakdown: WorkingDaysResult['breakdown']
  leaveYear: number
  balance: { balance: number; pending: number; available: number; annualQuota: number }
  /** Unpaid with no days a year: no balance is counted — every day is loss of pay. */
  unlimited: boolean
  /** Null when the request would be accepted. */
  problem: { reason: string; message: string } | null
  /** With a balance problem, where the rest could be taken as unpaid leave instead. */
  offer: SplitOffer | null
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

type LeaveTypeRow = NonNullable<Awaited<ReturnType<typeof findLeaveType>>>

/** What the checks need to know of the person: their employment, and their own days a year. */
interface PersonFacts {
  joined: CalendarDate | null
  lastDay: CalendarDate | null
  gender: 'male' | 'female' | 'other' | null
  confirmedOn: CalendarDate | null
  own: Map<string, number>
}

async function personFacts(db: AppContext['db'], employeeId: string): Promise<PersonFacts> {
  const [window, own] = await Promise.all([repo.employmentWindow(db, employeeId), repo.ownQuotasOf(db, [employeeId])])
  return {
    joined: fromDateColumn(window?.dateOfJoining),
    lastDay: fromDateColumn(window?.lastWorkingDate),
    gender: window?.gender ?? null,
    confirmedOn: fromDateColumn(window?.confirmedOn),
    own,
  }
}

const dayWord = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/**
 * Every check on one type over one range, for one person: the type's rules,
 * the employment, the leave year, the days counted, and the balance — not for
 * a type with no limit. Not the overlap: that is the application's, whatever
 * its parts.
 */
async function assess(
  ctx: AppContext,
  employeeId: string,
  type: LeaveTypeRow,
  range: { from: CalendarDate; to: CalendarDate; halfDays: CalendarDate[] },
  context: LeaveContext,
  person: PersonFacts,
): Promise<Omit<PreviewResult, 'offer'>> {
  let counted: WorkingDaysResult
  try {
    // A type counted in calendar days (maternity leave) counts the weekends
    // and holidays inside it too (client §36).
    counted = workingDays({
      from: range.from,
      to: range.to,
      weeklyOffDays: type.countsNonWorkingDays ? [] : context.weeklyOffDays,
      holidays: type.countsNonWorkingDays ? [] : context.holidays,
      halfDays: range.halfDays,
    })
  } catch (err) {
    if (err instanceof InvalidRangeError) throw BadRequest(err.message)
    throw err
  }

  const leaveYear = leaveYearOf(range.from, context.leaveYearStartMonth)

  const [balance, pendingLeave, encashing, unearned] = await Promise.all([
    repo.ledgerBalance(ctx.db, employeeId, type.id, leaveYear),
    repo.pendingDays(ctx.db, employeeId, type.id, leaveYear),
    // Days waiting to be encashed are spoken for, as days applied for are.
    pendingEncashDays(ctx.db, employeeId, type.id, leaveYear),
    // Earned a month at a time: what is not earned by the month the leave starts is not there to take.
    unearnedDays(ctx.db, employeeId, type, leaveYear, context.leaveYearStartMonth, person.joined, range.from),
  ])

  const pending = pendingLeave + encashing
  const available = Math.round((balance - pending - unearned) * 2) / 2
  // Their own days a year where they have them (client, 9 Oct 2026), else the type's.
  const annualQuota = person.own.get(type.id) ?? Number(type.annualQuota)
  const unlimited = isUnlimited(type.isPaid, annualQuota)

  let problem: PreviewResult['problem'] = null
  const typeProblem = ruleProblem(
    {
      name: type.name,
      minNoticeDays: type.minNoticeDays,
      maxDaysPerRequest: type.maxDaysPerRequest === null ? null : Number(type.maxDaysPerRequest),
      eligibleAfterDays: type.eligibleAfterDays,
      eligibleGender: type.eligibleGender,
      halfDayAllowed: type.halfDayAllowed,
      usableAfterConfirmation: type.usableAfterConfirmation,
    },
    {
      days: counted.days,
      fromDate: range.from,
      today: zonedToday(new Date(), context.timezone),
      ownApplication: employeeId === ctx.employeeId,
      joined: person.joined,
      gender: person.gender,
      halfDays: range.halfDays.length,
      confirmedOn: person.confirmedOn,
    },
  )

  if (typeProblem) {
    problem = typeProblem
  } else if (person.joined && range.from < person.joined) {
    problem = { reason: 'outside_employment', message: `That starts before the joining date, ${dayLabel(person.joined)}. Leave is for days of employment.` }
  } else if (person.lastDay && range.to > person.lastDay) {
    problem = { reason: 'outside_employment', message: `That runs past the last working day, ${dayLabel(person.lastDay)}. Leave is for days of employment.` }
  } else if (leaveYearOf(range.to, context.leaveYearStartMonth) !== leaveYear) {
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
  } else if (!unlimited) {
    const check = checkBalance(counted.days, available, annualQuota)
    if (!check.ok) {
      problem =
        check.reason === 'no_quota'
          ? {
              reason: 'no_quota',
              message: `${type.name} has no balance to draw on. It is granted rather than accrued — ask HR.`,
            }
          : {
              reason: 'insufficient',
              // The number of days short, not just "insufficient balance".
              // One is actionable; the other sends somebody to ask HR what it
              // means.
              message: `You are ${check.shortBy} day${check.shortBy === 1 ? '' : 's'} short. You have ${available} available${unearned > 0 ? ` by then — ${type.name} is earned a month at a time` : ''}.`,
            }
    }
  }

  return {
    days: counted.days,
    breakdown: counted.breakdown,
    leaveYear,
    balance: { balance, pending, available, annualQuota },
    unlimited,
    problem,
  }
}

const partOf = (type: LeaveTypeRow, part: LeavePart, days: number): OfferPart => ({
  leaveTypeId: type.id,
  code: type.code,
  name: type.name,
  isPaid: type.isPaid,
  fromDate: part.from,
  toDate: part.to,
  days,
  halfDayDates: part.halfDays,
})

const spanOf = (from: CalendarDate, to: CalendarDate) => (from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`)

/**
 * Where a paid balance runs out: the application in parts, if the company has
 * an unpaid type with no limit that this person may take for the rest — the
 * first such in code order whose own rules the rest passes. Null otherwise:
 * then the balance problem stands, as it always has.
 */
async function splitOffer(
  ctx: AppContext,
  employeeId: string,
  type: LeaveTypeRow,
  assessed: Omit<PreviewResult, 'offer'>,
  context: LeaveContext,
  person: PersonFacts,
): Promise<SplitOffer | null> {
  const split = splitAtBalance(assessed.breakdown, Math.max(0, assessed.balance.available))
  if (!split) return null
  for (const unpaid of await repo.unlimitedUnpaidTypes(ctx.db)) {
    if (unpaid.id === type.id) continue
    // Somebody given days of their own of it has a cap there, not "no limit".
    if (!isUnlimited(unpaid.isPaid, person.own.get(unpaid.id) ?? Number(unpaid.annualQuota))) continue
    const rest = await assess(ctx, employeeId, unpaid, { from: split.rest.from, to: split.rest.to, halfDays: split.rest.halfDays }, context, person)
    if (rest.problem || rest.days === 0) continue
    const available = assessed.balance.available
    const parts = [
      ...(split.covered ? [partOf(type, split.covered, split.covered.days)] : []),
      partOf(unpaid, split.rest, rest.days),
    ]
    const unpaidNote = `${unpaid.name} is unpaid: its days are cut from pay.`
    const message = split.covered
      ? `You have ${dayWord(available)} of ${type.name}. Take ${dayWord(split.covered.days)} as ${type.name} (${spanOf(split.covered.from, split.covered.to)}) and ${dayWord(rest.days)} as ${unpaid.name} (${spanOf(split.rest.from, split.rest.to)})? ${unpaidNote}`
      : available > 0
        ? `Your ${dayWord(available)} of ${type.name} does not cover a whole day. Apply for all ${dayWord(rest.days)} as ${unpaid.name}? ${unpaidNote}`
        : `You have no ${type.name} left. Apply for all ${dayWord(rest.days)} as ${unpaid.name}? ${unpaidNote}`
    return { restLeaveTypeId: unpaid.id, message, parts }
  }
  return null
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

  // The employee lifecycle: leave is from days of their employment — not
  // before they join, nor after their last working day.
  const person = await personFacts(ctx.db, employeeId)
  const assessed = await assess(ctx, employeeId, leaveType, { from: input.fromDate, to: input.toDate, halfDays: input.halfDayDates ?? [] }, context, person)

  let problem = assessed.problem
  const short = problem?.reason === 'insufficient' || problem?.reason === 'no_quota'
  let offer = short ? await splitOffer(ctx, employeeId, leaveType, assessed, context, person) : null

  // Overlaps are a problem worth seeing in the preview too — and they rule
  // out applying in parts as much as applying whole.
  if (!problem || offer) {
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
      offer = null
    }
  }

  return { ...assessed, problem, offer }
}

export interface ApplyInput extends PreviewInput {
  reason: string
  /**
   * Apply as the preview offered: the days the balance covers, and the rest as
   * this unpaid type. Left out, it is applied for whole, or refused.
   */
  restLeaveTypeId?: string | undefined
  /** The days the offer shown covered with the type asked for — 0 when none. */
  coveredDays?: number | undefined
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
  const refused = (problem: NonNullable<PreviewResult['problem']>) =>
    problem.reason === 'overlap' ? Conflict(problem.message) : BadRequest(problem.message)

  // In parts only as the preview offers them now: the same unpaid type, the
  // same days covered. Anything else changed since the form was filled in.
  const inParts = Boolean(input.restLeaveTypeId)
  if (inParts) {
    if (!preview.offer || preview.offer.restLeaveTypeId !== input.restLeaveTypeId) {
      if (preview.problem?.reason === 'overlap') throw refused(preview.problem)
      throw Conflict(preview.problem
        ? 'That can no longer be taken in parts. Check the form and try again.'
        : 'Your balance changed: it now covers all of these days. Apply for them as they are.')
    }
    const covered = preview.offer.parts.find((p) => p.leaveTypeId === input.leaveTypeId)?.days ?? 0
    if (covered !== input.coveredDays) {
      throw Conflict('Your balance changed while you were applying. Check it and try again.')
    }
  } else if (preview.problem) {
    throw refused(preview.problem)
  }
  // What is saved: each part as its own request — or the application whole, as asked.
  const parts: Pick<OfferPart, 'leaveTypeId' | 'fromDate' | 'toDate' | 'days' | 'halfDayDates'>[] = inParts
    ? preview.offer!.parts
    : [{ leaveTypeId: input.leaveTypeId, fromDate: input.fromDate, toDate: input.toDate, days: preview.days, halfDayDates: input.halfDayDates ?? [] }]

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
    // corrected it between the preview and now. Only for the type asked for:
    // the rest, in parts, is a type with no limit.
    if (!preview.unlimited) {
      const [balanceNow, heldLeave, heldEncashing] = await Promise.all([
        repo.balanceOn(tx, employeeId, input.leaveTypeId, preview.leaveYear),
        repo.pendingDays(tx, employeeId, input.leaveTypeId, preview.leaveYear),
        pendingEncashDays(tx, employeeId, input.leaveTypeId, preview.leaveYear),
      ])
      const held = heldLeave + heldEncashing
      // What a monthly-accrual type has not earned yet is no more there now than in the preview.
      const unearned = preview.balance.balance - preview.balance.pending - preview.balance.available
      const availableNow = Math.round((balanceNow - held - unearned) * 2) / 2
      // In parts, the split was worked out from that number: any change and it would split elsewhere.
      if (inParts ? availableNow !== preview.balance.available : availableNow < preview.days) {
        throw Conflict('Your balance changed while you were applying. Check it and try again.')
      }
    }

    const clash = (await repo.overlapping(tx, employeeId, toDateColumn(input.fromDate), toDateColumn(input.toDate)))[0]
    if (clash) {
      throw Conflict(
        `That overlaps leave you already have from ${fromDateColumn(clash.fromDate)} to ${fromDateColumn(clash.toDate)}.`,
      )
    }

    const groupId = parts.length > 1 ? randomUUID() : null
    const sessions = input.halfDaySessions ?? {}
    const requests = []
    for (const part of parts) {
      requests.push(await repo.createRequest(tx, {
        organizationId: ctx.organizationId,
        employeeId,
        leaveTypeId: part.leaveTypeId,
        fromDate: toDateColumn(part.fromDate),
        toDate: toDateColumn(part.toDate),
        halfDayDates: part.halfDayDates,
        halfDaySessions: Object.fromEntries(Object.entries(sessions).filter(([day]) => part.halfDayDates.includes(day))),
        days: part.days,
        leaveYear: preview.leaveYear,
        reason: input.reason.trim(),
        status: 'pending',
        groupId,
      }))
    }
    const lead = requests[0]!

    // Somebody's own application is the request itself. One made FOR them —
    // their manager applying on their behalf — is a decision about their
    // leave by somebody else, and is recorded as one.
    if (employeeId !== ctx.employeeId) {
      await audit(ctx, {
        action: 'leave.applied_for',
        entityType: 'leave_request',
        entityId: lead.id,
        details: { employeeId, fromDate: input.fromDate, toDate: input.toDate, days: parts.reduce((a, p) => a + p.days, 0), ...(groupId ? { groupId } : {}) },
      }, tx)
    }

    // The owner's leave needs nobody's approval (Devesh, 1 Oct 2026): it is
    // recorded directly, in this transaction, and the log says so.
    if (ownerApplying) {
      // It checks the months again, under their payroll locks.
      for (const request of requests) await recordApproval(ctx, tx, { ...request, halfDayDates: request.halfDayDates }, { direct: true })
    } else {
      // One notice for the application, whatever its parts.
      await tellApprovers(ctx, tx, lead.id, 'leave.submitted')
    }

    return lead
  })

  logger.info('Leave applied', {
    by: ctx.userId,
    employeeId,
    days: parts.reduce((a, p) => a + p.days, 0),
    parts: parts.length,
    leaveYear: preview.leaveYear,
    recordedDirectly: ownerApplying,
  })

  // Read back whatever the caller's leave scope: a manager filing for their
  // team member may hold a leave scope of their own rows only.
  const row = await repo.findRequestInCompany(ctx.db, created.id)
  if (!row) throw NotFound('Leave request was created but could not be read back')
  return row
}

/**
 * Every part of the application a request belongs to, earliest first — just
 * the request, for an application of one type. What the answer to an act on
 * it shows.
 */
export async function partsOf(ctx: AppContext, row: repo.LeaveRequestRow): Promise<repo.LeaveRequestRow[]> {
  return row.groupId ? repo.groupParts(ctx.db, row.groupId) : [row]
}

/** Requests, each with what the caller may do with it and who decides it — for the buttons a screen draws. */
export interface LeaveList {
  rows: repo.LeaveRequestRow[]
  rights: Map<string, RequestRights>
  approvers: Map<string, string>
  /** For a waiting application, by its first part's id: who else of the person's team is away on its days. */
  away?: Map<string, AwayLine[]>
}

/**
 * Who else of each asker's team — the people with the same reporting manager
 * — is away on the days a waiting application asks for (client, 10 Oct 2026):
 * so whoever decides it sees, before deciding, that half the team would be
 * out. Read in two queries for the whole list, however long.
 */
async function awayFor(ctx: AppContext, rows: readonly repo.LeaveRequestRow[]): Promise<Map<string, AwayLine[]>> {
  const waiting = asApplications(rows.filter((r) => r.status === 'pending'), (r) => fromDateColumn(r.fromDate)!)
  const away = new Map<string, AwayLine[]>()
  const managers = [...new Set(waiting.map((a) => a.lead.employee.reportingManagerId).filter((m): m is string => Boolean(m)))]
  if (managers.length === 0) return away
  const teams = await repo.teamsOf(ctx.db, managers)
  const from = waiting.map((a) => fromDateColumn(a.lead.fromDate)!).sort()[0]!
  const to = waiting.map((a) => fromDateColumn(a.parts[a.parts.length - 1]!.toDate)!).sort().at(-1)!
  const leave = (await repo.leaveAround(ctx.db, teams.map((t) => t.id), toDateColumn(from), toDateColumn(to))).map((l) => ({
    id: l.id,
    employeeId: l.employeeId,
    groupId: l.groupId,
    status: l.status as 'pending' | 'approved',
    from: fromDateColumn(l.fromDate)!,
    to: fromDateColumn(l.toDate)!,
    typeName: l.leaveType.name,
  }))
  for (const application of waiting) {
    const asker = application.lead.employee
    if (!asker.reportingManagerId) continue
    const team = new Map(teams.filter((t) => t.reportingManagerId === asker.reportingManagerId && t.id !== asker.id).map((t) => [t.id, t.fullName]))
    const range = { from: fromDateColumn(application.lead.fromDate)!, to: fromDateColumn(application.parts[application.parts.length - 1]!.toDate)! }
    away.set(application.lead.id, awayDuring(range, team, leave))
  }
  return away
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

  const [listed, away] = await Promise.all([withRights(ctx, world, [...rows, ...backup]), awayFor(ctx, [...rows, ...backup])])
  return { ...listed, rows, backup, decidesFor: people.length, away }
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
      b.unearned = await unearnedDays(ctx.db, target, { id: b.leaveTypeId, accrual: b.accrual, joinerGrant: b.joinerGrant }, leaveYear, policy?.leaveYearStartMonth ?? 4, joined, today)
      b.available = Math.round((b.available - b.unearned) * 2) / 2
    }
  }
  return { leaveYear, balances }
}

export interface StatementLine {
  id: string
  at: Date
  reason: string
  days: number
  note: string | null
  /** The leave it came from, for days taken or given back. */
  fromDate: CalendarDate | null
  toDate: CalendarDate | null
  /** The balance after this line. */
  balance: number
}

/**
 * One person's statement of one leave type for a leave year (client, 10 Oct
 * 2026): every movement in the balance — given for the year, carried, taken,
 * given back, corrected by HR (with the reason), encashed — oldest first, the
 * balance after each, like a passbook. Read from the ledger, which is the
 * balance: the last line's balance is the balance. A zero-day line (a type's
 * days left for next year) moves nothing and is left out.
 */
export async function statementFor(db: AppContext['db'], employeeId: string, leaveTypeId: string, leaveYear: number) {
  const [type, own] = await Promise.all([repo.leaveTypeById(db, leaveTypeId), repo.ownQuotasOf(db, [employeeId])])
  if (!type) throw NotFound('That leave type does not exist')
  let balance = 0
  // Taken: approved, less any given back — as Leave Balance counts it (balancesFor).
  let taken = 0
  const lines: StatementLine[] = []
  for (const row of await repo.ledgerOf(db, employeeId, leaveTypeId, leaveYear)) {
    const days = Number(row.days)
    if (days === 0) continue
    balance = Math.round((balance + days) * 2) / 2
    if (row.reason === 'consumed' || row.reason === 'reversal') taken = Math.round((taken - days) * 2) / 2
    lines.push({
      id: row.id,
      at: row.createdAt,
      reason: row.reason,
      days,
      note: row.note,
      fromDate: fromDateColumn(row.leaveRequest?.fromDate),
      toDate: fromDateColumn(row.leaveRequest?.toDate),
      balance,
    })
  }
  // The person's own days a year, where they have them, decide it — as on Leave Balance and the profile.
  const quota = own.get(`${employeeId}|${leaveTypeId}`) ?? Number(type.annualQuota)
  return { type, leaveYear, balance, taken, lines, unlimited: isUnlimited(type.isPaid, quota) }
}

/** The caller's own statement — or that of somebody whose leave they decide — for a type and leave year (this one when left out). */
export async function myStatement(ctx: AppContext, input: { employeeId?: string | undefined; leaveTypeId: string; leaveYear?: number | undefined }) {
  const employeeId = await resolveEmployee(ctx, input.employeeId)
  const [policy, timezone] = await Promise.all([getCurrentPolicy(ctx.db), companyTimezone(ctx)])
  const startMonth = policy?.leaveYearStartMonth ?? 4
  const leaveYear = input.leaveYear ?? leaveYearOf(zonedToday(new Date(), timezone), startMonth)
  return { ...(await statementFor(ctx.db, employeeId, input.leaveTypeId, leaveYear)), startMonth }
}

/**
 * Withdrawing a request.
 *
 * Only while it is still pending, and only your own. Once approved it has to be
 * reversed by whoever approved it (Day 14) — otherwise somebody cancels leave
 * that has already been taken and the attendance rows stop matching. An
 * application in parts is withdrawn whole.
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

  const parts = (await partsOf(ctx, request)).filter((p) => p.status === 'pending')
  if (parts.length === 0) throw Conflict('That request was decided a moment ago. Refresh to see how.')

  // Changed only if still pending, in the same statement — an approval
  // landing at the same moment wins cleanly instead of being overwritten.
  await withTransaction(ctx.db, async (tx) => {
    for (const part of parts) {
      const withdrawn = await repo.changeStatusIf(tx, part.id, 'pending', { status: 'cancelled' })
      if (!withdrawn) throw Conflict('That request was decided a moment ago. Refresh to see how.')
      await audit(ctx, {
        action: 'leave.withdrawn',
        entityType: 'leave_request',
        entityId: part.id,
        details: { employeeId: request.employeeId, days: Number(part.days) },
      }, tx)
    }
    await tellApprovers(ctx, tx, parts[0]!.id, 'leave.withdrawn')
  })

  logger.info('Leave withdrawn', { by: ctx.userId, requestId: id, parts: parts.length })

  const updated = await repo.findRequestInCompany(ctx.db, id)
  if (!updated) throw NotFound('Leave request not found')
  return updated
}
