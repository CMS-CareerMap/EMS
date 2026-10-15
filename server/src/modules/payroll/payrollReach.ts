import type { Prisma } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { employeesInScope } from '../../platform/authz/scopeWhere'
import { idsAmong } from './payrollRun.repository'

/**
 * Whose payroll the caller works with (client, 15 Oct 2026): "Whose payroll"
 * on the Roles screen, which works as "Whose attendance" and "Whose leave"
 * do — whatever is chosen there decides whose payroll a role is shown and
 * works with: salaries, incentives, tax, loans, bank accounts, payslips, a
 * month's figures, the bank file, reports. Somebody outside it is not found
 * (404), as everywhere else.
 */

/** The people the caller's payroll reaches, as a filter on Employee; null for the whole company — no condition at all. */
export function payrollPeople(ctx: AppContext): Prisma.EmployeeWhereInput | null {
  const scope = ctx.scopeFor('payroll')
  return scope.scope === 'ORGANIZATION' ? null : employeesInScope(scope)
}

/**
 * The part of a list about people that the caller may be shown — a refusal's
 * list of whose records stop the month, say: with some people's payroll, only
 * those people, the rest counted (`others`) and never named.
 */
export async function shownOf<T>(ctx: AppContext, items: readonly T[], personOf: (item: T) => string): Promise<{ shown: T[]; others: number }> {
  const people = payrollPeople(ctx)
  if (!people) return { shown: [...items], others: 0 }
  const reached = new Set(await idsAmong(ctx.db, people))
  const shown = items.filter((item) => reached.has(personOf(item)))
  return { shown, others: items.length - shown.length }
}
