import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { equalsInsensitive } from '../../platform/db/insensitive'

/**
 * Everything a salary calculation reads, and nothing it writes.
 *
 * Each query asks for the record IN FORCE on a given date rather than the
 * current one. Recomputing March's payslip in May must see March's salary,
 * March's PF rate and March's PT slabs — a system that reads "current" gets
 * the arithmetic right and the answer wrong.
 */

/** Rows whose period covers `on`: started on or before it, not yet ended. */
function inForceOn(on: Date) {
  return {
    effectiveFrom: { lte: on },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
  }
}

export async function findEmployee(db: ScopedDb, employeeId: string) {
  return db.employee.findFirst({
    where: { id: employeeId },
    select: {
      id: true,
      fullName: true,
      employeeCode: true,
      dateOfJoining: true,
      lastWorkingDate: true,
      gender: true,
      // The pension scheme stops at 58.
      dateOfBirth: true,
      statutoryIdentity: {
        select: { ptState: true, pfApplicable: true, hasPriorPfMembership: true, epsMember: true },
      },
    },
  })
}

/** The salary record in force on a date, with its component amounts. */
export async function findFinancialOn(db: ScopedDb, employeeId: string, on: Date) {
  return db.employeeFinancial.findFirst({
    where: { employeeId, ...inForceOn(on) },
    orderBy: { effectiveFrom: 'desc' },
    include: {
      components: {
        include: { component: true },
        orderBy: { component: { displayOrder: 'asc' } },
      },
    },
  })
}

/** The first salary record — what they were paid when they joined. */
export async function findFirstFinancial(db: ScopedDb, employeeId: string) {
  return db.employeeFinancial.findFirst({
    where: { employeeId },
    orderBy: { effectiveFrom: 'asc' },
    include: { components: { include: { component: true } } },
  })
}

export async function findPolicyOn(db: ScopedDb, on: Date) {
  return db.organizationPolicy.findFirst({
    where: inForceOn(on),
    orderBy: { effectiveFrom: 'desc' },
  })
}

/** Every PT slab for a state that was in force on a date, all genders. */
export async function findPtSlabsOn(db: ScopedDb, state: string, on: Date) {
  return db.ptSlab.findMany({
    where: {
      state: equalsInsensitive(state),
      ...inForceOn(on),
    },
    orderBy: { minGross: 'asc' },
  })
}

export async function listSalaryComponents(db: ScopedDb) {
  return db.salaryComponent.findMany({
    where: { archivedAt: null },
    orderBy: { displayOrder: 'asc' },
  })
}

// ── ESI coverage ────────────────────────────────────────────────────────────

/** The decision already taken for a contribution period, if there is one. */
export async function findCoverage(db: ScopedDb, employeeId: string, periodStart: Date) {
  return db.esiCoverage.findFirst({ where: { employeeId, periodStart } })
}

export async function createCoverage(
  db: ScopedDb,
  organizationId: string,
  data: {
    employeeId: string
    periodStart: Date
    periodEnd: Date
    covered: boolean
    lockedWageRate: number
    reason: string
  },
) {
  return db.esiCoverage.create({ data: { organizationId, ...data } })
}

/** The earliest salary record starting between two days — the first pay of somebody whose record begins mid-period. */
export async function firstFinancialBetween(db: ScopedDb, employeeId: string, from: Date, to: Date) {
  return db.employeeFinancial.findFirst({
    where: { employeeId, effectiveFrom: { gt: from, lte: to } },
    orderBy: { effectiveFrom: 'asc' },
    select: { effectiveFrom: true },
  })
}

/** Every salary record that starts after `from` and by `to`, in order, with its components — the changes inside a month. */
export async function financialsStartingBetween(db: ScopedDb, employeeId: string, from: Date, to: Date) {
  return db.employeeFinancial.findMany({
    where: { employeeId, effectiveFrom: { gt: from, lte: to } },
    orderBy: { effectiveFrom: 'asc' },
    include: { components: { include: { component: true } } },
  })
}

/** Removes a period's decision so it can be taken again. */
export async function deleteCoverage(db: ScopedDb | TxDb, employeeId: string, periodStart: Date) {
  return db.esiCoverage.deleteMany({ where: { employeeId, periodStart } })
}

// ── Overtime, leave encashment and loans (client §35, §36, §40) ─────────────

/** Overtime approved to be paid this month, with what each day was expected to be. */
export async function approvedOvertimeIn(db: ScopedDb, employeeId: string, year: number, month: number) {
  const requests = await db.employeeRequest.findMany({
    where: {
      employeeId,
      type: 'overtime',
      status: 'approved',
      AND: [{ details: { path: ['payYear'], equals: year } }, { details: { path: ['payMonth'], equals: month } }],
    },
    select: { number: true, fromDate: true, details: true },
    orderBy: { fromDate: 'asc' },
  })
  const days = requests.length
    ? await db.attendance.findMany({
        where: { employeeId, date: { in: requests.flatMap((r) => (r.fromDate ? [r.fromDate] : [])) } },
        select: { date: true, expectedHours: true, overtimeMinutes: true, shift: { select: { expectedHours: true } } },
      })
    : []
  return { requests, days }
}

/** Leave encashments approved to be paid with this month's salary. */
export async function encashmentsPaidIn(db: ScopedDb, employeeId: string, year: number, month: number) {
  return db.employeeRequest.findMany({
    where: {
      employeeId,
      type: 'leave_encashment',
      status: 'approved',
      AND: [{ details: { path: ['payYear'], equals: year } }, { details: { path: ['payMonth'], equals: month } }],
    },
    select: { number: true, details: true },
    orderBy: { number: 'asc' },
  })
}

/** Loans and advances still being recovered, from this month or earlier, with what other months' payslips took. */
export async function loansRecoveringIn(db: ScopedDb, employeeId: string, year: number, month: number) {
  const loans = await db.employeeLoan.findMany({
    where: {
      employeeId,
      AND: [
        { OR: [{ startYear: { lt: year } }, { startYear: year, startMonth: { lte: month } }] },
        // Closed after this month's draft recovered from it: the recovery stands,
        // as the amount left was worked out with it.
        { OR: [{ closedAt: null }, { recoveries: { some: { payslip: { year, month } } } }] },
      ],
    },
    select: {
      id: true,
      kind: true,
      amount: true,
      installment: true,
      recoveries: { select: { amount: true, payslip: { select: { year: true, month: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  })
  return loans
}
