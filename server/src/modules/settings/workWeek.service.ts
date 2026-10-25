import type { AppContext } from '../../platform/context'
import { BadRequest, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { addCalendarDays, dayLabel, fromDateColumn, monthKey, monthOfDay, type CalendarDate } from '../../domain/shared/dates'
import {
  daysThatChange,
  offDaysOn,
  ruleOn,
  scheduledAfter,
  withRuleFrom,
  workWeek,
  type Weekday,
  type WorkWeek,
} from '../../domain/shared/workWeek'
import { companyToday } from '../organization/organization.service'
import { assertMonthsOpen, closedMonthKeys } from '../payroll/payrollLock.service'
import { audit } from '../audit/audit.service'
import * as repo from './workWeek.repository'
import { reconcileAfter } from '../attendance/absentRule.service'

/**
 * Settings → Leave Config → Working Week (client, 25 Oct 2026).
 *
 * A change says from when: today, the 1st of next month, or — while this
 * month's payroll is open — the 1st of this month, for a company setting its
 * week for the first time. Months before this one are counted already and are
 * never changed; a month whose payroll is approved is not either.
 *
 * What a change does NOT do, as a holiday does not: leave approved before it
 * was counted on the week as it stood. The answer says how many approved
 * requests cover a day that changed, so the page can say so.
 */

export interface WorkWeekView {
  today: CalendarDate
  /** The week in force today, and the day it began — null when no rule is written. */
  current: { from: CalendarDate | null; offDays: readonly Weekday[] }
  /** Changes saved for a later day, earliest first. */
  scheduled: { from: CalendarDate; offDays: readonly Weekday[] }[]
  /** The days a change may start on. `thisMonth` is null on the 1st (it is today) or when this month's payroll is closed. */
  starts: { today: CalendarDate; thisMonth: CalendarDate | null; nextMonth: CalendarDate }
  /** Why the 1st of this month is not offered, when it is not and today is not the 1st. */
  thisMonthClosed: string | null
}

const firstOfMonth = (day: CalendarDate): CalendarDate => `${day.slice(0, 7)}-01`

function firstOfNextMonth(day: CalendarDate): CalendarDate {
  const { year, month } = monthOfDay(day)
  return month === 12 ? `${year + 1}-01-01` : `${monthKey(year, month + 1)}-01`
}

const sameDays = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((d, i) => d === b[i])

/**
 * Where the week the company always had is written from, when a change starts
 * before every rule there is: before the first rule the first one applies, so
 * without it the change would reach back over every day gone by — months paid
 * included.
 */
const HISTORY_FROM: CalendarDate = '2000-01-01'

export async function getWorkWeek(ctx: AppContext): Promise<WorkWeekView> {
  const [today, week, closed] = await Promise.all([companyToday(ctx), repo.workWeekOf(ctx.db), closedMonthKeys(ctx)])
  return viewOf(week, today, closed)
}

function viewOf(week: WorkWeek, today: CalendarDate, closed: ReadonlyMap<string, string>): WorkWeekView {
  const rule = ruleOn(week, today)
  const thisMonth = firstOfMonth(today)
  const status = closed.get(today.slice(0, 7))
  return {
    today,
    current: { from: rule?.from ?? null, offDays: offDaysOn(week, today) },
    scheduled: scheduledAfter(week, today).map((r) => ({ from: r.from, offDays: r.offDays })),
    starts: { today, thisMonth: thisMonth !== today && !status ? thisMonth : null, nextMonth: firstOfNextMonth(today) },
    thisMonthClosed: thisMonth !== today && status ? `This month’s payroll is ${status}, so its days cannot change.` : null,
  }
}

export interface WorkWeekChange {
  offDays: number[]
  from: CalendarDate
}

export async function setWorkWeek(ctx: AppContext, input: WorkWeekChange) {
  const offDays = [...new Set(input.offDays)].sort() as Weekday[]
  if (offDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw BadRequest('Weekdays are 0 (Sunday) to 6 (Saturday).')
  if (offDays.length > 6) throw BadRequest('A company cannot be closed every day of the week.')

  const today = await companyToday(ctx)
  const thisMonth = firstOfMonth(today)
  if (input.from < thisMonth) {
    throw BadRequest(`A change can start on ${dayLabel(thisMonth)} at the earliest: the months before are counted already.`)
  }
  if (input.from > addCalendarDays(today, 366)) throw BadRequest('A change can start at most a year from today.')

  const result = await withTransaction(ctx.db, async (tx) => {
    // One change at a time: two saves together would each read the week as it was.
    await lockFor(tx, `work-week:${ctx.organizationId}`)
    const before = repo.toWorkWeek(await repo.workWeekRows(tx))
    // No rule begun before the change: the week as it was is written first, so the days before keep it.
    const keepsHistory = !before.rules.some((r) => r.from < input.from) && input.from > HISTORY_FROM
    const history = keepsHistory ? [{ from: HISTORY_FROM, offDays: offDaysOn(before, addCalendarDays(input.from, -1)) }] : []
    const after = workWeek([...history, ...withRuleFrom(before, input.from, offDays).rules])

    // After the last rule of either the week is the same every week: seven days past it say everything.
    const lastStart = [input.from, ...before.rules.map((r) => r.from)].sort().at(-1)!
    const changed = daysThatChange(before, after, input.from, addCalendarDays(lastStart, 7))
    if (changed.length === 0) throw BadRequest(`These are the weekly offs from ${dayLabel(input.from)} already.`)

    // Only this month can be closed among the days changed: earlier ones are refused above.
    if (changed.some((d) => d.slice(0, 7) === today.slice(0, 7))) {
      await assertMonthsOpen(ctx, [monthOfDay(today)], 'changing the weekly offs', tx)
    }

    const replaced = scheduledAfter(before, addCalendarDays(input.from, -1)).filter((r) => r.from > today)
    await repo.removeFrom(tx, input.from)
    for (const h of history) await repo.create(tx, ctx.organizationId, h.from, h.offDays, ctx.userId)
    // A rule that says what the one before it says is not written: the week is the same without it.
    const earlier = workWeek([...history, ...before.rules.filter((r) => r.from < input.from)])
    const row = earlier.rules.length > 0 && sameDays(offDaysOn(earlier, input.from), offDays)
      ? null
      : await repo.create(tx, ctx.organizationId, input.from, offDays, ctx.userId)

    await audit(ctx, {
      action: 'work_week.changed',
      entityType: 'work_week',
      ...(row ? { entityId: row.id } : {}),
      details: {
        from: input.from,
        offDays,
        before: [...offDaysOn(before, input.from)],
        ...(replaced.length ? { replaced: replaced.map((r) => ({ from: r.from, offDays: [...r.offDays] })) } : {}),
      },
    }, tx)
    return { changed, before, after }
  })

  // Days that are off now, or working now, under the no-check-in rule: put right at once.
  await reconcileAfter(ctx, 'work_week')
  const closed = await closedMonthKeys(ctx)
  return {
    view: viewOf(result.after, today, closed),
    changedDays: result.changed,
    approvedLeaveAffected: await approvedLeaveChanged(ctx, result.before, result.after, input.from),
  }
}

/** Cancels a change saved for a later day. */
export async function cancelScheduled(ctx: AppContext, from: CalendarDate) {
  const today = await companyToday(ctx)
  if (from <= today) throw BadRequest('Only a change that has not started yet can be cancelled. Save the week you want from today instead.')
  const after = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, `work-week:${ctx.organizationId}`)
    const before = repo.toWorkWeek(await repo.workWeekRows(tx))
    const rule = before.rules.find((r) => r.from === from)
    if (!rule) throw NotFound(`No change is saved for ${dayLabel(from)}.`)
    // Its days change back: a month whose payroll is approved does not.
    await assertMonthsOpen(ctx, [monthOfDay(from)], 'cancelling the change of weekly offs', tx)
    await repo.removeOn(tx, from)
    await audit(ctx, { action: 'work_week.cancelled', entityType: 'work_week', details: { from, offDays: [...rule.offDays] } }, tx)
    return workWeek(before.rules.filter((r) => r.from !== from))
  })
  return viewOf(after, today, await closedMonthKeys(ctx))
}

/**
 * How many approved requests cover a day, from the change on, whose being off
 * the change turned — leave counted on the week as it stood. Every such
 * request, however far ahead: a December holiday booked in October counts.
 */
async function approvedLeaveChanged(ctx: AppContext, before: WorkWeek, after: WorkWeek, from: CalendarDate): Promise<number> {
  const requests = await repo.approvedLeaveFrom(ctx.db, from)
  return requests.filter((r) => {
    const start = fromDateColumn(r.fromDate) > from ? fromDateColumn(r.fromDate) : from
    return daysThatChange(before, after, start, fromDateColumn(r.toDate)).length > 0
  }).length
}
