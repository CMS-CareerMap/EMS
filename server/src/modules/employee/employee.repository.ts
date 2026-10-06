import type { Prisma, EmployeeStatus } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import type { ScopeContext } from '../../platform/authz/scope'
import { employeesInScope } from '../../platform/authz/scopeWhere'
import { equalsInsensitive, sameInsensitive } from '../../platform/db/insensitive'

/**
 * Reading employees, filtered by what the caller is allowed to see.
 *
 * Two independent restrictions apply to every query here, and confusing them is
 * how data leaks:
 *
 *   COMPANY   handled above this file. `db` is already a forOrg() client, so
 *             organizationId is injected into every query whether or not this
 *             code remembers it.
 *   SCOPE     handled here. Which PEOPLE within that company — everyone, the
 *             caller's direct reports, or only the caller.
 *
 * Every exported function takes `scope` as a required argument. That is not
 * politeness; it means a caller cannot forget it, because leaving it out does
 * not compile.
 */

export interface FieldAccess {
  includeCompensation: boolean
  /**
   * WHOSE salaries, when includeCompensation (Day 21). Narrower than whose
   * records: the client wants HR to read employee records company-wide but
   * never the pay of the people above them.
   */
  compensationScope: ScopeContext
  includeBank: boolean
  includeIdentity: boolean
  /**
   * Every login of the person — each email, role and status (Day 23). For
   * whoever manages logins; anybody else reading the directory sees the work
   * email only, not who holds a Super Admin or an Accounts login.
   */
  includeLogins: boolean
  /** Today on the company's calendar — where each person stands in the lifecycle is worked out from it. */
  today: string
  /**
   * Whose resignation, before it is accepted, shows as "Resigned" — and whose
   * exit reason shows: everybody's for the Super Admin and whoever runs the
   * lifecycle, except records not theirs to run (`notTheirs`: a senior's, or
   * a fellow runner's); otherwise one's own and one's direct reports' (whom
   * one decides).
   */
  lifecycleOf: { everybody: boolean; employeeId: string | null; notTheirs: readonly string[] }
}

export interface EmployeeFilters {
  search?: string | undefined
  departmentId?: string | undefined
  status?: EmployeeStatus | undefined
  includeArchived?: boolean | undefined
}

/** The data scope as a where clause — one definition for every module (platform/authz/scopeWhere). */
const scopeWhere = employeesInScope

/**
 * The salary record in force, with its component amounts.
 *
 * A named constant rather than an inline literal so that Prisma can see the
 * nested include through the conditional spread below — inline, the literal
 * types widen and the component rows vanish from the payload type.
 */
const CURRENT_SALARY = {
  where: { effectiveTo: null },
  orderBy: { effectiveFrom: 'desc' },
  take: 1,
  include: {
    components: {
      include: { component: { select: { code: true, label: true, type: true } } },
      orderBy: { component: { displayOrder: 'asc' } },
    },
  },
} satisfies Prisma.Employee$financialsArgs

/**
 * What to join, decided by permission.
 *
 * The three sensitive tables are not fetched at all unless the caller may see
 * them. Fetching and then omitting in the serializer would work right up until
 * someone adds a log line, an export, or a debug response — and salary would be
 * in the process, available to be leaked. It is not read in the first place.
 */
function includeFor(access: FieldAccess) {
  return {
    department: { select: { id: true, name: true } },
    designation: { select: { id: true, name: true } },
    shift: { select: { id: true, name: true, startTime: true, endTime: true, expectedHours: true } },
    reportingManager: {
      // archivedAt: a manager who has left decides nothing (Day 22) — the page says so.
      select: { id: true, fullName: true, employeeCode: true, archivedAt: true, designation: { select: { name: true } } },
    },
    // An open resignation: where they stand in the lifecycle depends on it.
    resignations: { where: { status: { in: ['submitted', 'accepted'] } }, select: { status: true }, take: 1 },
    // Every login of theirs (Day 23) — an employee login, and a role login
    // beside it for somebody with a role — oldest first. The password hash is
    // read only to say whether one is set; the serializer sends that, not it.
    memberships: {
      select: { id: true, role: true, roleDef: { select: { name: true, locked: true } }, status: true, user: { select: { email: true, passwordHash: true } } },
      orderBy: { createdAt: 'asc' },
    },

    // Salaries outside the caller's salary scope are not read at all; the
    // serializer leaves their fields out for the same people (isInScope).
    ...(access.includeCompensation
      ? { financials: { ...CURRENT_SALARY, where: { effectiveTo: null, employee: employeesInScope(access.compensationScope) } } }
      : {}),
    ...(access.includeBank ? { bankAccount: true } : {}),
    ...(access.includeIdentity ? { statutoryIdentity: true } : {}),
  } satisfies Prisma.EmployeeInclude
}

/**
 * An employee as the repository returns it.
 *
 * Built in two steps because Prisma cannot type an OPTIONAL nested include —
 * given `financials?: {...}` it falls back to the bare row and the component
 * amounts disappear from the type. So the payload is computed as if salary
 * were always fetched, and then made optional again, which is the truth: it is
 * only there when the caller may see it.
 */
type WithSalary = Prisma.EmployeeGetPayload<{
  include: Omit<ReturnType<typeof includeFor>, 'financials'> & { financials: typeof CURRENT_SALARY }
}>

export type EmployeeRow = Omit<WithSalary, 'financials'> & {
  financials?: WithSalary['financials']
}

function filterWhere(filters: EmployeeFilters): Prisma.EmployeeWhereInput {
  const where: Prisma.EmployeeWhereInput = {}

  if (!filters.includeArchived) where.archivedAt = null
  if (filters.departmentId) where.departmentId = filters.departmentId
  if (filters.status) where.status = filters.status

  if (filters.search) {
    const search = filters.search.trim()
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { employeeCode: { contains: search, mode: 'insensitive' } },
        { personalEmail: { contains: search, mode: 'insensitive' } },
      ]
    }
  }

  return where
}

export async function list(
  db: ScopedDb,
  scope: ScopeContext,
  access: FieldAccess,
  filters: EmployeeFilters = {},
): Promise<EmployeeRow[]> {
  return db.employee.findMany({
    where: { AND: [scopeWhere(scope), filterWhere(filters)] },
    include: includeFor(access),
    orderBy: [{ fullName: 'asc' }],
  }) as Promise<EmployeeRow[]>
}

export async function count(
  db: ScopedDb,
  scope: ScopeContext,
  filters: EmployeeFilters = {},
): Promise<number> {
  return db.employee.count({ where: { AND: [scopeWhere(scope), filterWhere(filters)] } })
}

/**
 * One employee by id — SCOPED, which is the whole point.
 *
 * findUnique is deliberately not used. It accepts only the unique key, so the
 * scope could not be applied and any employee could read any other by changing
 * a uuid in the URL. That is the classic IDOR hole, and "it is a by-id read, it
 * does not need filtering" is exactly how it gets written.
 *
 * Out of scope returns null, and the service turns that into 404 rather than
 * 403 — because 403 would confirm the row exists.
 */
export async function findById(
  db: ScopedDb,
  scope: ScopeContext,
  id: string,
  access: FieldAccess,
): Promise<EmployeeRow | null> {
  return db.employee.findFirst({
    where: { AND: [{ id }, scopeWhere(scope)] },
    include: includeFor(access),
  }) as Promise<EmployeeRow | null>
}

// ─── Writes ─────────────────────────────────────────────────────────────────
//
// Scope is for reading. A write acts on a row the service has already found
// through a scoped read, or on a new row it is creating — and the company
// filter still applies to every one of these, through the client.

/**
 * Somebody whose Employee ID is this one whatever the letters' case — left or
 * not, as the database's own uniqueness counts them. For keeping IDs that
 * would sign in to two people apart.
 */
export async function employeeWithCodeLike(db: TxDb | ScopedDb, code: string, exceptEmployeeId?: string) {
  const rows = await db.employee.findMany({
    where: {
      employeeCode: equalsInsensitive(code),
      ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}),
    },
    select: { id: true, fullName: true, employeeCode: true },
    take: 2,
  })
  return rows.find((row) => sameInsensitive(row.employeeCode, code)) ?? null
}

export async function createEmployee(db: TxDb, data: Prisma.EmployeeUncheckedCreateInput) {
  return db.employee.create({ data })
}

export async function updateEmployee(db: TxDb, id: string, data: Record<string, unknown>) {
  return db.employee.update({ where: { id }, data })
}

/**
 * Somebody named as a reporting manager — in this company, whatever the
 * caller's scope: who people report to is the company tree, not a list
 * somebody can see.
 */
export async function managerCandidate(db: TxDb, id: string) {
  return db.employee.findFirst({ where: { id }, select: { id: true, fullName: true, archivedAt: true } })
}

/** Out of the active list; attendance, leave and payslips stay attached. */
export async function createStatutoryIdentity(db: TxDb, data: Prisma.EmployeeStatutoryIdentityUncheckedCreateInput) {
  return db.employeeStatutoryIdentity.create({ data })
}

export async function upsertStatutoryIdentity(
  db: TxDb,
  employeeId: string,
  update: Record<string, unknown>,
  create: Prisma.EmployeeStatutoryIdentityUncheckedCreateInput,
) {
  return db.employeeStatutoryIdentity.upsert({ where: { employeeId }, update, create })
}

/** Every code in use, archived people included: a code is never reissued. */
export async function listEmployeeCodes(db: ScopedDb) {
  return db.employee.findMany({ select: { employeeCode: true } })
}

/** Name, code and placement — the top of somebody's own dashboard. */
export async function findCard(db: ScopedDb, id: string) {
  return db.employee.findFirst({
    where: { id },
    select: {
      fullName: true,
      employeeCode: true,
      dateOfJoining: true,
      attendanceMode: true,
      phone: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
      reportingManager: { select: { fullName: true, archivedAt: true, designation: { select: { name: true } } } },
    },
  })
}

/** A shift's name, for the audit log's old and new values. */
export async function shiftName(db: TxDb, id: string | null): Promise<string | null> {
  if (!id) return null
  return (await db.shift.findFirst({ where: { id }, select: { name: true } }))?.name ?? null
}
