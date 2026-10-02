import type { AppContext } from '../../platform/context'
import { NotFound, BadRequest, Conflict } from '../../platform/errors/AppError'
import {
  toDateColumn,
  fromDateColumn,
  addCalendarDays,
  type CalendarDate,
} from '../../domain/shared/dates'
import { logger } from '../../platform/logger'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import * as repo from './salaryStructure.repository'
import { audit } from '../audit/audit.service'
import { assertOpenFrom } from './payrollLock.service'
import { assertWorkGoesUp, checkWork, loadWork } from '../organization/workRules.service'

/**
 * Setting what somebody is paid.
 *
 * The client's flow is "Accounts creates salary structure → creates payroll
 * run", and until this existed the first half had nowhere to happen: the
 * employee form refuses salary fields by design, and nothing else wrote one. A
 * payroll run needs a salary on record for every person it pays.
 *
 * THREE CASES, and the difference matters for every payslip ever issued:
 *
 *   First salary     Opened from the date given. Nothing to close.
 *
 *   A raise          A LATER date. The current record is closed the day before
 *                    and a new one opens. March's payslip is still explained by
 *                    March's figures, because they were never touched.
 *
 *   A correction     The SAME date as the current record — a typo caught before
 *                    anything was paid on it. The figures are replaced in
 *                    place. Once payroll runs exist (Day 16), a correction to a
 *                    month already paid must be refused; that check belongs
 *                    with them, since they are what records a month as paid.
 *
 * An EARLIER date than the current record is refused: it would rewrite a
 * period that already had a salary, which is a correction wearing a new date.
 */

export interface ComponentInput {
  code: string
  amount: number
}

export interface SalaryInput {
  effectiveFrom: CalendarDate
  /** Annual cost to company. Stored as given; see the note in toRecord. */
  ctc: number
  components: ComponentInput[]
}

type Financial = Awaited<ReturnType<typeof repo.listHistory>>[number]

export function toRecord(financial: Financial) {
  const components = financial.components.map((row) => ({
    code: row.component.code,
    label: row.component.label,
    type: row.component.type,
    amount: Number(row.amount),
  }))

  return {
    effectiveFrom: fromDateColumn(financial.effectiveFrom),
    effectiveTo: financial.effectiveTo ? fromDateColumn(financial.effectiveTo) : null,
    // CTC is recorded, never derived. Whether it includes the employer's PF and
    // ESI is an open question with the client (§D3 #1), and deriving monthly
    // pay from it would bake in an answer nobody has given.
    ctc: Number(financial.ctc),
    grossMonthly: components
      .filter((c) => c.type === 'earning')
      .reduce((sum, c) => sum + c.amount, 0),
    components,
  }
}

async function visibleEmployee(ctx: AppContext, employeeId: string) {
  const employee = await repo.findEmployee(ctx.db, employeeId)
  // 404, not 403: another company's employee does not exist from here.
  if (!employee) throw NotFound('Employee not found')
  return employee
}

/** Everybody's salary — and whether the caller may enter each one, or whom to ask (Day 22). */
export async function roster(ctx: AppContext) {
  const [rows, work] = await Promise.all([repo.listRoster(ctx.db), loadWork(ctx.db, ctx.organizationId, 'salary')])
  return rows.map((row) => ({ row, check: checkWork(ctx, work, row.id) }))
}

export async function history(ctx: AppContext, employeeId: string) {
  const employee = await visibleEmployee(ctx, employeeId)
  const records = await repo.listHistory(ctx.db, employeeId)
  return { employee, history: records.map(toRecord) }
}

export async function setSalary(ctx: AppContext, employeeId: string, input: SalaryInput) {
  const employee = await visibleEmployee(ctx, employeeId)
  // Your own salary — or that of somebody who enters salaries too — is entered
  // by the people above them in the company tree (Day 22). One person agreeing
  // a salary and another entering it means nobody quietly changes their own.
  await assertWorkGoesUp(ctx, ctx.db, 'salary', employeeId)

  const catalogue = new Map(
    (await repo.listActiveComponents(ctx.db)).map((component) => [component.code, component]),
  )

  const seen = new Set<string>()
  const amounts: repo.ComponentAmount[] = []
  let earnings = 0

  for (const entry of input.components) {
    const component = catalogue.get(entry.code)
    if (!component) throw BadRequest(`${entry.code} is not a salary component this company uses`)

    if (seen.has(entry.code)) throw BadRequest(`${component.label} appears twice`)
    seen.add(entry.code)

    if (component.entry === 'monthly') {
      // Incentive and its kind are decided month by month. On a salary record
      // it would be paid every month at one figure — a raise with another name.
      throw BadRequest(`${component.label} is entered each month, not on the salary`)
    }

    // A zero is "not paid this component", which is simply its absence. Storing
    // it would put a ₹0 line on every payslip.
    if (entry.amount === 0) continue

    if (component.type === 'earning') earnings += entry.amount
    amounts.push({ salaryComponentId: component.id, amount: entry.amount })
  }

  if (earnings <= 0) {
    throw BadRequest('A salary needs at least one earning above zero')
  }

  // A salary holds from its date until the next one, so every month from then
  // on is what it changes.
  await assertOpenFrom(ctx, input.effectiveFrom, 'a salary starting from that date')

  const kind = await withTransaction(ctx.db, async (tx) => {
    // One change to a person's salary at a time. Read outside a transaction,
    // two saves together both found "no salary yet" and both opened one — two
    // open records, and payroll reading whichever it met first.
    await lockFor(tx, `salary:${employeeId}`)

    const open = await repo.findOpen(tx, employeeId)
    const openFrom = open ? fromDateColumn(open.effectiveFrom) : null
    let kind: 'first' | 'raise' | 'correction'

    if (!open) {
      kind = 'first'
      await repo.openNew(tx, ctx.organizationId, {
        employeeId,
        effectiveFrom: toDateColumn(input.effectiveFrom),
        closePreviousOn: null,
        previousId: null,
        ctc: input.ctc,
        components: amounts,
      })
    } else if (input.effectiveFrom === openFrom) {
      kind = 'correction'
      await repo.correctOpen(tx, ctx.organizationId, {
        financialId: open.id,
        ctc: input.ctc,
        components: amounts,
      })
    } else if (openFrom && input.effectiveFrom > openFrom) {
      kind = 'raise'
      await repo.openNew(tx, ctx.organizationId, {
        employeeId,
        effectiveFrom: toDateColumn(input.effectiveFrom),
        closePreviousOn: toDateColumn(addCalendarDays(input.effectiveFrom, -1)),
        previousId: open.id,
        ctc: input.ctc,
        components: amounts,
      })
    } else {
      throw Conflict(
        `${employee.fullName}'s current salary started on ${openFrom}. A new one cannot start before it — correct the current salary (same date), or start the new one after it.`,
      )
    }

    // Salary changes are on the list the audit log must cover (guide, Day 20).
    await audit(ctx, {
      action: 'salary.set',
      entityType: 'employee',
      entityId: employeeId,
      details: {
        kind,
        effectiveFrom: input.effectiveFrom,
        ctc: input.ctc,
        previousCtc: open ? Number(open.ctc) : null,
      },
    }, tx)

    return kind
  })

  logger.warn('Salary structure changed', {
    by: ctx.userId,
    employeeId,
    kind,
    effectiveFrom: input.effectiveFrom,
  })

  return history(ctx, employeeId)
}
