import type { Prisma, LeaveStatus } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import type { ScopeContext } from '../../platform/authz/scope'
import { employeesInScope, ownedRowsInScope } from '../../platform/authz/scopeWhere'
import { toDateColumn, type CalendarDate } from '../../domain/shared/dates'
import { applicationCount } from '../../domain/leave/applications'
import { isUnlimited } from '../../domain/leave/leaveDays'

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
 * A request anywhere in the company, whoever's it is — for deciding one
 * (Day 22). Who decides comes from the company tree, not from the caller's
 * leave scope: an Accounts head approves their accountant's leave with a leave
 * scope of their own rows only. leaveApprover.service decides whether the
 * caller may act on it before anything of it is shown.
 */
export async function findRequestInCompany(db: ScopedDb, id: string): Promise<LeaveRequestRow | null> {
  return db.leaveRequest.findFirst({ where: { id }, include: requestInclude }) as Promise<LeaveRequestRow | null>
}

/** The requests of these people, for the ones whose leave the caller decides. */
export async function requestsOf(
  db: ScopedDb,
  employeeIds: readonly string[],
  filters: Pick<LeaveFilters, 'status'> = {},
): Promise<LeaveRequestRow[]> {
  if (employeeIds.length === 0) return []
  return db.leaveRequest.findMany({
    where: { employeeId: { in: [...employeeIds] }, ...(filters.status ? { status: filters.status } : {}) },
    include: requestInclude,
    orderBy: [{ appliedAt: 'desc' }],
    take: 500,
  }) as Promise<LeaveRequestRow[]>
}

/**
 * How many of these people's applications are waiting — a count, not a capped
 * list. The parts of one application (the days a paid balance covers and the
 * rest unpaid) count once.
 */
export async function countPendingOf(db: ScopedDb, employeeIds: readonly string[]): Promise<number> {
  if (employeeIds.length === 0) return 0
  const rows = await db.leaveRequest.findMany({ where: { status: 'pending', employeeId: { in: [...employeeIds] } }, select: { id: true, groupId: true } })
  return applicationCount(rows)
}

/** Every part of one application, earliest first, whatever each now stands at. */
export async function groupParts(db: ScopedDb | TxDb, groupId: string): Promise<LeaveRequestRow[]> {
  return db.leaveRequest.findMany({ where: { groupId }, include: requestInclude, orderBy: [{ fromDate: 'asc' }] }) as Promise<LeaveRequestRow[]>
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
  /** This person's days a year: their own where they have them, else the type's. */
  annualQuota: number
  balance: number
  pending: number
  available: number
  isPaid: boolean
  /** Unpaid with no days a year: no balance to run out of — every day is loss of pay (client, 9 Oct 2026). */
  unlimited: boolean
  /** Days of it taken this leave year: approved, less any reversed. */
  taken: number
  /** Earned a twelfth a month (client §36), or all at once. */
  accrual: 'yearly' | 'monthly'
  /** What a joiner partway through the year is granted — and so, for a monthly type, earns from. */
  joinerGrant: 'months_left' | 'months_after_joining' | 'full_year'
  /** Of the balance, what a monthly type has not earned yet — not available until it is. */
  unearned: number
  /** Whether unused days may be asked to be turned into pay (client §36). */
  encashable: boolean
  /** Whether half days may be taken (client §37). */
  halfDayAllowed: boolean
}

/** Every leave type with this employee's balance in it, for the Balance tab. */
export async function balancesFor(
  db: ScopedDb,
  employeeId: string,
  leaveYear: number,
): Promise<BalanceRow[]> {
  const [types, ledger, pending, taken, own] = await Promise.all([
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
    db.leaveLedgerEntry.groupBy({
      by: ['leaveTypeId'],
      where: { employeeId, leaveYear, reason: { in: ['consumed', 'reversal'] } },
      _sum: { days: true },
    }),
    ownQuotasOf(db, [employeeId]),
  ])

  const balanceBy = new Map(ledger.map((l) => [l.leaveTypeId, Number(l._sum.days ?? 0)]))
  const pendingBy = new Map(pending.map((p) => [p.leaveTypeId, Number(p._sum.days ?? 0)]))
  const takenBy = new Map(taken.map((t) => [t.leaveTypeId, -Number(t._sum.days ?? 0)]))

  return types.map((type) => {
    const balance = balanceBy.get(type.id) ?? 0
    const held = pendingBy.get(type.id) ?? 0
    const quota = own.get(`${employeeId}|${type.id}`) ?? Number(type.annualQuota)

    return {
      leaveTypeId: type.id,
      code: type.code,
      name: type.name,
      annualQuota: quota,
      balance,
      pending: held,
      // What they can actually apply for right now. Showing the raw balance
      // and letting somebody apply for days already spoken for is how two
      // approvals overdraw the same entitlement.
      available: Math.round((balance - held) * 2) / 2,
      isPaid: type.isPaid,
      unlimited: isUnlimited(type.isPaid, quota),
      taken: Math.round((takenBy.get(type.id) ?? 0) * 2) / 2,
      accrual: type.accrual,
      joinerGrant: type.joinerGrant,
      unearned: 0,
      encashable: type.encashable,
      halfDayAllowed: type.halfDayAllowed,
    }
  })
}

// ── A person's own days a year (client, 9 Oct 2026) ────────────────────────

/** These people's own days a year, keyed `employeeId|leaveTypeId` — only where they have their own. */
export async function ownQuotasOf(db: ScopedDb | TxDb, employeeIds: readonly string[]): Promise<Map<string, number>> {
  if (employeeIds.length === 0) return new Map()
  const rows = await db.employeeLeaveEntitlement.findMany({
    where: { employeeId: { in: [...employeeIds] } },
    select: { employeeId: true, leaveTypeId: true, annualQuota: true },
  })
  return new Map(rows.map((r) => [`${r.employeeId}|${r.leaveTypeId}`, Number(r.annualQuota)]))
}

/** Everybody with their own days a year of one type. */
export async function ownQuotasOfType(db: TxDb, leaveTypeId: string): Promise<Set<string>> {
  const rows = await db.employeeLeaveEntitlement.findMany({ where: { leaveTypeId }, select: { employeeId: true } })
  return new Set(rows.map((r) => r.employeeId))
}

/** One person's own days a year of every type they have them for, with why and when. */
export async function entitlementsOf(db: ScopedDb | TxDb, employeeId: string) {
  return db.employeeLeaveEntitlement.findMany({
    where: { employeeId },
    select: { leaveTypeId: true, annualQuota: true, note: true, updatedAt: true },
  })
}

export async function saveEntitlement(
  db: TxDb,
  data: { organizationId: string; employeeId: string; leaveTypeId: string; annualQuota: number; note: string | null; updatedByUserId: string },
) {
  return db.employeeLeaveEntitlement.upsert({
    where: { organizationId_employeeId_leaveTypeId: { organizationId: data.organizationId, employeeId: data.employeeId, leaveTypeId: data.leaveTypeId } },
    create: data,
    update: { annualQuota: data.annualQuota, note: data.note, updatedByUserId: data.updatedByUserId },
  })
}

export async function removeEntitlement(db: TxDb, employeeId: string, leaveTypeId: string): Promise<boolean> {
  return (await db.employeeLeaveEntitlement.deleteMany({ where: { employeeId, leaveTypeId } })).count > 0
}

/**
 * One person's ledger of one type for a leave year, oldest first — every
 * movement in the balance, with the leave it came from where it came from one.
 */
export async function ledgerOf(db: ScopedDb, employeeId: string, leaveTypeId: string, leaveYear: number) {
  return db.leaveLedgerEntry.findMany({
    where: { employeeId, leaveTypeId, leaveYear },
    select: {
      id: true,
      days: true,
      reason: true,
      note: true,
      createdAt: true,
      leaveRequest: { select: { fromDate: true, toDate: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
}

/** A leave type, archived or not — a statement of an old year still names it. */
export async function leaveTypeById(db: ScopedDb, id: string) {
  return db.leaveType.findFirst({ where: { id }, select: { id: true, code: true, name: true, isPaid: true, annualQuota: true } })
}

/** How many days before the leave year ends people are told of days that will lapse (Settings → Leave Config). */
export async function reminderDaysOf(db: ScopedDb | TxDb, organizationId: string): Promise<number> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { leaveYearEndReminderDays: true } })
  return org?.leaveYearEndReminderDays ?? 30
}

export async function saveReminderDays(tx: TxDb, organizationId: string, days: number) {
  await tx.organization.update({ where: { id: organizationId }, data: { leaveYearEndReminderDays: days } })
}

/** Of these people, who has been told of this leave year's lapsing days already. */
export async function toldOfYearEnd(db: TxDb, employeeIds: readonly string[], leaveYear: number): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set()
  const rows = await db.leaveYearEndNotice.findMany({ where: { employeeId: { in: [...employeeIds] }, leaveYear }, select: { employeeId: true } })
  return new Set(rows.map((r) => r.employeeId))
}

export async function markToldOfYearEnd(tx: TxDb, row: { organizationId: string; employeeId: string; leaveYear: number; days: number }) {
  await tx.leaveYearEndNotice.create({ data: row })
}

/** Everybody still here who reports to one of these managers — their teams, by manager. */
export async function teamsOf(db: ScopedDb, managerIds: readonly string[]) {
  if (managerIds.length === 0) return []
  return db.employee.findMany({
    where: { reportingManagerId: { in: [...managerIds] }, archivedAt: null },
    select: { id: true, fullName: true, reportingManagerId: true },
  })
}

/**
 * These people's leave waiting or approved that touches from..to — with each
 * part's type, to say who is away — and every other part of an application
 * that does, so an application in parts reads whole.
 */
export async function leaveAround(db: ScopedDb, employeeIds: readonly string[], from: Date, to: Date) {
  if (employeeIds.length === 0) return []
  const select = { id: true, employeeId: true, groupId: true, status: true, fromDate: true, toDate: true, leaveType: { select: { name: true } } } as const
  const live = { employeeId: { in: [...employeeIds] }, status: { in: ['pending' as const, 'approved' as const] } }
  const touching = await db.leaveRequest.findMany({ where: { ...live, fromDate: { lte: to }, toDate: { gte: from } }, select, orderBy: [{ fromDate: 'asc' }] })
  const groups = [...new Set(touching.map((r) => r.groupId).filter((g): g is string => Boolean(g)))]
  if (groups.length === 0) return touching
  const seen = new Set(touching.map((r) => r.id))
  const rest = await db.leaveRequest.findMany({ where: { ...live, groupId: { in: groups } }, select })
  return [...touching, ...rest.filter((r) => !seen.has(r.id))]
}

/** Who of these people has anything at all in a year's ledger — any type, any reason. */
export async function peopleWithEntries(db: ScopedDb | TxDb, employeeIds: readonly string[], leaveYear: number): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set()
  const rows = await db.leaveLedgerEntry.groupBy({ by: ['employeeId'], where: { employeeId: { in: [...employeeIds] }, leaveYear } })
  return new Set(rows.map((r) => r.employeeId))
}

/** Who has been given a year at all: an opening grant of any type in it. */
export async function peopleGrantedIn(db: TxDb, leaveYear: number): Promise<Set<string>> {
  const rows = await db.leaveLedgerEntry.groupBy({ by: ['employeeId'], where: { leaveYear, reason: 'opening_grant' } })
  return new Set(rows.map((r) => r.employeeId))
}

/** Each person's grant of a year, per type, as granted — the opening grant and every change to it since. */
export async function grantTotals(db: TxDb, employeeIds: readonly string[], leaveYear: number, leaveTypeId?: string) {
  if (employeeIds.length === 0) return []
  return db.leaveLedgerEntry.groupBy({
    by: ['employeeId', 'leaveTypeId'],
    where: { employeeId: { in: [...employeeIds] }, leaveYear, reason: 'opening_grant', ...(leaveTypeId ? { leaveTypeId } : {}) },
    _sum: { days: true },
  })
}

/** Each person's days taken of a year, per type: approved, less any reversed — a positive number. */
export async function takenTotals(db: ScopedDb | TxDb, employeeIds: readonly string[], leaveYear: number) {
  if (employeeIds.length === 0) return []
  return db.leaveLedgerEntry.groupBy({
    by: ['employeeId', 'leaveTypeId'],
    where: { employeeId: { in: [...employeeIds] }, leaveYear, reason: { in: ['consumed', 'reversal'] } },
    _sum: { days: true },
  })
}

/** Waiting or approved leave that starts after a day — all of it, when there is no day (never joined). */
export async function requestsAfter(db: TxDb, employeeId: string, day: CalendarDate | null) {
  return db.leaveRequest.findMany({
    where: { employeeId, status: { in: ['pending', 'approved'] }, ...(day ? { fromDate: { gt: toDateColumn(day) } } : {}) },
    select: { id: true, status: true, leaveTypeId: true, leaveYear: true, days: true, fromDate: true, toDate: true, groupId: true },
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

/** This person's requests still waiting for a decision — the parts of one application with their group. */
export async function pendingIdsOf(db: TxDb, employeeId: string): Promise<{ id: string; groupId: string | null }[]> {
  return db.leaveRequest.findMany({ where: { employeeId, status: 'pending' }, select: { id: true, groupId: true }, orderBy: [{ fromDate: 'asc' }] })
}

const factsSelect = {
  id: true,
  employeeId: true,
  groupId: true,
  fromDate: true,
  toDate: true,
  days: true,
  employee: { select: { fullName: true } },
  leaveType: { select: { name: true } },
} as const

export async function requestFacts(db: TxDb, id: string) {
  return db.leaveRequest.findFirst({ where: { id }, select: factsSelect })
}

/** Every part of one application, earliest first — what a notice about the whole of it says. */
export async function groupFacts(db: TxDb, groupId: string) {
  return db.leaveRequest.findMany({ where: { groupId }, select: factsSelect, orderBy: [{ fromDate: 'asc' }] })
}

// ── Balances across people (Leave → Team Balances), and granting a year ──────

const peopleWhere = employeesInScope

/** Everybody on the payroll whom this person may see, by name. People who have left are archived and not here. */
/**
 * Everybody still here the scope reaches — and, when given, the people whose
 * leave the caller decides in the company tree (Day 22): a team lead on the
 * Employee role sees their team's balances though their leave scope is their own.
 */
export async function peopleInScope(db: ScopedDb | TxDb, scope: ScopeContext, alsoIds: readonly string[] = []) {
  const inScope = peopleWhere(scope)
  // A scope of `{}` is everybody already. Inside an OR Prisma drops an empty
  // condition, so `OR: [{}, ids]` would have meant ONLY those ids — an HR
  // head with a team of their own saw nobody's balance but the team's.
  const everybody = Object.keys(inScope).length === 0
  const reach = alsoIds.length && !everybody ? { OR: [inScope, { id: { in: [...alsoIds] } }] } : inScope
  return db.employee.findMany({
    where: { AND: [reach, { archivedAt: null }] },
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
    select: { id: true, code: true, name: true, annualQuota: true, isPaid: true, carryForward: true, carryForwardCap: true, joinerGrant: true },
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

/** The days somebody is employed: from joining to their last working day, either open — and who may take which types. */
export async function employmentWindow(db: ScopedDb | TxDb, id: string) {
  return db.employee.findFirst({ where: { id }, select: { dateOfJoining: true, lastWorkingDate: true, gender: true, confirmedOn: true } })
}

/** The year's grant of each type, as granted — what a monthly-accrual type earns a twelfth of a month. */
export async function openingGrants(db: ScopedDb | TxDb, employeeId: string, leaveYear: number): Promise<Map<string, number>> {
  const rows = await db.leaveLedgerEntry.groupBy({
    by: ['leaveTypeId'],
    where: { employeeId, leaveYear, reason: 'opening_grant' },
    _sum: { days: true },
  })
  return new Map(rows.map((r) => [r.leaveTypeId, Number(r._sum.days ?? 0)]))
}

/** Days of a type already turned into pay in a leave year (client §36), as a positive number. */
export async function encashedDays(db: ScopedDb | TxDb, employeeId: string, leaveTypeId: string, leaveYear: number): Promise<number> {
  const result = await db.leaveLedgerEntry.aggregate({ where: { employeeId, leaveTypeId, leaveYear, reason: 'encashed' }, _sum: { days: true } })
  return -Number(result._sum.days ?? 0)
}

export async function activeLeaveType(db: ScopedDb | TxDb, id: string) {
  return db.leaveType.findFirst({ where: { id, archivedAt: null }, select: { id: true, code: true, name: true, isPaid: true, annualQuota: true, joinerGrant: true } })
}

/** The company's unpaid types with no limit, in code order — what the rest of a short application can be taken as. */
export async function unlimitedUnpaidTypes(db: ScopedDb | TxDb) {
  return db.leaveType.findMany({ where: { archivedAt: null, isPaid: false, annualQuota: { lte: 0 } }, orderBy: { code: 'asc' } })
}

/** Everybody still here, for a grant nobody asked for: the company's, not a caller's scope. */
export async function everybodyHere(db: ScopedDb | TxDb, ids?: readonly string[]) {
  return db.employee.findMany({
    where: { archivedAt: null, ...(ids ? { id: { in: [...ids] } } : {}) },
    select: { id: true, employeeCode: true, fullName: true, dateOfJoining: true, lastWorkingDate: true, status: true },
    orderBy: { fullName: 'asc' },
  })
}
