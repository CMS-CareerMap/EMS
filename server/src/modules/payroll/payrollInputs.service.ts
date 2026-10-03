import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { audit } from '../audit/audit.service'
import { employmentWindow } from '../../domain/payroll/salary'
import { financialYearOf } from '../../domain/payroll/tds'
import { fromDateColumn, toDateColumn, monthKey, monthName } from '../../domain/shared/dates'
import { closedRunsFrom } from './payrollRun.repository'
import { findPolicyOn } from './payroll.repository'
import { companyToday } from '../organization/organization.service'
import { BusinessRule } from '../../platform/errors/AppError'
import * as repo from './payrollInputs.repository'
import { assertWorkGoesUp, checkWork, loadWork } from '../organization/workRules.service'
import { employeesInScope } from '../../platform/authz/scopeWhere'

/**
 * What people enter before a payroll run — the accountant's TDS directives,
 * and amounts for monthly components such as Incentive.
 *
 * Both are refused for a month whose run is past draft. An approved payroll
 * is a decision about what that month cost; an input changed underneath it
 * would make the payslips disagree with the records they came from.
 */

async function refuseIfClosed(
  ctx: AppContext,
  year: number,
  month: number,
  reaches: (run: { year: number; month: number }) => boolean,
  what: string,
): Promise<void> {
  const closed = (await closedRunsFrom(ctx.db, year, month)).find(reaches)
  if (closed) {
    throw Conflict(
      `Payroll for ${monthName(closed.year, closed.month)} is already ${closed.status}, and ${what} would change it.`,
    )
  }
}

// ── TDS directives ──────────────────────────────────────────────────────────

export interface DirectiveInput {
  employeeId: string
  /** The payroll month it applies from. */
  year: number
  month: number
  monthlyAmount: number
  reason?: string | null | undefined
}

export async function listTdsDirectives(ctx: AppContext, financialYear: number) {
  return repo.listDirectives(ctx.db, financialYear)
}

/** Whether TDS is deducted under today's rules — for screens that cannot read Settings. */
export async function tdsEnabledToday(ctx: AppContext): Promise<boolean> {
  const rules = await findPolicyOn(ctx.db, toDateColumn(await companyToday(ctx)))
  return rules?.tdsEnabled ?? false
}

/**
 * Records how much tax to deduct each month, from a month onwards.
 *
 * It holds until a later directive in the same financial year replaces it,
 * and never beyond the year. Entering one for a month that already has one
 * corrects it; the audit row keeps what it said before.
 */
export async function setTdsDirective(ctx: AppContext, input: DirectiveInput) {
  const employee = await repo.findEmployeeBrief(ctx.db, input.employeeId)
  if (!employee) throw NotFound('Employee not found')
  // Tax on your own pay — or on that of somebody who enters salaries too — is
  // entered by the people above them in the company tree (Day 22).
  await assertWorkGoesUp(ctx, ctx.db, 'salary', input.employeeId)

  // A directive a run would never read is worse than none: it looks recorded.
  const rules = await findPolicyOn(ctx.db, toDateColumn(await companyToday(ctx)))
  if (!rules?.tdsEnabled) {
    throw BusinessRule(
      'Income tax (TDS) is turned off in Settings → Payroll Config, so payroll deducts none. Turn it on first if the company deducts TDS.',
    )
  }

  const reason = input.reason?.trim() || null
  if (input.monthlyAmount === 0 && !reason) {
    // The whole point of an explicit zero: somebody decided no tax is due,
    // and said why. A blank zero is indistinguishable from forgetting.
    throw BadRequest('A ₹0 directive needs a reason — for example, "income below the taxable limit".')
  }

  const financialYear = financialYearOf(input.year, input.month)
  await refuseIfClosed(
    ctx,
    input.year,
    input.month,
    (run) => financialYearOf(run.year, run.month) === financialYear,
    `a TDS directive from ${monthName(input.year, input.month)}`,
  )

  const effectiveFrom = `${monthKey(input.year, input.month)}-01`

  const saved = await withTransaction(ctx.db, async (tx) => {
    // One change to a person's tax at a time; the second save reads the first.
    await lockFor(tx, `tds:${input.employeeId}`)
    const previous = await repo.findDirective(tx, input.employeeId, toDateColumn(effectiveFrom))

    const row = await repo.saveDirective(tx, ctx.organizationId, input.employeeId, toDateColumn(effectiveFrom), {
      financialYear,
      monthlyAmount: input.monthlyAmount,
      reason,
      enteredByUserId: ctx.userId,
    })

    await audit(ctx, {
      action: 'payroll.tds_directive_set',
      entityType: 'tds_directive',
      entityId: row.id,
      details: {
        employeeId: input.employeeId,
        financialYear,
        effectiveFrom,
        monthlyAmount: input.monthlyAmount,
        reason,
        previous: previous ? { monthlyAmount: Number(previous.monthlyAmount), reason: previous.reason } : null,
      },
    }, tx)

    return row
  })

  logger.info('TDS directive set', { by: ctx.userId, employeeId: input.employeeId, effectiveFrom })
  return saved
}

// ── Monthly entries ─────────────────────────────────────────────────────────

export interface EntryInput {
  employeeId: string
  componentCode: string
  year: number
  month: number
  amount: number
  note?: string | null | undefined
}

/**
 * The month's entries — and the people whose amounts the caller may not
 * enter, each with whom to ask (Day 22: own work goes up the tree), so the
 * screen says so instead of offering a form the server would refuse.
 */
export async function listMonthlyEntries(ctx: AppContext, year: number, month: number) {
  const people = payPeople(ctx)
  const [entries, work, outside] = await Promise.all([
    repo.entriesForMonth(ctx.db, year, month, people),
    loadWork(ctx.db, ctx.organizationId, 'incentive'),
    people ? repo.idsOutside(ctx.db, people) : Promise.resolve([] as string[]),
  ])
  const hidden = new Set(outside)
  const blocked = work.world.tree
    .ids()
    .filter((id) => !work.world.tree.left(id))
    .map((employeeId) => ({ employeeId, check: checkWork(ctx, work, employeeId) }))
    .filter((b) => !b.check.allowed || hidden.has(b.employeeId))
    .map((b) => ({
      employeeId: b.employeeId,
      own: b.check.own,
      // A senior's pay is not the caller's to see or set: whoever enters
      // salaries does — by what they may do, not by a role's name.
      ask: b.check.allowed ? 'whoever enters salaries in Payroll' : b.check.ask,
    }))
  return { entries, blocked }
}

/**
 * Whose incentives the caller may see and enter. Somebody who sees salaries
 * only through their record — HR, whose salary scope leaves out the people
 * above them (Day 22) — sees and enters only those people's: an incentive is
 * pay. Somebody who opens Payroll sees everybody's anyway (null: everybody).
 */
function payPeople(ctx: AppContext) {
  return ctx.can('payroll:structure:read') ? null : employeesInScope(ctx.scopeFor('compensation'))
}

/**
 * Sets this month's amount of a monthly component for one person — Incentive,
 * in practice. Replaces what was there; nothing is added to it.
 */
export async function setMonthlyEntry(ctx: AppContext, input: EntryInput) {
  const employee = await repo.findEmployeeBrief(ctx.db, input.employeeId, payPeople(ctx))
  if (!employee) throw NotFound('Employee not found')
  // Your own incentive — or that of somebody who enters incentives too — is
  // entered by the people above them in the company tree (Day 22).
  await assertWorkGoesUp(ctx, ctx.db, 'incentive', input.employeeId)

  const component = await repo.findComponentByCode(ctx.db, input.componentCode)
  if (!component) throw BadRequest(`${input.componentCode} is not a salary component this company uses`)
  if (component.entry !== 'monthly') {
    // A fixed component comes from the salary record. An amount entered here
    // for it would be a second salary nobody could reconcile with the first.
    throw BadRequest(`${component.label} comes from the salary record and cannot be entered for a month`)
  }

  const window = employmentWindow({
    year: input.year,
    month: input.month,
    dateOfJoining: fromDateColumn(employee.dateOfJoining),
    lastWorkingDate: fromDateColumn(employee.lastWorkingDate),
  })
  if (!window) {
    throw BadRequest(`${employee.fullName} was not employed in ${monthName(input.year, input.month)}`)
  }

  await refuseIfClosed(
    ctx,
    input.year,
    input.month,
    (run) => run.year === input.year && run.month === input.month,
    `a new ${component.label.toLowerCase()} amount`,
  )

  const note = input.note?.trim() || null

  const { saved, previous } = await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, `monthly-entry:${input.employeeId}`)
    const result = await repo.saveEntry(
      tx,
      ctx.organizationId,
      { employeeId: input.employeeId, salaryComponentId: component.id, year: input.year, month: input.month },
      { amount: input.amount, note, enteredByUserId: ctx.userId },
    )

    await audit(ctx, {
      action: 'payroll.entry_set',
      entityType: 'monthly_entry',
      entityId: result.saved.id,
      details: {
        employeeId: input.employeeId,
        component: component.code,
        year: input.year,
        month: input.month,
        amount: input.amount,
        note,
        previous: result.previous,
      },
    }, tx)

    return result
  })

  logger.info('Monthly entry set', {
    by: ctx.userId,
    employeeId: input.employeeId,
    component: component.code,
    month: monthKey(input.year, input.month),
    replaced: previous !== null,
  })

  return saved
}

export async function deleteMonthlyEntry(ctx: AppContext, id: string): Promise<void> {
  const entry = await repo.findEntry(ctx.db, id)
  const people = payPeople(ctx)
  if (!entry || (people && !(await repo.employeeAmong(ctx.db, entry.employeeId, people)))) throw NotFound('Entry not found')
  await assertWorkGoesUp(ctx, ctx.db, 'incentive', entry.employeeId)

  await refuseIfClosed(
    ctx,
    entry.year,
    entry.month,
    (run) => run.year === entry.year && run.month === entry.month,
    `removing ${entry.employee.fullName}'s ${entry.component.label.toLowerCase()}`,
  )

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, `monthly-entry:${entry.employeeId}`)
    await repo.deleteEntry(tx, id)
    await audit(ctx, {
      action: 'payroll.entry_removed',
      entityType: 'monthly_entry',
      entityId: id,
      details: {
        employeeId: entry.employeeId,
        component: entry.component.code,
        year: entry.year,
        month: entry.month,
        amount: Number(entry.amount),
      },
    }, tx)
  })

  logger.info('Monthly entry removed', { by: ctx.userId, id })
}
