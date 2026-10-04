import type { ComponentEntry, ComponentType, Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'

/** Salary components (client §40) — the company's own list of earnings and deductions. */

export async function allComponents(db: ScopedDb) {
  return db.salaryComponent.findMany({ orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { displayOrder: 'asc' }] })
}

export async function findComponent(db: ScopedDb | TxDb, id: string) {
  return db.salaryComponent.findFirst({ where: { id } })
}

/** By code, archived or not — a code is the company's for ever. */
export async function findComponentByCode(db: ScopedDb | TxDb, code: string) {
  return db.salaryComponent.findFirst({ where: { code: { equals: code, mode: 'insensitive' } } })
}

export interface ComponentValues {
  label: string
  type: ComponentType
  entry: ComponentEntry
  countsForPf: boolean
  countsForEsi: boolean
  countsForPt: boolean
  taxable: boolean
  displayOrder: number
}

export async function createComponent(tx: TxDb, organizationId: string, code: string, values: ComponentValues) {
  return tx.salaryComponent.create({ data: { organizationId, code, ...values } })
}

export async function updateComponent(tx: TxDb, id: string, data: Prisma.SalaryComponentUpdateInput) {
  return tx.salaryComponent.update({ where: { id }, data })
}

export async function nextDisplayOrder(db: ScopedDb): Promise<number> {
  const top = await db.salaryComponent.aggregate({ _max: { displayOrder: true } })
  return (top._max.displayOrder ?? 0) + 1
}

/** Whether anybody's salary record or monthly entry uses it — its type and entry are then settled. */
export async function componentInUse(db: ScopedDb, id: string): Promise<boolean> {
  const [amounts, entries] = await Promise.all([
    db.employeeSalaryComponent.count({ where: { salaryComponentId: id } }),
    db.employeeMonthlyEntry.count({ where: { salaryComponentId: id } }),
  ])
  return amounts + entries > 0
}

/** People whose salary record in force today or later pays it. */
export async function paidOnSalaries(db: ScopedDb, id: string, today: Date) {
  return db.employeeSalaryComponent.findMany({
    where: { salaryComponentId: id, financial: { OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] } },
    select: { financial: { select: { employee: { select: { fullName: true } } } } },
    take: 10,
  })
}

/** Months with an amount entered against it. */
export async function enteredMonths(db: ScopedDb, id: string) {
  return db.employeeMonthlyEntry.findMany({ where: { salaryComponentId: id }, select: { year: true, month: true }, distinct: ['year', 'month'] })
}
