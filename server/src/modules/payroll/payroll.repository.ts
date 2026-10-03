import type { ScopedDb } from '../../platform/db/scoped'

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
      state: { equals: state, mode: 'insensitive' },
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

/** Removes a period's decision so it can be taken again. Redecide only. */
export async function deleteCoverage(db: ScopedDb, employeeId: string, periodStart: Date) {
  return db.esiCoverage.deleteMany({ where: { employeeId, periodStart } })
}
