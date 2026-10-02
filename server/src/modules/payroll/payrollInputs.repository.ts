import type { Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'

/**
 * What people enter for a payroll month, as opposed to what is calculated:
 * the accountant's TDS directives, and amounts for monthly components such as
 * Incentive.
 */

const briefEmployee = { select: { id: true, employeeCode: true, fullName: true } } as const

/** Enough of an employee to check they can be paid, and to name them. */
export async function findEmployeeBrief(db: ScopedDb, employeeId: string, people: Prisma.EmployeeWhereInput | null = null) {
  return db.employee.findFirst({
    where: { AND: [{ id: employeeId, archivedAt: null }, people ?? {}] },
    select: { id: true, employeeCode: true, fullName: true, dateOfJoining: true, lastWorkingDate: true },
  })
}

/** Whether this person is among `people` — for an entry found by its own id. */
export async function employeeAmong(db: ScopedDb, employeeId: string, people: Prisma.EmployeeWhereInput): Promise<boolean> {
  return (await db.employee.count({ where: { AND: [{ id: employeeId }, people] } })) > 0
}

/**
 * Everybody still here who is not among `people` — whose amounts the caller
 * may not see or enter. Worked out as all minus those inside, not with NOT:
 * the scope for "everybody" is `{}`, and NOT of an empty filter is ignored —
 * it would have put the whole company outside.
 */
export async function idsOutside(db: ScopedDb, people: Prisma.EmployeeWhereInput): Promise<string[]> {
  const [all, inside] = await Promise.all([
    db.employee.findMany({ where: { archivedAt: null }, select: { id: true } }),
    db.employee.findMany({ where: { AND: [{ archivedAt: null }, people] }, select: { id: true } }),
  ])
  const among = new Set(inside.map((r) => r.id))
  return all.map((r) => r.id).filter((id) => !among.has(id))
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

/** The month's entries — only those of `people`, when given (the incentives of the people whose pay the caller may see). */
export async function entriesForMonth(db: ScopedDb, year: number, month: number, people: Prisma.EmployeeWhereInput | null = null) {
  return db.employeeMonthlyEntry.findMany({
    where: { year, month, ...(people ? { employee: people } : {}) },
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
