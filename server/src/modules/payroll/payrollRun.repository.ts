import { randomUUID } from 'node:crypto'
import type { Prisma, LopBasis } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'

/**
 * Payroll runs and the payslips inside them.
 *
 * The reads that assemble a month are here too, each for the whole company at
 * once: one query for everybody's attendance rather than one a person. A run
 * for a hundred people must not be a thousand round trips to the database.
 */

// ── What a month is made of ─────────────────────────────────────────────────

/**
 * Everybody employed at some point in the month, and not deleted. Who is
 * actually paid is decided by the service — this is the list it decides from.
 */
export async function employeesForMonth(db: ScopedDb, monthStart: Date, monthEnd: Date) {
  return db.employee.findMany({
    where: {
      archivedAt: null,
      AND: [
        { OR: [{ dateOfJoining: null }, { dateOfJoining: { lte: monthEnd } }] },
        { OR: [{ lastWorkingDate: null }, { lastWorkingDate: { gte: monthStart } }] },
      ],
    },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      status: true,
      dateOfJoining: true,
      lastWorkingDate: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
    },
    orderBy: { employeeCode: 'asc' },
  })
}

export type MonthEmployee = Awaited<ReturnType<typeof employeesForMonth>>[number]

/** Salary records that overlap the month — enough to say who has none. */
export async function salariesForMonth(db: ScopedDb, employeeIds: string[], monthStart: Date, monthEnd: Date) {
  return db.employeeFinancial.findMany({
    where: {
      employeeId: { in: employeeIds },
      effectiveFrom: { lte: monthEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
    },
    select: { employeeId: true, effectiveFrom: true, effectiveTo: true },
  })
}

/** Policy periods that overlap the month. Usually one; two when the rules changed during it. */
export async function policiesForMonth(db: ScopedDb, monthStart: Date, monthEnd: Date) {
  return db.organizationPolicy.findMany({
    where: {
      effectiveFrom: { lte: monthEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: monthStart } }],
    },
    select: {
      id: true,
      effectiveFrom: true,
      effectiveTo: true,
      weeklyOffDays: true,
      lopBasis: true,
      sandwichRule: true,
    },
    orderBy: { effectiveFrom: 'asc' },
  })
}

export async function attendanceForMonth(db: ScopedDb, employeeIds: string[], monthStart: Date, monthEnd: Date) {
  return db.attendance.findMany({
    where: { employeeId: { in: employeeIds }, date: { gte: monthStart, lte: monthEnd } },
    select: { employeeId: true, date: true, status: true },
  })
}

/** Approved leave, and leave still waiting for a decision, that touches the month. */
export async function leaveForMonth(db: ScopedDb, employeeIds: string[], monthStart: Date, monthEnd: Date) {
  return db.leaveRequest.findMany({
    where: {
      employeeId: { in: employeeIds },
      status: { in: ['approved', 'pending'] },
      fromDate: { lte: monthEnd },
      toDate: { gte: monthStart },
    },
    select: {
      employeeId: true,
      fromDate: true,
      toDate: true,
      halfDayDates: true,
      status: true,
      leaveType: { select: { name: true, isPaid: true } },
    },
  })
}

// ── Runs ────────────────────────────────────────────────────────────────────

export async function findRunForMonth(db: TxDb, year: number, month: number) {
  return db.payrollRun.findFirst({ where: { year, month } })
}

export async function findRun(db: ScopedDb, id: string) {
  return db.payrollRun.findFirst({ where: { id } })
}

export type RunRow = NonNullable<Awaited<ReturnType<typeof findRun>>>

export async function listRuns(db: ScopedDb) {
  return db.payrollRun.findMany({ orderBy: [{ year: 'desc' }, { month: 'desc' }] })
}

/**
 * Runs that are no longer drafts, from a month onwards. A month with one of
 * these is closed: nothing that feeds it may change.
 */
export async function closedRunsFrom(db: ScopedDb, year: number, month: number) {
  return db.payrollRun.findMany({
    where: {
      status: { not: 'draft' },
      OR: [{ year: { gt: year } }, { year, month: { gte: month } }],
    },
    select: { year: true, month: true, status: true },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  })
}

export interface RunValues {
  lopBasis: LopBasis
  sandwichRule: boolean
  employeeCount: number
  grossEarnings: number
  totalDeductions: number
  netPayable: number
  employerPf: number
  employerEsi: number
  warnings: string[]
  calculatedAt: Date
}

export async function createRun(
  tx: TxDb,
  organizationId: string,
  data: RunValues & { year: number; month: number; createdByUserId: string },
) {
  return tx.payrollRun.create({ data: { organizationId, status: 'draft', ...data } })
}

export async function updateRun(tx: TxDb, id: string, data: RunValues) {
  return tx.payrollRun.update({ where: { id }, data })
}

/** Deletes a run only while it is a draft. The count says whether it was. */
export async function deleteDraftRun(tx: TxDb, id: string): Promise<number> {
  return (await tx.payrollRun.deleteMany({ where: { id, status: 'draft' } })).count
}

// ── Payslips ────────────────────────────────────────────────────────────────

export interface NewPayslipLine {
  kind: 'earning' | 'deduction'
  code: string
  label: string
  rate: number | null
  amount: number
  displayOrder: number
}

export interface NewPayslip {
  employeeId: string
  year: number
  month: number
  employeeCode: string
  employeeName: string
  designation: string | null
  department: string | null
  daysInMonth: number
  employmentDays: number
  lopDays: number
  paidDays: number
  ncpDays: number
  lopBasis: LopBasis
  payBasisDays: number
  payableDays: number
  grossEarnings: number
  pfWages: number
  employeePf: number
  employeeEsi: number
  professionalTax: number
  tds: number
  otherDeductions: number
  totalDeductions: number
  netPayable: number
  employerPf: number
  employerEps: number
  employerEpf: number
  employerEsi: number
  basis: Prisma.InputJsonValue
  warnings: string[]
  lines: NewPayslipLine[]
}

/**
 * Every payslip of a run and every line of every payslip, in two statements.
 * Ids are made here so the lines can point at their payslip without a round
 * trip per person.
 */
export async function insertPayslips(
  tx: TxDb,
  organizationId: string,
  payrollRunId: string,
  payslips: readonly NewPayslip[],
): Promise<void> {
  const rows = payslips.map((slip) => ({ id: randomUUID(), slip }))

  await tx.payslip.createMany({
    data: rows.map(({ id, slip: { lines: _lines, ...values } }) => ({
      ...values,
      id,
      organizationId,
      payrollRunId,
    })),
  })

  const lines = rows.flatMap(({ id, slip }) =>
    slip.lines.map((line) => ({ ...line, organizationId, payslipId: id })),
  )
  if (lines.length > 0) await tx.payslipLine.createMany({ data: lines })
}

/** Lines go with them — the foreign key cascades. */
export async function deletePayslipsOf(tx: TxDb, payrollRunId: string): Promise<void> {
  await tx.payslip.deleteMany({ where: { payrollRunId } })
}

/** One line per person, for the run's own page. */
export async function payslipSummaries(db: ScopedDb, payrollRunId: string) {
  return db.payslip.findMany({
    where: { payrollRunId },
    select: {
      id: true,
      employeeId: true,
      employeeCode: true,
      employeeName: true,
      daysInMonth: true,
      employmentDays: true,
      lopDays: true,
      paidDays: true,
      grossEarnings: true,
      totalDeductions: true,
      netPayable: true,
      warnings: true,
    },
    orderBy: { employeeCode: 'asc' },
  })
}

export async function findPayslip(db: ScopedDb, payrollRunId: string, payslipId: string) {
  return db.payslip.findFirst({
    where: { id: payslipId, payrollRunId },
    include: { lines: { orderBy: [{ kind: 'asc' }, { displayOrder: 'asc' }] } },
  })
}

export type PayslipRow = NonNullable<Awaited<ReturnType<typeof findPayslip>>>
