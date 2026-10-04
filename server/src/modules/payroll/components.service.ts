import type { ComponentEntry, ComponentType } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, NotFound } from '../../platform/errors/AppError'
import { withAudit } from '../audit/audit.service'
import { logger } from '../../platform/logger'
import { monthKey, monthName, toDateColumn } from '../../domain/shared/dates'
import { companyToday } from '../organization/organization.service'
import { closedMonthKeys } from './payrollLock.service'
import * as repo from './components.repository'

/**
 * The company's salary components (client §40): Basic, HRA and the rest, and
 * any it adds — a Site Allowance, a Bonus, a Canteen deduction. Rows, not
 * columns, so adding one is a line in Settings rather than a release.
 *
 * Settled once used: a component somebody is paid keeps its type and how it
 * is entered, and is archived only when nothing in force or still open uses
 * it. Its label, its order and which statutory wages it counts in stay the
 * accountant's to change.
 */

/** Lines payroll writes itself — never a component's code. */
const RESERVED = new Set(['PF', 'ESI', 'PT', 'TDS', 'OT', 'LEAVE_ENC', 'LOAN', 'ADVANCE'])

export interface ComponentInput {
  code?: string | undefined
  label?: string | undefined
  type?: ComponentType | undefined
  entry?: ComponentEntry | undefined
  countsForPf?: boolean | undefined
  countsForEsi?: boolean | undefined
  countsForPt?: boolean | undefined
  taxable?: boolean | undefined
  displayOrder?: number | undefined
}

export async function listComponents(ctx: AppContext) {
  return repo.allComponents(ctx.db)
}

/** Adds one — or brings back an archived one of the same code, with the values given. */
export async function addComponent(ctx: AppContext, input: ComponentInput) {
  if (!input.code || !input.label) throw BadRequest('A component needs a code and a name')
  const code = input.code.trim().toUpperCase()
  if (RESERVED.has(code)) throw BadRequest(`${code} is a line payroll writes itself. Choose another code.`)

  const values: repo.ComponentValues = {
    label: input.label.trim(),
    type: input.type ?? 'earning',
    entry: input.entry ?? 'fixed',
    countsForPf: input.countsForPf ?? false,
    countsForEsi: input.countsForEsi ?? true,
    countsForPt: input.countsForPt ?? true,
    taxable: input.taxable ?? true,
    displayOrder: input.displayOrder ?? (await repo.nextDisplayOrder(ctx.db)),
  }
  if (values.type === 'deduction' && values.countsForPf) throw BadRequest('A deduction does not count towards PF wages.')

  const existing = await repo.findComponentByCode(ctx.db, code)
  if (existing && !existing.archivedAt) throw Conflict(`${existing.label} already uses the code ${existing.code}.`)
  if (existing) {
    if ((await repo.componentInUse(ctx.db, existing.id)) && (existing.type !== values.type || existing.entry !== values.entry)) {
      throw Conflict(`${existing.code} was ${describe(existing.type, existing.entry)} before it was archived, and people were paid it as that. Bring it back as the same kind, or choose a new code.`)
    }
    const row = await withAudit(
      ctx,
      (tx) => repo.updateComponent(tx, existing.id, { ...values, archivedAt: null }),
      () => ({ action: 'salary_component.restored', entityType: 'salary_component', entityId: existing.id, details: { code, ...values } }),
    )
    return { row, restored: true }
  }

  const row = await withAudit(
    ctx,
    (tx) => repo.createComponent(tx, ctx.organizationId, code, values),
    (created) => ({ action: 'salary_component.created', entityType: 'salary_component', entityId: created.id, details: { code, ...values } }),
  )
  logger.info('Salary component added', { by: ctx.userId, code })
  return { row, restored: false }
}

export async function changeComponent(ctx: AppContext, id: string, input: ComponentInput) {
  const existing = await repo.findComponent(ctx.db, id)
  if (!existing || existing.archivedAt) throw NotFound('That component does not exist')
  if (input.code !== undefined && input.code.trim().toUpperCase() !== existing.code) {
    throw BadRequest('A component’s code cannot change: payslips already carry it. Archive it and add a new one.')
  }

  const data: Record<string, unknown> = {}
  if (input.label !== undefined) data.label = input.label.trim()
  for (const key of ['type', 'entry', 'countsForPf', 'countsForEsi', 'countsForPt', 'taxable', 'displayOrder'] as const) {
    if (input[key] !== undefined && input[key] !== existing[key]) data[key] = input[key]
  }
  if (Object.keys(data).length === 0) return existing

  if (('type' in data || 'entry' in data) && (await repo.componentInUse(ctx.db, id))) {
    throw Conflict(`${existing.label} is already paid as ${describe(existing.type, existing.entry)}, so that cannot change. Add a new component for the new kind.`)
  }
  if ((data.type ?? existing.type) === 'deduction' && (data.countsForPf ?? existing.countsForPf)) {
    throw BadRequest('A deduction does not count towards PF wages.')
  }

  return withAudit(
    ctx,
    (tx) => repo.updateComponent(tx, id, data),
    () => ({
      action: 'salary_component.updated',
      entityType: 'salary_component',
      entityId: id,
      // The old value beside each new one (client §47).
      details: { code: existing.code, changes: data, before: Object.fromEntries(Object.keys(data).map((k) => [k, existing[k as keyof typeof existing]])) },
    }),
  )
}

/** Archived: no longer offered for a salary or a month. Refused while a salary in force, or a month still open, uses it. */
export async function archiveComponent(ctx: AppContext, id: string) {
  const existing = await repo.findComponent(ctx.db, id)
  if (!existing) throw NotFound('That component does not exist')
  if (existing.archivedAt) return existing

  const paid = await repo.paidOnSalaries(ctx.db, id, toDateColumn(await companyToday(ctx)))
  if (paid.length > 0) {
    const names = [...new Set(paid.map((p) => p.financial.employee.fullName))]
    throw Conflict(`${existing.label} is on the salary of ${names.join(', ')}${paid.length >= 10 ? ' and others' : ''}. Take it off their salaries first.`)
  }
  const closed = await closedMonthKeys(ctx)
  const open = (await repo.enteredMonths(ctx.db, id)).filter((m) => !closed.has(monthKey(m.year, m.month)))
  if (open.length > 0) {
    throw Conflict(`${existing.label} has amounts entered for ${open.map((m) => monthName(m.year, m.month)).join(', ')}, whose payroll is not approved yet. Remove them, or archive it once that payroll is approved.`)
  }

  return withAudit(
    ctx,
    (tx) => repo.updateComponent(tx, id, { archivedAt: new Date() }),
    () => ({ action: 'salary_component.archived', entityType: 'salary_component', entityId: id, details: { code: existing.code, label: existing.label } }),
  )
}

function describe(type: ComponentType, entry: ComponentEntry): string {
  return `${type === 'earning' ? 'an earning' : 'a deduction'} ${entry === 'fixed' ? 'on the salary record' : 'entered each month'}`
}
