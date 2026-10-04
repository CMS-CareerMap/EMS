import type { LoanKind, Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'

/** Loans and salary advances (client §40), and what payslips recovered of them. */

const loanSelect = {
  id: true,
  employeeId: true,
  kind: true,
  amount: true,
  installment: true,
  startYear: true,
  startMonth: true,
  note: true,
  closedAt: true,
  closedNote: true,
  createdAt: true,
  employee: { select: { id: true, employeeCode: true, fullName: true } },
  recoveries: { select: { amount: true, payslip: { select: { year: true, month: true, run: { select: { status: true } } } } } },
} as const

export type LoanRow = Prisma.EmployeeLoanGetPayload<{ select: typeof loanSelect }>

/** Every loan of the people in `people`, open ones first. */
export async function listLoans(db: ScopedDb, people: Prisma.EmployeeWhereInput) {
  return db.employeeLoan.findMany({
    where: { employee: people },
    select: loanSelect,
    orderBy: [{ closedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
    take: 500,
  })
}

export async function findLoan(db: ScopedDb | TxDb, id: string): Promise<LoanRow | null> {
  return db.employeeLoan.findFirst({ where: { id }, select: loanSelect })
}

export async function createLoan(
  tx: TxDb,
  data: { organizationId: string; employeeId: string; kind: LoanKind; amount: number; installment: number; startYear: number; startMonth: number; note: string | null; createdByUserId: string },
) {
  return tx.employeeLoan.create({ data, select: { id: true } })
}

export async function closeLoan(tx: TxDb, id: string, data: { closedAt: Date; closedNote: string; closedByUserId: string }): Promise<number> {
  return (await tx.employeeLoan.updateMany({ where: { id, closedAt: null }, data })).count
}

export async function deleteLoan(tx: TxDb, id: string): Promise<void> {
  await tx.employeeLoan.delete({ where: { id } })
}

/** Somebody to lend to: on the books, within reach. */
export async function borrower(db: ScopedDb, employeeId: string, people: Prisma.EmployeeWhereInput) {
  return db.employee.findFirst({
    where: { AND: [{ id: employeeId, archivedAt: null }, people] },
    select: { id: true, fullName: true, lastWorkingDate: true },
  })
}
