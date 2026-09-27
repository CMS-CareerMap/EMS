import type { AppContext } from '../../platform/context'
import { Conflict } from '../../platform/errors/AppError'
import { monthKey, monthName, monthOfDay, monthsBetween, type CalendarDate } from '../../domain/shared/dates'
import { closedRuns } from './payrollRun.repository'

/**
 * A month whose payroll is approved or paid is CLOSED to changes in what it
 * was calculated from (guide, Day 17: "locked after approval").
 *
 * The payslips are snapshots, so nothing here could change them. What it stops
 * is the quieter failure: HR marks somebody absent on a day already paid for,
 * sees it saved, and believes it was deducted. It was not, and never will be.
 * Refusing says so at the moment it matters, with the way out — reopen the run
 * while it is only approved, or carry the correction into an open month.
 *
 * Attendance an employee punches for themselves is not refused: it is a fact
 * about today, and a month approved early has already accepted that the rest
 * of it was counted as worked.
 */

export interface MonthRef {
  year: number
  month: number
}

function refusal(run: { year: number; month: number; status: string }, what: string) {
  return Conflict(
    run.status === 'approved'
      ? `Payroll for ${monthName(run.year, run.month)} is approved, so ${what} cannot change it. Reopen that payroll first, or record the change in a month that is still open.`
      : `Payroll for ${monthName(run.year, run.month)} is paid, so ${what} cannot change it. Record the change in a month that is still open.`,
  )
}

/** "YYYY-MM" for every closed month — for checking a whole import file at once. */
export async function closedMonthKeys(ctx: AppContext): Promise<Map<string, string>> {
  return new Map((await closedRuns(ctx.db)).map((run) => [monthKey(run.year, run.month), run.status]))
}

/** Refuses if any of these days falls in a closed month. */
export async function assertDaysOpen(ctx: AppContext, days: readonly CalendarDate[], what: string): Promise<void> {
  await assertMonthsOpen(ctx, days.map(monthOfDay), what)
}

/** Refuses if any of these months is closed. */
export async function assertMonthsOpen(ctx: AppContext, months: readonly MonthRef[], what: string): Promise<void> {
  if (months.length === 0) return
  const wanted = new Set(months.map((m) => monthKey(m.year, m.month)))
  const closed = (await closedRuns(ctx.db))
    .filter((run) => wanted.has(monthKey(run.year, run.month)))
    .sort((a, b) => a.year - b.year || a.month - b.month)
  if (closed[0]) throw refusal(closed[0], what)
}

/**
 * Refuses if any month from this day's onwards is closed — for a change that
 * holds from a date until something replaces it: a salary, a PT table.
 */
export async function assertOpenFrom(ctx: AppContext, from: CalendarDate, what: string): Promise<void> {
  const { year, month } = monthOfDay(from)
  const start = monthKey(year, month)
  const closed = (await closedRuns(ctx.db))
    .filter((run) => monthKey(run.year, run.month) >= start)
    .sort((a, b) => a.year - b.year || a.month - b.month)
  if (closed[0]) throw refusal(closed[0], what)
}

export { monthsBetween }
