import type { Prisma, LeaveStatus } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import type { ScopeContext } from '../../platform/authz/scope'
import { employeesInScope, ownedRowsInScope } from '../../platform/authz/scopeWhere'

/**
 * Leave requests and balances.
 *
 * Same two restrictions as everywhere: the company filter comes from the scoped
 * client, and WHOSE requests is the data scope — the whole company for HR,
 * direct reports for a manager, their own for an employee.
 */

/** The data scope on leave requests — one definition for every module (platform/authz/scopeWhere). */
function scopeWhere(scope: ScopeContext): Prisma.LeaveRequestWhereInput {
  return ownedRowsInScope(scope)
}

const requestInclude = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      department: { select: { name: true } },
      reportingManagerId: true,
    },
  },
  leaveType: { select: { id: true, name: true, code: true, isPaid: true } },
} as const

export type LeaveRequestRow = Prisma.LeaveRequestGetPayload<{ include: typeof requestInclude }>

export interface LeaveFilters {
  status?: LeaveStatus | undefined
  employeeId?: string | undefined
  leaveYear?: number | undefined
  leaveTypeId?: string | undefined
}

export async function listRequests(
  db: ScopedDb,
  scope: ScopeContext,
  filters: LeaveFilters = {},
): Promise<LeaveRequestRow[]> {
  const where: Prisma.LeaveRequestWhereInput = {}
  if (filters.status) where.status = filters.status
  if (filters.employeeId) where.employeeId = filters.employeeId
  if (filters.leaveYear) where.leaveYear = filters.leaveYear
  if (filters.leaveTypeId) where.leaveTypeId = filters.leaveTypeId

  return db.leaveRequest.findMany({
    where: { AND: [scopeWhere(scope), where] },
    include: requestInclude,
    orderBy: [{ appliedAt: 'desc' }],
  }) as Promise<LeaveRequestRow[]>
}

export async function findRequest(
  db: ScopedDb,
  scope: ScopeContext,
  id: string,
): Promise<LeaveRequestRow | null> {
  // findFirst, not findUnique — a by-id read is scoped like every other.
  return db.leaveRequest.findFirst({
    where: { AND: [{ id }, scopeWhere(scope)] },
    include: requestInclude,
  }) as Promise<LeaveRequestRow | null>
}

/**
 * Days already committed but not yet decided.
 *
 * Counted against the balance when somebody applies, or they could apply for
 * their whole entitlement three times over and have all three approved by three
 * different people on the same afternoon.
 */
export async function pendingDays(
  db: TxDb,
  employeeId: string,
  leaveTypeId: string,
  leaveYear: number,
): Promise<number> {
  const result = await db.leaveRequest.aggregate({
    where: { employeeId, leaveTypeId, leaveYear, status: 'pending' },
    _sum: { days: true },
  })

  return result._sum.days ? Number(result._sum.days) : 0
}

/**
 * The balance, as the SUM of ledger entries.
 *
 * There is no stored number to disagree with this. A wrong balance is corrected
 * by adding an entry, never by editing one — so "why does she have 4.5 days?"
 * always has an answer that can be read off the rows.
 */
export async function ledgerBalance(
  db: ScopedDb,
  employeeId: string,
  leaveTypeId: string,
  leaveYear: number,
): Promise<number> {
  const result = await db.leaveLedgerEntry.aggregate({
    where: { employeeId, leaveTypeId, leaveYear },
    _sum: { days: true },
  })

  return result._sum.days ? Number(result._sum.days) : 0
}

export interface BalanceRow {
  leaveTypeId: string
  code: string
  name: string
  annualQuota: number
  balance: number
  pending: number
  available: number
}

/** Every leave type with this employee's balance in it, for the Balance tab. */
export async function balancesFor(
  db: ScopedDb,
  employeeId: string,
  leaveYear: number,
): Promise<BalanceRow[]> {
  const [types, ledger, pending] = await Promise.all([
    db.leaveType.findMany({ where: { archivedAt: null }, orderBy: { code: 'asc' } }),
    db.leaveLedgerEntry.groupBy({
      by: ['leaveTypeId'],
      where: { employeeId, leaveYear },
      _sum: { days: true },
    }),
    db.leaveRequest.groupBy({
      by: ['leaveTypeId'],
      where: { employeeId, leaveYear, status: 'pending' },
      _sum: { days: true },
    }),
  ])

  const balanceBy = new Map(ledger.map((l) => [l.leaveTypeId, Number(l._sum.days ?? 0)]))
  const pendingBy = new Map(pending.map((p) => [p.leaveTypeId, Number(p._sum.days ?? 0)]))

  return types.map((type) => {
    const balance = balanceBy.get(type.id) ?? 0
    const held = pendingBy.get(type.id) ?? 0

    return {
      leaveTypeId: type.id,
      code: type.code,
      name: type.name,
      annualQuota: Number(type.annualQuota),
      balance,
      pending: held,
      // What they can actually apply for right now. Showing the raw balance
      // and letting somebody apply for days already spoken for is how two
      // approvals overdraw the same entitlement.
      available: Math.round((balance - held) * 2) / 2,
    }
  })
}

/** Requests that overlap a date range — an employee cannot be on leave twice. */
export async function overlapping(
  db: TxDb,
  employeeId: string,
  from: Date,
  to: Date,
  excludeRequestId?: string,
): Promise<LeaveRequestRow[]> {
  return db.leaveRequest.findMany({
    where: {
      employeeId,
      status: { in: ['pending', 'approved'] },
      // Two ranges overlap when each starts before the other ends.
      fromDate: { lte: to },
      toDate: { gte: from },
      ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
    },
    include: requestInclude,
  }) as Promise<LeaveRequestRow[]>
}

export async function createRequest(db: TxDb, data: Prisma.LeaveRequestUncheckedCreateInput) {
  return db.leaveRequest.create({ data })
}

/**
 * Moves a request from one status to another — only if it is still in the
 * first. Compared and changed in ONE statement, so of two decisions arriving
 * together exactly one finds it still `from`; the other is told so.
 *
 * Reading the status first and updating after, as this used to, let two
 * approvers — or one double click — both read `pending` and both take the days.
 */
export async function changeStatusIf(
  db: TxDb,
  id: string,
  from: LeaveStatus,
  change: { status: LeaveStatus; reviewedByUserId?: string; reviewedAt?: Date; reviewNote?: string | null },
): Promise<boolean> {
  const result = await db.leaveRequest.updateMany({ where: { id, status: from }, data: change })
  return result.count === 1
}

/** A movement on the balance. Days are negative when taken, positive when given. */
export async function addLedgerEntry(db: TxDb, data: Prisma.LeaveLedgerEntryUncheckedCreateInput) {
  return db.leaveLedgerEntry.create({ data })
}

/** What a notice about a request says: whose it is, what kind, which days. */
/** A person's name, to say who acted when it was not the person the leave is for. */
export async function employeeName(db: TxDb, employeeId: string | null): Promise<string | null> {
  if (!employeeId) return null
  return (await db.employee.findFirst({ where: { id: employeeId }, select: { fullName: true } }))?.fullName ?? null
}

export async function requestFacts(db: TxDb, id: string) {
  return db.leaveRequest.findFirst({
    where: { id },
    select: {
      id: true,
      employeeId: true,
      fromDate: true,
      toDate: true,
      days: true,
      employee: { select: { fullName: true } },
      leaveType: { select: { name: true } },
    },
  })
}

// ── Balances across people (Leave → Team Balances), and granting a year ──────

const peopleWhere = employeesInScope

/** Everybody on the payroll whom this person may see, by name. People who have left are archived and not here. */
export async function peopleInScope(db: ScopedDb | TxDb, scope: ScopeContext) {
  return db.employee.findMany({
    where: { AND: [peopleWhere(scope), { archivedAt: null }] },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      dateOfJoining: true,
      lastWorkingDate: true,
      status: true,
      department: { select: { name: true } },
    },
    orderBy: { fullName: 'asc' },
  })
}

export async function activeLeaveTypes(db: ScopedDb | TxDb) {
  return db.leaveType.findMany({
    where: { archivedAt: null },
    select: { id: true, code: true, name: true, annualQuota: true, carryForward: true, carryForwardCap: true },
    orderBy: { code: 'asc' },
  })
}

/** Each person's ledger total per type for one leave year. */
export async function ledgerTotals(db: ScopedDb | TxDb, employeeIds: string[], leaveYear: number) {
  if (employeeIds.length === 0) return []
  return db.leaveLedgerEntry.groupBy({
    by: ['employeeId', 'leaveTypeId'],
    where: { employeeId: { in: employeeIds }, leaveYear },
    _sum: { days: true },
  })
}

/** Each person's days applied for and not yet decided, per type. */
export async function pendingTotals(db: ScopedDb | TxDb, employeeIds: string[], leaveYear: number) {
  if (employeeIds.length === 0) return []
  return db.leaveRequest.groupBy({
    by: ['employeeId', 'leaveTypeId'],
    where: { employeeId: { in: employeeIds }, leaveYear, status: 'pending' },
    _sum: { days: true },
  })
}

/** This year's grants already made — what a new grant must not repeat. */
export async function grantsMade(db: ScopedDb | TxDb, leaveYear: number) {
  return db.leaveLedgerEntry.findMany({
    where: { leaveYear, reason: { in: ['opening_grant', 'carry_forward'] } },
    select: { employeeId: true, leaveTypeId: true, reason: true },
  })
}

export async function addLedgerEntries(db: TxDb, rows: Prisma.LeaveLedgerEntryCreateManyInput[]): Promise<number> {
  if (rows.length === 0) return 0
  return (await db.leaveLedgerEntry.createMany({ data: rows })).count
}

/** One person's ledger total for a type, read on the transaction that is about to add to it. */
export async function balanceOn(db: TxDb, employeeId: string, leaveTypeId: string, leaveYear: number): Promise<number> {
  const result = await db.leaveLedgerEntry.aggregate({ where: { employeeId, leaveTypeId, leaveYear }, _sum: { days: true } })
  return result._sum.days ? Number(result._sum.days) : 0
}

/** An employee still on the books, if the caller's leave scope reaches them. */
export async function activeEmployee(db: ScopedDb, scope: ScopeContext, id: string) {
  return db.employee.findFirst({ where: { AND: [employeesInScope(scope), { id, archivedAt: null }] }, select: { id: true, fullName: true } })
}

export async function activeLeaveType(db: ScopedDb, id: string) {
  return db.leaveType.findFirst({ where: { id, archivedAt: null }, select: { id: true, code: true, name: true } })
}
