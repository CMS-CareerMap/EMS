import type { AppContext } from '../../platform/context'
import { Conflict } from '../../platform/errors/AppError'
import type { TxDb } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { monthKey, monthName, monthOfDay, monthsBetween, type CalendarDate } from '../../domain/shared/dates'
import { closedRuns, runMonths } from './payrollRun.repository'

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
 *
 * Given the writer's transaction (`tx`), each check first takes the payroll
 * lock of the months it guards — the lock approving a month holds from its
 * comparison of the figures to the move — and then reads through `tx`. A write
 * made while its month is being approved waits, then finds the month closed
 * and is refused. Checked outside a transaction it could pass, and be saved
 * just after the approval had compared the figures: approved without it, and
 * told it was saved.
 *
 * Month locks are the LAST locks a transaction takes — after a person's
 * lifecycle, requests and leave locks — and, when it takes several, earliest
 * month first; and they are taken BEFORE the transaction writes a row another
 * holder writes too (an attendance day, a leave request), or the two could
 * wait on each other's row and lock at once. Approving takes one month's lock
 * and nothing after it.
 */

export interface MonthRef {
  year: number
  month: number
}

/**
 * The lock a month's payroll is created, recalculated, approved and reopened
 * under — and that every write feeding the month takes before checking it.
 */
export const runLock = (ctx: AppContext, year: number, month: number) =>
  `payroll-run:${ctx.organizationId}:${monthKey(year, month)}`

/** The payroll lock of each month ("YYYY-MM"), once each, earliest first — the order every holder of more than one takes them in. */
async function holdMonths(ctx: AppContext, tx: TxDb, keys: Iterable<string>): Promise<void> {
  for (const key of [...new Set(keys)].sort()) await lockFor(tx, `payroll-run:${ctx.organizationId}:${key}`)
}

function refusal(run: { year: number; month: number; status: string }, what: string) {
  return Conflict(
    run.status === 'approved'
      ? `Payroll for ${monthName(run.year, run.month)} is approved, so ${what} cannot change it. Reopen that payroll first, or record the change in a month that is still open.`
      : `Payroll for ${monthName(run.year, run.month)} is paid, so ${what} cannot change it. Record the change in a month that is still open.`,
  )
}

/**
 * "YYYY-MM" for every closed month — for checking a whole file or list at
 * once. Given `tx`, the months in `holding` are locked first (see above).
 */
export async function closedMonthKeys(ctx: AppContext, tx?: TxDb, holding: readonly MonthRef[] = []): Promise<Map<string, string>> {
  if (tx) await holdMonths(ctx, tx, holding.map((m) => monthKey(m.year, m.month)))
  return new Map((await closedRuns(tx ?? ctx.db)).map((run) => [monthKey(run.year, run.month), run.status]))
}

/** Refuses if any of these days falls in a closed month. */
export async function assertDaysOpen(ctx: AppContext, days: readonly CalendarDate[], what: string, tx?: TxDb): Promise<void> {
  await assertMonthsOpen(ctx, days.map(monthOfDay), what, tx)
}

/** Refuses if any of these months is closed. */
export async function assertMonthsOpen(ctx: AppContext, months: readonly MonthRef[], what: string, tx?: TxDb): Promise<void> {
  if (months.length === 0) return
  const wanted = new Set(months.map((m) => monthKey(m.year, m.month)))
  if (tx) await holdMonths(ctx, tx, wanted)
  const closed = (await closedRuns(tx ?? ctx.db))
    .filter((run) => wanted.has(monthKey(run.year, run.month)))
    .sort((a, b) => a.year - b.year || a.month - b.month)
  if (closed[0]) throw refusal(closed[0], what)
}

/**
 * Refuses if any month from this day's onwards is closed — for a change that
 * holds from a date until something replaces it: a salary, a PT table.
 */
export async function assertOpenFrom(ctx: AppContext, from: CalendarDate, what: string, tx?: TxDb): Promise<void> {
  const closed = await closedFrom(ctx, from, tx)
  if (closed) throw refusal(closed, what)
}

/** The same question, for a caller that keeps what was paid instead of refusing. */
export async function isOpenFrom(ctx: AppContext, from: CalendarDate, tx?: TxDb): Promise<boolean> {
  return !(await closedFrom(ctx, from, tx))
}

/**
 * Takes the payroll lock of every month from this day's on that could be in
 * the middle of being approved — those with a draft; months from here on are
 * unbounded, and only a draft can be approved. For a transaction that will
 * check several dates: held at once from the earliest, in order, the later
 * checks only take locks it already holds, so no two writers can each hold a
 * month the other waits for.
 */
export async function holdPayrollFrom(ctx: AppContext, tx: TxDb, from: CalendarDate): Promise<void> {
  const { year, month } = monthOfDay(from)
  const start = monthKey(year, month)
  const drafts = (await runMonths(tx)).filter((run) => run.status === 'draft' && monthKey(run.year, run.month) >= start)
  await holdMonths(ctx, tx, drafts.map((run) => monthKey(run.year, run.month)))
}

async function closedFrom(ctx: AppContext, from: CalendarDate, tx?: TxDb) {
  const { year, month } = monthOfDay(from)
  const start = monthKey(year, month)
  if (tx) await holdPayrollFrom(ctx, tx, from)
  const closed = (await closedRuns(tx ?? ctx.db))
    .filter((run) => monthKey(run.year, run.month) >= start)
    .sort((a, b) => a.year - b.year || a.month - b.month)
  return closed[0] ?? null
}

export { monthsBetween }
