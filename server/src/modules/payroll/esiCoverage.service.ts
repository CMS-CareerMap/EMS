import type { AppContext } from '../../platform/context'
import { esiPeriodFor, isEsiEligible } from '../../domain/payroll/statutory'
import { toDateColumn, fromDateColumn, monthKey, type CalendarDate } from '../../domain/shared/dates'
import { logger } from '../../platform/logger'
import { NotFound } from '../../platform/errors/AppError'
import * as repo from './payroll.repository'
import { isUniqueViolation } from '../../platform/db/errors'
import { withTransaction } from '../../platform/db/transaction'
import { assertMonthsOpen, closedMonthKeys, monthsBetween } from './payrollLock.service'

/**
 * Who is covered by ESI, decided ONCE per contribution period.
 *
 * This is the file that fixes the bug the audit named: `Payroll.jsx:23` asked
 * "is gross ≤ 21,000?" every single month, so an employee who got a raise in
 * June stopped contributing in June, and one who took unpaid leave in August
 * started again in August. The same person drifted in and out of a government
 * insurance scheme depending on what they happened to earn that month, and
 * nobody could explain it to them because it was not a decision anybody made.
 *
 * ESIC does not work that way. Eligibility is tested at the START of a
 * contribution period — 1 April or 1 October — or on the date somebody joins if
 * that falls mid-period. Whatever it decides holds until the period ends. Cross
 * the threshold in June and you keep contributing until 30 September; that is
 * not a loophole, it is the rule, and it exists so that cover does not
 * evaporate the month after somebody's pay rises.
 *
 * So coverage is a RECORD, not a calculation. It is written once, it says why,
 * and every payslip in the period reads it rather than re-deciding. A stored
 * decision can be shown to an employee who asks. A recomputed one cannot even
 * be shown to the person who wrote the code.
 */

/** Why a coverage decision came out the way it did, in the employee's terms. */
export type CoverageReason =
  | 'period_start'
  | 'joined_mid_period'
  /** Paid from a day inside the period, with no salary on record before it (a go-live). */
  | 'first_wage_in_period'
  | 'no_wage_on_record'

export interface Coverage {
  covered: boolean
  periodStart: CalendarDate
  periodEnd: CalendarDate
  /** The wage the decision was made against, kept so it can be defended. */
  lockedWageRate: number
  reason: CoverageReason
}

function toCoverage(
  row: { covered: boolean; lockedWageRate: unknown; reason: string },
  periodStart: CalendarDate,
  periodEnd: CalendarDate,
): Coverage {
  return {
    covered: row.covered,
    periodStart,
    periodEnd,
    lockedWageRate: Number(row.lockedWageRate),
    reason: row.reason as CoverageReason,
  }
}

/**
 * The ESI threshold that was in force on the day the test is taken.
 *
 * Not today's. Re-deciding April's coverage in November against a threshold
 * raised in October would apply a rule to a period it did not govern.
 *
 * And no fallback when there is no policy. The statutory figure is a company
 * setting precisely because ESIC moves it; a number written here as a default
 * would quietly outlive the next revision. A company with no rates in force has
 * not finished setting up, and payroll should say so rather than guess.
 */
async function thresholdOn(ctx: AppContext, day: CalendarDate): Promise<number> {
  const policy = await repo.findPolicyOn(ctx.db, toDateColumn(day))
  if (!policy) {
    throw NotFound(`No payroll policy was in force on ${day}. Set the rates in Settings first.`)
  }
  return Number(policy.esiThreshold)
}

/**
 * The employee's monthly WAGE RATE — what they are contracted to earn.
 *
 * Not what they were paid. Somebody on ₹20,000 who took three weeks of unpaid
 * leave and received ₹5,000 is tested on ₹20,000, because testing the paid
 * amount would sweep people into ESI in exactly the months they were ill and
 * out of it again when they recovered.
 *
 * Fixed earnings only. A monthly entry like Incentive is not part of a RATE —
 * it is whatever was decided for one month — and letting a one-off incentive
 * in April push somebody out of cover for six months would be absurd.
 */
async function wageRateOn(
  ctx: AppContext,
  employeeId: string,
  day: CalendarDate,
): Promise<number | null> {
  const financial = await repo.findFinancialOn(ctx.db, employeeId, toDateColumn(day))
  if (!financial) return null

  // The wages ESI is charged on — tested against the threshold on the same
  // footing as the contributions are worked out (domain/payroll/salary.ts).
  // Counting a component that is no ESI wage pushed people out of cover their
  // contributable wage kept them in.
  return financial.components
    .filter((row) => row.component.type === 'earning' && row.component.entry === 'fixed' && row.component.countsForEsi !== false)
    .reduce((sum, row) => sum + Number(row.amount), 0)
}

/**
 * The decision the records support today, or null when no salary is on
 * record for any day of the period.
 *
 * Tested on the period's start, or the joining day for somebody who joined
 * after it began — or, when the salary on record starts later still (a company
 * entering everybody's pay from its go-live day), on that first salary's day.
 * Finding nothing on the start day used to decide "not covered" for all six
 * months, and nobody was told.
 */
async function decide(
  ctx: AppContext,
  employeeId: string,
  joinedOn: CalendarDate | null,
  period: { start: CalendarDate; end: CalendarDate },
): Promise<Omit<Coverage, 'periodStart' | 'periodEnd'> | null> {
  const joinedMidPeriod = joinedOn !== null && joinedOn > period.start && joinedOn <= period.end
  let testedOn = joinedMidPeriod && joinedOn ? joinedOn : period.start
  let reason: CoverageReason = joinedMidPeriod ? 'joined_mid_period' : 'period_start'

  let wageRate = await wageRateOn(ctx, employeeId, testedOn)
  if (wageRate === null) {
    const first = await repo.firstFinancialBetween(ctx.db, employeeId, toDateColumn(testedOn), toDateColumn(period.end))
    if (!first) return null
    testedOn = fromDateColumn(first.effectiveFrom)
    reason = 'first_wage_in_period'
    wageRate = await wageRateOn(ctx, employeeId, testedOn)
    if (wageRate === null) return null
  }

  const covered = isEsiEligible({ wageRate, threshold: await thresholdOn(ctx, testedOn) })
  return { covered, lockedWageRate: wageRate, reason }
}

/**
 * The coverage record for this employee and this month, creating it if the
 * period has not been decided yet.
 *
 * Idempotent, and deliberately so: payroll may run for the same month twice,
 * and the second run must read the first run's decision rather than take a
 * fresh one against wages that have since changed.
 */
export async function coverageFor(
  ctx: AppContext,
  employeeId: string,
  year: number,
  month: number,
): Promise<Coverage> {
  const period = esiPeriodFor(year, month)

  // Checked BEFORE anything else, and not merely implied by the scoped reads
  // below. Given another company's employee id, every scoped lookup returns
  // nothing — and nothing looks exactly like "no salary on record", which
  // would write a coverage row for a person in a different organization. The
  // foreign key would accept it, because that employee does exist.
  const employee = await repo.findEmployee(ctx.db, employeeId)
  if (!employee) throw NotFound('Employee not found')

  // Calendar dates compare as strings, with no time zone to get wrong.
  const joined = employee.dateOfJoining ? fromDateColumn(employee.dateOfJoining) : null
  const decision = await decide(ctx, employeeId, joined, period)

  const existing = await repo.findCoverage(ctx.db, employeeId, toDateColumn(period.start))
  if (existing) {
    // A decision taken stands for its six months — a raise during the period
    // changes nothing, which is the rule. Unless the wage it was taken ON has
    // since been changed at the source (a revision back-dated to the test day,
    // or a salary entered after a run found none), and no month of the period
    // is signed off yet: then it is taken again on the records as they are.
    // In paise: the stored rate is a decimal, the fresh one a sum of floats.
    const paise = (rupees: number) => Math.round(rupees * 100)
    const unchanged = decision === null || paise(Number(existing.lockedWageRate)) === paise(decision.lockedWageRate)
    if (unchanged || !(await periodOpen(ctx, period))) return toCoverage(existing, period.start, period.end)
    await repo.deleteCoverage(ctx.db, employeeId, toDateColumn(period.start))
    logger.info('ESI coverage re-decided: the wage it was taken on has changed', {
      employeeId,
      period: period.label,
      was: { covered: existing.covered, wage: Number(existing.lockedWageRate) },
      now: { covered: decision.covered, wage: decision.lockedWageRate },
    })
  }

  if (decision === null) {
    // No salary on record for the period. NOT treated as zero, which would
    // read as "earns nothing, therefore covered" and enrol somebody on the
    // strength of missing data. Not covered — and not saved, so the period is
    // decided properly once a salary is entered.
    logger.warn('ESI coverage: no salary on record for the period', { employeeId, period: period.label })
    return { covered: false, lockedWageRate: 0, reason: 'no_wage_on_record', periodStart: period.start, periodEnd: period.end }
  }

  return persist(ctx, employeeId, { ...decision, periodStart: period.start, periodEnd: period.end })
}

/** No month of the contribution period is signed off yet. */
async function periodOpen(ctx: AppContext, period: { start: CalendarDate; end: CalendarDate }): Promise<boolean> {
  const closed = await closedMonthKeys(ctx)
  return monthsBetween(period.start, period.end).every((m) => !closed.has(monthKey(m.year, m.month)))
}

async function persist(ctx: AppContext, employeeId: string, coverage: Coverage): Promise<Coverage> {
  const periodStart = toDateColumn(coverage.periodStart)

  try {
    await repo.createCoverage(ctx.db, ctx.organizationId, {
      employeeId,
      periodStart,
      periodEnd: toDateColumn(coverage.periodEnd),
      covered: coverage.covered,
      lockedWageRate: coverage.lockedWageRate,
      reason: coverage.reason,
    })
    return coverage
  } catch (err) {
    // Two calculations for the same period at once would both find nothing
    // and both insert. The unique constraint makes the second one fail rather
    // than write a second, possibly different, decision — so the loser reads
    // the winner's instead.
    //
    // ONLY that failure. Anything else — the database gone, a bad value — is a
    // real error, and treating it as a race would bury it under a misleading
    // "could not be read back".
    if (!isUniqueViolation(err)) throw err

    const winner = await repo.findCoverage(ctx.db, employeeId, periodStart)
    if (!winner) throw err

    return toCoverage(winner, coverage.periodStart, coverage.periodEnd)
  }
}

/**
 * Re-decides a period, keeping the old record's reason in the log.
 *
 * The escape hatch for a genuine data-entry error — somebody's salary was typed
 * wrong in April and the whole period was decided on a fiction. NOT for
 * reacting to a raise: that is the rule working, not a mistake.
 *
 * Requires `payroll:structure:manage` at the caller, and says who did it.
 */
export async function redecide(
  ctx: AppContext,
  employeeId: string,
  year: number,
  month: number,
): Promise<Coverage> {
  const period = esiPeriodFor(year, month)
  const periodStart = toDateColumn(period.start)

  const visible = await repo.findEmployee(ctx.db, employeeId)
  if (!visible) throw NotFound('Employee not found')

  // The decision covers six months; if any of them is signed off, it stands.
  await assertMonthsOpen(ctx, monthsBetween(period.start, period.end), 'deciding this ESI period again')

  const previous = await repo.findCoverage(ctx.db, employeeId, periodStart)

  // Forgotten under the period's payroll locks: a month of it being approved
  // this moment is waited for, then found signed off, and the decision stands.
  await withTransaction(ctx.db, async (tx) => {
    await assertMonthsOpen(ctx, monthsBetween(period.start, period.end), 'deciding this ESI period again', tx)
    await repo.deleteCoverage(tx, employeeId, periodStart)
  })

  const fresh = await coverageFor(ctx, employeeId, year, month)

  logger.warn('ESI coverage re-decided', {
    employeeId,
    period: period.label,
    by: ctx.userId,
    was: previous ? { covered: previous.covered, wage: Number(previous.lockedWageRate) } : null,
    now: { covered: fresh.covered, wage: fresh.lockedWageRate },
  })

  return fresh
}
