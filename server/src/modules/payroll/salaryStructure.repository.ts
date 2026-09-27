import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'

/**
 * Salary structures: who is paid what, and since when.
 *
 * Every read here returns history as well as the present, because a salary is
 * never edited in place. A raise closes the old record and opens a new one;
 * the payslip for last March must still be explained by last March's figures.
 */

const withComponents = {
  components: {
    include: { component: { select: { code: true, label: true, type: true, displayOrder: true } } },
    orderBy: { component: { displayOrder: 'asc' as const } },
  },
}

/** Every salary record for one employee, newest first. */
export async function listHistory(db: ScopedDb, employeeId: string) {
  return db.employeeFinancial.findMany({
    where: { employeeId },
    orderBy: { effectiveFrom: 'desc' },
    include: withComponents,
  })
}

/** The record nobody has closed yet. */
export async function findOpen(db: TxDb, employeeId: string) {
  return db.employeeFinancial.findFirst({
    where: { employeeId, effectiveTo: null },
    orderBy: { effectiveFrom: 'desc' },
  })
}

/**
 * Everybody on the payroll with their current salary, for the Salary tab.
 *
 * Accounts holds no `employee:read` — the client's matrix keeps the HR
 * directory away from them — so this is the one list of people they can see,
 * and it carries only what setting a salary needs.
 */
export async function listRoster(db: ScopedDb) {
  return db.employee.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      dateOfJoining: true,
      lastWorkingDate: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
      financials: {
        where: { effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
        take: 1,
        include: withComponents,
      },
    },
    orderBy: { fullName: 'asc' },
  })
}

export async function findEmployee(db: ScopedDb, employeeId: string) {
  return db.employee.findFirst({
    where: { id: employeeId },
    select: { id: true, fullName: true, dateOfJoining: true },
  })
}

export async function listActiveComponents(db: ScopedDb) {
  return db.salaryComponent.findMany({ where: { archivedAt: null } })
}

export interface ComponentAmount {
  salaryComponentId: string
  amount: number
}

/**
 * Opens a new salary record from `effectiveFrom`, closing the open one the day
 * before. On the caller's transaction — the service holds it, with a lock, so
 * a crash between the two leaves neither two open records nor none.
 */
export async function openNew(
  db: TxDb,
  organizationId: string,
  input: {
    employeeId: string
    effectiveFrom: Date
    closePreviousOn: Date | null
    previousId: string | null
    ctc: number
    components: ComponentAmount[]
  },
) {
  if (input.previousId && input.closePreviousOn) {
    await db.employeeFinancial.update({
      where: { id: input.previousId },
      data: { effectiveTo: input.closePreviousOn },
    })
  }

  return db.employeeFinancial.create({
    data: {
      organizationId,
      employeeId: input.employeeId,
      ctc: input.ctc,
      effectiveFrom: input.effectiveFrom,
      components: {
        create: input.components.map((c) => ({
          organizationId,
          salaryComponentId: c.salaryComponentId,
          amount: c.amount,
        })),
      },
    },
  })
}

/**
 * Corrects the open record in place — a typo caught before anything was paid
 * on it. Same record, same dates; only the figures change.
 */
export async function correctOpen(
  db: TxDb,
  organizationId: string,
  input: { financialId: string; ctc: number; components: ComponentAmount[] },
) {
  await db.employeeSalaryComponent.deleteMany({ where: { employeeFinancialId: input.financialId } })
  return db.employeeFinancial.update({
    where: { id: input.financialId },
    data: {
      ctc: input.ctc,
      components: {
        create: input.components.map((c) => ({
          organizationId,
          salaryComponentId: c.salaryComponentId,
          amount: c.amount,
        })),
      },
    },
  })
}
