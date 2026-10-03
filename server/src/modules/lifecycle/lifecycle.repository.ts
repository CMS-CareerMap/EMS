import type { EmploymentEventKind, ExitReason, Prisma, ResignationStatus } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import type { ScopeContext } from '../../platform/authz/scope'
import { employeesInScope } from '../../platform/authz/scopeWhere'

/**
 * The employee lifecycle (client §43): the dates on a person's record, their
 * resignations, and their employment history.
 */

type Db = ScopedDb | TxDb

/** A resignation still running: handed in, or accepted and being served. */
export const OPEN_RESIGNATION: ResignationStatus[] = ['submitted', 'accepted']

const resignationSelect = {
  id: true,
  employeeId: true,
  status: true,
  reason: true,
  submittedOn: true,
  requestedLastDay: true,
  lastWorkingDay: true,
  submittedByUserId: true,
  decidedByUserId: true,
  decidedAt: true,
  decisionNote: true,
  closedByUserId: true,
  closedAt: true,
  closeNote: true,
  updatedAt: true,
} as const

export type ResignationRow = Prisma.ResignationGetPayload<{ select: typeof resignationSelect }>

const personSelect = {
  id: true,
  fullName: true,
  employeeCode: true,
  status: true,
  archivedAt: true,
  dateOfJoining: true,
  onboardedOn: true,
  probationEndDate: true,
  confirmedOn: true,
  lastWorkingDate: true,
  exitReason: true,
  departmentId: true,
  designationId: true,
  reportingManagerId: true,
  department: { select: { id: true, name: true } },
  designation: { select: { id: true, name: true } },
  resignations: { where: { status: { in: OPEN_RESIGNATION } }, orderBy: { createdAt: 'desc' as const }, take: 1, select: resignationSelect },
} as const

export type PersonRow = Prisma.EmployeeGetPayload<{ select: typeof personSelect }>

/** One person, through the caller's employee scope — or the whole company, given null. Archived people included. */
export async function findPerson(db: Db, scope: ScopeContext | null, id: string): Promise<PersonRow | null> {
  return db.employee.findFirst({
    where: scope ? { AND: [{ id }, employeesInScope(scope)] } : { id },
    select: personSelect,
  })
}

/** Everybody still here the scope reaches — what the dashboard's lifecycle card counts. */
export async function peopleInScope(db: ScopedDb, scope: ScopeContext): Promise<PersonRow[]> {
  return db.employee.findMany({
    where: { AND: [{ archivedAt: null }, employeesInScope(scope)] },
    select: personSelect,
    orderBy: { fullName: 'asc' },
  })
}

export async function updatePerson(
  tx: TxDb,
  id: string,
  data: Partial<{
    onboardedOn: Date | null
    probationEndDate: Date | null
    confirmedOn: Date | null
    lastWorkingDate: Date | null
    exitReason: ExitReason | null
    status: 'active' | 'inactive'
    archivedAt: Date
    departmentId: string | null
    designationId: string | null
    reportingManagerId: string | null
  }>,
): Promise<void> {
  await tx.employee.update({ where: { id }, data })
}

export async function lifecycleSettings(db: Db, organizationId: string) {
  return db.organization.findUnique({ where: { id: organizationId }, select: { probationMonths: true, noticePeriodDays: true } })
}

export async function updateLifecycleSettings(tx: TxDb, organizationId: string, data: { probationMonths: number; noticePeriodDays: number }): Promise<void> {
  await tx.organization.update({ where: { id: organizationId }, data })
}

// ─── History ────────────────────────────────────────────────────────────────

export async function addEvent(
  tx: TxDb,
  values: {
    organizationId: string
    employeeId: string
    kind: EmploymentEventKind
    effectiveDate: Date
    details?: Prisma.InputJsonValue
    note?: string | null
    createdByUserId: string | null
  },
): Promise<void> {
  await tx.employmentEvent.create({ data: { ...values, details: values.details ?? {} } })
}

export async function eventsOf(db: Db, employeeId: string) {
  return db.employmentEvent.findMany({
    where: { employeeId },
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, kind: true, effectiveDate: true, details: true, note: true, createdByUserId: true, createdAt: true },
    take: 500,
  })
}

// ─── Resignations ───────────────────────────────────────────────────────────

export async function findResignation(db: Db, id: string): Promise<ResignationRow | null> {
  return db.resignation.findFirst({ where: { id }, select: resignationSelect })
}

/** The most recent resignation of this person, open or not — what their page shows. */
export async function latestResignation(db: Db, employeeId: string): Promise<ResignationRow | null> {
  return db.resignation.findFirst({ where: { employeeId }, orderBy: { createdAt: 'desc' }, select: resignationSelect })
}

export async function createResignation(
  tx: TxDb,
  values: {
    organizationId: string
    employeeId: string
    reason: string
    submittedOn: Date
    requestedLastDay: Date
    submittedByUserId: string
  },
): Promise<ResignationRow> {
  return tx.resignation.create({ data: values, select: resignationSelect })
}

/**
 * Moves a resignation on — only from the status it was read in, so two people
 * acting on it at once cannot both succeed. Returns how many rows moved.
 */
export async function moveResignation(
  tx: TxDb,
  id: string,
  from: ResignationStatus[],
  data: Partial<{
    status: ResignationStatus
    lastWorkingDay: Date | null
    decidedByUserId: string
    decidedAt: Date
    decisionNote: string | null
    closedByUserId: string
    closedAt: Date
    closeNote: string | null
  }>,
): Promise<number> {
  const result = await tx.resignation.updateMany({ where: { id, status: { in: from } }, data })
  return result.count
}

/** A person who left: whatever resignation was still open is finished with. */
export async function completeOpenResignations(tx: TxDb, employeeId: string, userId: string): Promise<void> {
  await tx.resignation.updateMany({
    where: { employeeId, status: { in: OPEN_RESIGNATION } },
    data: { status: 'completed', closedByUserId: userId, closedAt: new Date() },
  })
}

/** This person's resignation waiting for acceptance, if any — whose decider is told after a move in the tree. */
export async function submittedResignationOf(db: Db, employeeId: string) {
  return db.resignation.findFirst({
    where: { employeeId, status: 'submitted' },
    select: { id: true, employee: { select: { fullName: true } } },
  })
}

/** Every resignation waiting for acceptance, with whose it is — for "waiting for you". */
export async function submittedResignations(db: Db) {
  return db.resignation.findMany({
    where: { status: 'submitted', employee: { archivedAt: null } },
    orderBy: { submittedOn: 'asc' },
    select: { ...resignationSelect, employee: { select: { fullName: true, employeeCode: true, department: { select: { name: true } }, designation: { select: { name: true } } } } },
  })
}

// ─── Onboarding ─────────────────────────────────────────────────────────────

/** What onboarding asks of a person, as facts: a login, the required documents, a checked bank account, a manager. */
export async function onboardingFacts(db: Db, employeeId: string) {
  const [person, required, bank] = await Promise.all([
    db.employee.findFirst({
      where: { id: employeeId },
      select: { reportingManagerId: true, memberships: { select: { status: true } }, statutoryIdentity: { select: { pan: true } } },
    }),
    db.documentType.findMany({ where: { required: true, archivedAt: null }, select: { id: true } }),
    db.employeeBankAccount.findFirst({ where: { employeeId }, select: { verificationStatus: true } }),
  ])
  const verified = required.length
    ? await db.employeeDocument.count({
        where: { employeeId, documentTypeId: { in: required.map((t) => t.id) }, status: 'verified', supersededAt: null, removedAt: null },
      })
    : 0
  return {
    loginActive: Boolean(person?.memberships.some((m) => m.status === 'active')),
    loginInvited: Boolean(person?.memberships.some((m) => m.status === 'invited')),
    requiredDocuments: required.length,
    verifiedDocuments: verified,
    bankStatus: bank?.verificationStatus ?? null,
    hasManager: Boolean(person?.reportingManagerId),
    panRecorded: Boolean(person?.statutoryIdentity?.pan),
  }
}

/** A department or designation by name, for the history — as it reads when the step is taken. */
export async function departmentName(db: Db, id: string | null): Promise<string | null> {
  if (!id) return null
  return (await db.department.findFirst({ where: { id }, select: { name: true } }))?.name ?? null
}

export async function designationName(db: Db, id: string | null): Promise<string | null> {
  if (!id) return null
  return (await db.designation.findFirst({ where: { id }, select: { name: true } }))?.name ?? null
}

/** A person's name, for the history ("now reports to …"). */
export async function employeeName(db: Db, id: string | null): Promise<string | null> {
  if (!id) return null
  return (await db.employee.findFirst({ where: { id }, select: { fullName: true } }))?.fullName ?? null
}

/** The users behind every login of a person — to tell whether they did something themselves. */
export async function loginUsersOf(db: Db, employeeId: string): Promise<string[]> {
  return (await db.membership.findMany({ where: { employeeId }, select: { userId: true } })).map((m) => m.userId)
}

/** Who did a step, by name — their person's name, else the login's email. */
export async function namesOfUsers(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)].filter(Boolean)
  if (ids.length === 0) return new Map()
  const rows = await db.membership.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, user: { select: { email: true } }, employee: { select: { fullName: true } } },
  })
  return new Map(rows.map((r) => [r.userId, r.employee?.fullName ?? r.user.email]))
}
