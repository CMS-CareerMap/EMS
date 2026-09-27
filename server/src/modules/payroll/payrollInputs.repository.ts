import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'

/**
 * What people enter for a payroll month, as opposed to what is calculated:
 * the accountant's TDS directives, and amounts for monthly components such as
 * Incentive.
 */

const briefEmployee = { select: { id: true, employeeCode: true, fullName: true } } as const

/** Enough of an employee to check they can be paid, and to name them. */
export async function findEmployeeBrief(db: ScopedDb, employeeId: string) {
  return db.employee.findFirst({
    where: { id: employeeId, archivedAt: null },
    select: { id: true, employeeCode: true, fullName: true, dateOfJoining: true, lastWorkingDate: true },
  })
}

// ── TDS directives ──────────────────────────────────────────────────────────

/** Every directive of a financial year for these employees, oldest first. */
export async function directivesFor(db: ScopedDb, employeeIds: string[], financialYear: number) {
  return db.employeeTdsDirective.findMany({
    where: { employeeId: { in: employeeIds }, financialYear },
    orderBy: { effectiveFrom: 'asc' },
  })
}

export type DirectiveRow = Awaited<ReturnType<typeof directivesFor>>[number]

export async function listDirectives(db: ScopedDb, financialYear: number) {
  return db.employeeTdsDirective.findMany({
    where: { financialYear },
    include: { employee: briefEmployee },
    orderBy: [{ employee: { employeeCode: 'asc' } }, { effectiveFrom: 'asc' }],
  })
}

export type ListedDirective = Awaited<ReturnType<typeof listDirectives>>[number]

export async function findDirective(db: TxDb, employeeId: string, effectiveFrom: Date) {
  return db.employeeTdsDirective.findFirst({ where: { employeeId, effectiveFrom } })
}

export interface DirectiveValues {
  financialYear: number
  monthlyAmount: number
  reason: string | null
  enteredByUserId: string
}

/** Creates the directive for that month, or corrects the one already there. */
export async function saveDirective(
  tx: TxDb,
  organizationId: string,
  employeeId: string,
  effectiveFrom: Date,
  values: DirectiveValues,
) {
  const existing = await findDirective(tx, employeeId, effectiveFrom)
  const saved = existing
    ? await tx.employeeTdsDirective.update({ where: { id: existing.id }, data: values })
    : await tx.employeeTdsDirective.create({ data: { organizationId, employeeId, effectiveFrom, ...values } })

  return tx.employeeTdsDirective.findFirstOrThrow({ where: { id: saved.id }, include: { employee: briefEmployee } })
}

// ── Monthly entries ─────────────────────────────────────────────────────────

export async function entriesForMonth(db: ScopedDb, year: number, month: number) {
  return db.employeeMonthlyEntry.findMany({
    where: { year, month },
    include: {
      employee: briefEmployee,
      component: { select: { id: true, code: true, label: true, type: true, entry: true } },
    },
    orderBy: [{ employee: { employeeCode: 'asc' } }, { component: { displayOrder: 'asc' } }],
  })
}

export type EntryRow = Awaited<ReturnType<typeof entriesForMonth>>[number]

export async function findEntry(db: ScopedDb, id: string) {
  return db.employeeMonthlyEntry.findFirst({
    where: { id },
    include: {
      employee: briefEmployee,
      component: { select: { id: true, code: true, label: true, type: true, entry: true } },
    },
  })
}

/** A component of the company's catalogue by code, if it is still in use. */
export async function findComponentByCode(db: ScopedDb, code: string) {
  return db.salaryComponent.findFirst({ where: { code, archivedAt: null } })
}

export interface EntryKey {
  employeeId: string
  salaryComponentId: string
  year: number
  month: number
}

/** Creates the entry for that month, or replaces the amount already there. */
export async function saveEntry(
  tx: TxDb,
  organizationId: string,
  key: EntryKey,
  values: { amount: number; note: string | null; enteredByUserId: string },
) {
  const existing = await tx.employeeMonthlyEntry.findFirst({ where: key })
  const saved = existing
    ? await tx.employeeMonthlyEntry.update({ where: { id: existing.id }, data: values })
    : await tx.employeeMonthlyEntry.create({ data: { organizationId, ...key, ...values } })

  return {
    previous: existing ? { amount: Number(existing.amount), note: existing.note } : null,
    saved: await tx.employeeMonthlyEntry.findFirstOrThrow({
      where: { id: saved.id },
      include: {
        employee: briefEmployee,
        component: { select: { id: true, code: true, label: true, type: true, entry: true } },
      },
    }),
  }
}

export async function deleteEntry(tx: TxDb, id: string): Promise<void> {
  await tx.employeeMonthlyEntry.deleteMany({ where: { id } })
}
