import type { AppContext } from '../../platform/context'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { BusinessRule, Conflict, NotFound } from '../../platform/errors/AppError'
import { logger } from '../../platform/logger'
import { dayLabel, fromDateColumn, zonedToday } from '../../domain/shared/dates'
import { leaveYearBounds, leaveYearLabel, toHalfDays, type GrantEntry } from '../../domain/leave/grant'
import { isUnlimited } from '../../domain/leave/leaveDays'
import { getCurrentPolicy } from '../settings/settings.repository'
import { companyTimezone } from '../organization/organization.service'
import { audit } from '../audit/audit.service'
import { notify } from '../notifications/notify.service'
import { leaveYearOf } from './leave.service'
import * as repo from './leave.repository'
import { assertWorkGoesUp, checkWork, loadWork } from '../organization/workRules.service'
import { approvalWorld, deciderOf, peopleDecidedBy } from './leaveApprover.service'
import { pendingEncashDays } from '../requests/requests.repository'
import { grantLock, grantSummary, planYearFor } from './leaveEntitlement.service'

/**
 * Leave → Team Balances: everybody's balances, the year's grant, and
 * corrections.
 *
 * Before this, a leave year could only be granted from the server's terminal
 * (`npm run grant-leave`), so an employee added in the app had a balance of
 * zero and could not apply for a day — and a balance could not be corrected at
 * all. Both are now HR's, from the page, by the same rules the terminal uses
 * (domain/leave/grant.ts).
 *
 * Seeing balances follows the leave scope: HR and the Super Admin see the
 * company, a manager their own team. Granting and correcting are
 * `leave:balance:manage` — Super Admin and HR.
 */

interface YearContext {
  leaveYear: number
  startMonth: number
  current: number
  today: string
}

/** The leave year asked about, or today's. Only this year and next may be looked at or granted. */
async function yearFor(ctx: AppContext, requested?: number): Promise<YearContext> {
  const [policy, timezone] = await Promise.all([getCurrentPolicy(ctx.db), companyTimezone(ctx)])
  const startMonth = policy?.leaveYearStartMonth ?? 4
  const today = zonedToday(new Date(), timezone)
  const current = leaveYearOf(today, startMonth)
  const leaveYear = requested ?? current
  if (leaveYear !== current && leaveYear !== current + 1) {
    throw BusinessRule(`Only this leave year (${leaveYearLabel(current, startMonth)}) or the next can be shown or changed here.`)
  }
  return { leaveYear, startMonth, current, today }
}

const sumOf = (value: { _sum: { days: unknown } }) => Number(value._sum.days ?? 0)

/**
 * What a grant of this year would add now, for everybody the caller's leave
 * scope reaches — the whole company for HR. A role given grants over its team
 * (Day 21) grants its team's; the rest wait for somebody wider, and nothing is
 * granted twice either way. The plan itself is the one every grant uses
 * (leaveEntitlement.service): own days a year, the joiner rule, carry forward.
 */
async function planFor(db: AppContext['db'] | TxDb, ctx: AppContext, year: YearContext) {
  const people = await repo.peopleInScope(db, ctx.scopeFor('leave'))
  const { entries, types } = await planYearFor(db, people, year)
  return { entries, people, types }
}

const summaryOf = grantSummary

/** Said to somebody told of a grant or a correction: when they will see it. */
function whenItShows(year: YearContext): string {
  if (year.leaveYear <= year.current) return 'Leave → Leave Balance shows each type.'
  return `It shows in Leave → Leave Balance when the ${leaveYearLabel(year.leaveYear, year.startMonth)} leave year begins on ${dayLabel(leaveYearBounds(year.leaveYear, year.startMonth).from)}.`
}

const dayCount = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/** Everybody this person may see, with each leave type's balance, days applied for, and what is left to apply for. */
export async function teamBalances(ctx: AppContext, requestedYear?: number) {
  const year = await yearFor(ctx, requestedYear)
  // The people the leave scope reaches, and those whose leave the caller decides.
  const world = await approvalWorld(ctx.db, ctx.organizationId)
  const people = await repo.peopleInScope(ctx.db, ctx.scopeFor('leave'), peopleDecidedBy(world, deciderOf(ctx)))
  const ids = people.map((p) => p.id)
  const [types, ledger, pending, takenRows, own] = await Promise.all([
    repo.activeLeaveTypes(ctx.db),
    repo.ledgerTotals(ctx.db, ids, year.leaveYear),
    repo.pendingTotals(ctx.db, ids, year.leaveYear),
    repo.takenTotals(ctx.db, ids, year.leaveYear),
    repo.ownQuotasOf(ctx.db, ids),
  ])
  const balance = new Map(ledger.map((l) => [`${l.employeeId}|${l.leaveTypeId}`, sumOf(l)]))
  const held = new Map(pending.map((p) => [`${p.employeeId}|${p.leaveTypeId}`, sumOf(p)]))
  const taken = new Map(takenRows.map((t) => [`${t.employeeId}|${t.leaveTypeId}`, -sumOf(t)]))

  const canManage = ctx.can('leave:balance:manage')
  const waiting = canManage ? summaryOf((await planFor(ctx.db, ctx, year)).entries, year.leaveYear) : null
  // Whose balance the caller may correct (Day 22: own work goes up the tree).
  const work = canManage ? await loadWork(ctx.db, ctx.organizationId, 'leave_balance') : null
  // …and within their leave scope, which the correction itself reads through.
  const inLeaveScope = new Set(canManage ? (await repo.peopleInScope(ctx.db, ctx.scopeFor('leave'))).map((p) => p.id) : [])

  return {
    leaveYear: year.leaveYear,
    label: leaveYearLabel(year.leaveYear, year.startMonth),
    years: [year.current, year.current + 1].map((y) => ({ leaveYear: y, label: leaveYearLabel(y, year.startMonth) })),
    // An unpaid type with no days a year has no limit: its column is what was
    // taken, and it has no balance to correct (client, 9 Oct 2026).
    types: types.map((t) => ({ id: t.id, code: t.code, name: t.name, annualQuota: Number(t.annualQuota), isPaid: t.isPaid, unlimited: isUnlimited(t.isPaid, Number(t.annualQuota)) })),
    people: people.map((p) => ({
      employeeId: p.id,
      employeeCode: p.employeeCode,
      fullName: p.fullName,
      department: p.department?.name ?? null,
      dateOfJoining: fromDateColumn(p.dateOfJoining),
      own: p.id === ctx.employeeId,
      ...(() => {
        const check = work ? checkWork(ctx, work, p.id) : null
        // Correcting needs the leave scope too (adjustBalance reads through
        // it): somebody listed only because the caller decides their leave
        // is not a "Correct" button that answers "not found".
        return { mayCorrect: Boolean(check?.allowed) && inLeaveScope.has(p.id), correctionGoesTo: check && !check.allowed ? check.ask : null }
      })(),
      balances: types.map((t) => {
        const key = `${p.id}|${t.id}`
        const b = balance.get(key) ?? 0
        const h = held.get(key) ?? 0
        // Somebody with their own days a year of an unpaid type has a cap, not "no limit".
        const unlimited = isUnlimited(t.isPaid, own.get(key) ?? Number(t.annualQuota))
        return { leaveTypeId: t.id, balance: b, pending: h, available: toHalfDays(b - h), taken: toHalfDays(taken.get(key) ?? 0), unlimited }
      }),
    })),
    // Null for somebody who may not grant: they are not told what they cannot do.
    waiting,
  }
}

/** What "Grant leave" would do, named, before anybody presses it. */
export async function grantPreview(ctx: AppContext, requestedYear?: number) {
  const year = await yearFor(ctx, requestedYear)
  const { entries, people, types } = await planFor(ctx.db, ctx, year)
  const name = new Map(people.map((p) => [p.id, { name: p.fullName, code: p.employeeCode }]))
  const typeName = new Map(types.map((t) => [t.id, t.name]))
  const line = (e: GrantEntry) => ({
    employeeId: e.employeeId,
    fullName: name.get(e.employeeId)?.name ?? '',
    employeeCode: name.get(e.employeeId)?.code ?? '',
    leaveType: typeName.get(e.leaveTypeId) ?? '',
    days: e.days,
    note: e.note,
  })
  // People with no joining date recorded get the full year, which is wrong for
  // anybody who in fact joined this year — so they are named before granting.
  const undated = new Set(people.filter((p) => !p.dateOfJoining).map((p) => p.id))
  const noJoiningDate = [...new Set(entries.filter((e) => e.reason === 'opening_grant' && undated.has(e.employeeId)).map((e) => e.employeeId))]
    .map((id) => ({ employeeId: id, fullName: name.get(id)?.name ?? '', employeeCode: name.get(id)?.code ?? '' }))
  return {
    leaveYear: year.leaveYear,
    label: leaveYearLabel(year.leaveYear, year.startMonth),
    ...summaryOf(entries, year.leaveYear),
    // The lines worth reading before granting: less than a full year, days
    // brought in from last year, and full years given for want of a date.
    proRated: entries.filter((e) => e.reason === 'opening_grant' && e.note).map(line),
    carried: entries.filter((e) => e.reason === 'carry_forward' && e.leaveYear === year.leaveYear).map(line),
    noJoiningDate,
    // Granted in advance, nothing is carried yet: last year is still being spent.
    carryLater: year.leaveYear > year.current,
  }
}

/**
 * Grants the year to everybody who has not had it — all at once, or only the
 * people added since the last time. Under one lock, and planned again inside
 * it, so two people pressing the button together grant it once.
 */
export async function grantLeaveYear(ctx: AppContext, requestedYear?: number) {
  const year = await yearFor(ctx, requestedYear)

  const result = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, grantLock(ctx.organizationId, year.leaveYear))
    const { entries } = await planFor(tx, ctx, year)
    if (entries.length === 0) {
      throw Conflict(`Everybody already has their ${leaveYearLabel(year.leaveYear, year.startMonth)} leave. Nothing was granted.`)
    }
    await repo.addLedgerEntries(tx, entries.map((e) => ({
      organizationId: ctx.organizationId,
      employeeId: e.employeeId,
      leaveTypeId: e.leaveTypeId,
      leaveYear: e.leaveYear,
      days: e.days,
      reason: e.reason,
      note: e.note,
      createdByUserId: ctx.userId,
    })))
    const summary = summaryOf(entries, year.leaveYear)
    await audit(ctx, { action: 'leave.granted', entityType: 'leave_year', details: { leaveYear: year.leaveYear, label: leaveYearLabel(year.leaveYear, year.startMonth), ...summary } }, tx)
    await notify(ctx, tx, {
      event: 'leave.balance_changed',
      to: { employees: [...new Set(entries.filter((e) => e.leaveYear === year.leaveYear).map((e) => e.employeeId))] },
      title: `Your ${leaveYearLabel(year.leaveYear, year.startMonth)} leave has been added`,
      message: `Your leave for the year is in your balance. ${whenItShows(year)}`,
      link: '/leave',
    })
    return summary
  })

  logger.info('Leave year granted', { by: ctx.userId, leaveYear: year.leaveYear, ...result })
  return { leaveYear: year.leaveYear, label: leaveYearLabel(year.leaveYear, year.startMonth), ...result }
}

export interface AdjustInput {
  employeeId: string
  leaveTypeId: string
  leaveYear?: number | undefined
  /** Positive adds days, negative takes them away. Whole or half days. */
  days: number
  note: string
}

/**
 * A correction, written as its own ledger entry with the reason — never an
 * edit to a number. Under the lock an application and an approval for this
 * person also take, so the balance and the days applied for are read as one
 * moment, and a request sent at the same time sees the corrected balance.
 */
export async function adjustBalance(ctx: AppContext, input: AdjustInput) {
  const year = await yearFor(ctx, input.leaveYear)
  // Only somebody the caller's leave scope reaches: a role given balance
  // corrections over its team corrects its team's, not the company's.
  const [employee, type] = await Promise.all([
    repo.activeEmployee(ctx.db, ctx.scopeFor('leave'), input.employeeId),
    repo.activeLeaveType(ctx.db, input.leaveTypeId),
  ])
  if (!employee) throw NotFound('No such employee')
  if (!type) throw NotFound('No such leave type')
  // Unpaid with no limit (Loss of Pay): there is no balance to correct — its
  // days are taken by applying for them, and every one is cut from pay.
  const own = (await repo.ownQuotasOf(ctx.db, [employee.id])).get(`${employee.id}|${type.id}`)
  if (isUnlimited(type.isPaid, own ?? Number(type.annualQuota))) {
    throw BusinessRule(`${type.name} has no limit, so there is no balance to correct. Its days are applied for and approved like any leave.`)
  }
  // Your own balance — or that of somebody who corrects balances too — is
  // corrected by the people above them in the company tree (Day 22).
  await assertWorkGoesUp(ctx, ctx.db, 'leave_balance', input.employeeId)

  const note = input.note.trim()
  const label = leaveYearLabel(year.leaveYear, year.startMonth)

  const after = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, `leave-apply:${employee.id}`)
    const [balance, pendingLeave, encashing] = await Promise.all([
      repo.balanceOn(tx, employee.id, type.id, year.leaveYear),
      repo.pendingDays(tx, employee.id, type.id, year.leaveYear),
      pendingEncashDays(tx, employee.id, type.id, year.leaveYear),
    ])
    const pending = pendingLeave + encashing
    const newBalance = toHalfDays(balance + input.days)
    // Days already applied for — as leave, or to be encashed — are spoken for:
    // taking them away would leave a request that could never be approved.
    if (newBalance - pending < 0) {
      throw Conflict(
        pending > 0
          ? `${employee.fullName} has ${dayCount(balance)} of ${type.name}, and ${pending} already applied for. At most ${dayCount(Math.max(0, toHalfDays(balance - pending)))} can be taken away.`
          : `${employee.fullName} has ${dayCount(balance)} of ${type.name}. At most that many can be taken away.`,
      )
    }
    await repo.addLedgerEntry(tx, {
      organizationId: ctx.organizationId,
      employeeId: employee.id,
      leaveTypeId: type.id,
      leaveYear: year.leaveYear,
      days: input.days,
      reason: 'adjustment',
      note,
      createdByUserId: ctx.userId,
    })
    await audit(ctx, {
      action: 'leave.balance_adjusted',
      entityType: 'employee',
      entityId: employee.id,
      details: { employeeId: employee.id, leaveType: type.code, leaveTypeName: type.name, leaveYear: year.leaveYear, days: input.days, balanceAfter: newBalance, note },
    }, tx)
    const amount = dayCount(Math.abs(input.days))
    await notify(ctx, tx, {
      event: 'leave.balance_changed',
      to: { employee: employee.id },
      title: input.days > 0 ? `${amount} of ${type.name} added` : `${amount} of ${type.name} taken away`,
      message: `Your ${type.name} balance for ${label} is now ${dayCount(newBalance)}. Reason: ${note} ${whenItShows(year)}`,
      link: '/leave',
    })
    return newBalance
  })

  logger.info('Leave balance adjusted', { by: ctx.userId, employeeId: employee.id, leaveType: type.code, days: input.days })
  return { employeeId: employee.id, leaveTypeId: type.id, leaveYear: year.leaveYear, balance: after }
}
