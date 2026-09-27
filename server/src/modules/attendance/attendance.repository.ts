import type { Prisma, AttendanceStatus, AttendanceSource } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import type { ScopeContext } from '../../platform/authz/scope'
import { toDateColumn, type CalendarDate } from '../../domain/shared/dates'

/**
 * Reading attendance.
 *
 * Same two restrictions as everywhere: the company filter comes free from the
 * scoped client, and WHOSE rows is the data scope — ORGANIZATION for HR,
 * DIRECT_REPORTS for a manager, SELF for an employee. Every function takes the
 * scope as a required argument, so it cannot be forgotten.
 */

function scopeWhere(scope: ScopeContext): Prisma.AttendanceWhereInput {
  switch (scope.scope) {
    case 'ORGANIZATION':
      return {}

    case 'DIRECT_REPORTS':
      if (!scope.employeeId) return IMPOSSIBLE
      return {
        OR: [
          { employee: { reportingManagerId: scope.employeeId } },
          { employeeId: scope.employeeId },
        ],
      }

    case 'SELF':
      if (!scope.employeeId) return IMPOSSIBLE
      return { employeeId: scope.employeeId }

    case 'DEPARTMENT':
      // Unhandled rather than approximated. A scope that quietly falls through
      // to "no filter" would widen access without failing any test.
      throw new Error('DEPARTMENT scope is not implemented')
  }
}

const IMPOSSIBLE: Prisma.AttendanceWhereInput = {
  employeeId: { equals: '00000000-0000-0000-0000-000000000000' },
}

/**
 * The first day of a month, and the first day of the NEXT month.
 *
 * Half-open — `>= from` and `< until` — which is what makes this correct for
 * every month without knowing how long any of them is.
 *
 * The old client built the range end as `${year}-${month}-31`. For February,
 * April, June, September and November that string is not a date, so the query
 * returned nothing and the monthly view was BLANK FIVE MONTHS A YEAR. Nobody
 * reported it as a bug; they reported that attendance "sometimes does not
 * load", which is a much harder thing to find.
 */
export function monthRange(year: number, month: number): { from: Date; until: Date } {
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    until: new Date(Date.UTC(year, month, 1)),
  }
}

export interface AttendanceFilters {
  date?: CalendarDate | undefined
  year?: number | undefined
  month?: number | undefined
  employeeId?: string | undefined
  status?: AttendanceStatus | undefined
  departmentId?: string | undefined
}

function filterWhere(filters: AttendanceFilters): Prisma.AttendanceWhereInput {
  const where: Prisma.AttendanceWhereInput = {}

  if (filters.date) {
    where.date = toDateColumn(filters.date)
  } else if (filters.year && filters.month) {
    const { from, until } = monthRange(filters.year, filters.month)
    where.date = { gte: from, lt: until }
  }

  if (filters.employeeId) where.employeeId = filters.employeeId
  if (filters.status) where.status = filters.status
  if (filters.departmentId) where.employee = { departmentId: filters.departmentId }

  return where
}

const listInclude = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      attendanceMode: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
    },
  },
} as const

export type AttendanceRow = Prisma.AttendanceGetPayload<{ include: typeof listInclude }>

export async function list(
  db: ScopedDb,
  scope: ScopeContext,
  filters: AttendanceFilters,
): Promise<AttendanceRow[]> {
  return db.attendance.findMany({
    where: { AND: [scopeWhere(scope), filterWhere(filters)] },
    include: listInclude,
    orderBy: [{ date: 'desc' }, { employee: { fullName: 'asc' } }],
  }) as Promise<AttendanceRow[]>
}

export async function findById(
  db: TxDb,
  scope: ScopeContext,
  id: string,
): Promise<AttendanceRow | null> {
  // findFirst, not findUnique — a by-id read still has to be scoped, or an
  // employee edits somebody else's day by changing a uuid.
  return db.attendance.findFirst({
    where: { AND: [{ id }, scopeWhere(scope)] },
    include: listInclude,
  }) as Promise<AttendanceRow | null>
}

export interface MonthlyTotal {
  employeeId: string
  totalHours: number
  daysPresent: number
  daysHalf: number
  daysAbsent: number
  daysOnLeave: number
}

/**
 * Monthly hours per employee — the figure the client asked for by name.
 *
 * AGGREGATED IN POSTGRES, not summed in the browser. The difference matters
 * once a month has two hundred rows across fifty people: the browser version
 * has to fetch every row to add them up, which is slow, and it adds up only the
 * rows the page happened to load — so a paginated list silently reports a
 * smaller total than the real one.
 *
 * Counting statuses in the same pass rather than in a second query, because the
 * two must describe the same set of rows. Two queries can disagree if a row is
 * written between them.
 */
export async function monthlyTotals(
  db: ScopedDb,
  scope: ScopeContext,
  year: number,
  month: number,
  employeeId?: string,
): Promise<MonthlyTotal[]> {
  const { from, until } = monthRange(year, month)

  const where: Prisma.AttendanceWhereInput = {
    AND: [scopeWhere(scope), { date: { gte: from, lt: until } }],
    ...(employeeId ? { employeeId } : {}),
  }

  const [sums, statusCounts] = await Promise.all([
    db.attendance.groupBy({
      by: ['employeeId'],
      where,
      _sum: { hoursWorked: true },
    }),
    db.attendance.groupBy({
      by: ['employeeId', 'status'],
      where,
      _count: { _all: true },
    }),
  ])

  const byEmployee = new Map<string, MonthlyTotal>()

  for (const row of sums) {
    byEmployee.set(row.employeeId, {
      employeeId: row.employeeId,
      totalHours: row._sum.hoursWorked ? Number(row._sum.hoursWorked) : 0,
      daysPresent: 0,
      daysHalf: 0,
      daysAbsent: 0,
      daysOnLeave: 0,
    })
  }

  for (const row of statusCounts) {
    const entry = byEmployee.get(row.employeeId)
    if (!entry) continue

    const count = row._count._all
    if (row.status === 'present') entry.daysPresent = count
    else if (row.status === 'half_day') entry.daysHalf = count
    else if (row.status === 'absent') entry.daysAbsent = count
    else if (row.status === 'on_leave') entry.daysOnLeave = count
  }

  return [...byEmployee.values()]
}

/** The company-wide figures the dashboard shows for one day. */
export interface DaySummary {
  date: CalendarDate
  present: number
  absent: number
  halfDay: number
  onLeave: number
  notMarked: number
  totalEmployees: number
}

export async function daySummary(
  db: ScopedDb,
  scope: ScopeContext,
  date: CalendarDate,
): Promise<DaySummary> {
  const [counts, totalEmployees] = await Promise.all([
    db.attendance.groupBy({
      by: ['status'],
      where: { AND: [scopeWhere(scope), { date: toDateColumn(date) }] },
      _count: { _all: true },
    }),
    db.employee.count({ where: { archivedAt: null } }),
  ])

  const of = (status: AttendanceStatus) =>
    counts.find((c) => c.status === status)?._count._all ?? 0

  const marked = counts.reduce((sum, c) => sum + c._count._all, 0)

  return {
    date,
    present: of('present'),
    absent: of('absent'),
    halfDay: of('half_day'),
    onLeave: of('on_leave'),
    // "Nobody has recorded anything for these people yet" is a different fact
    // from "they were absent", and the dashboard must not conflate them — the
    // old one did, and reported the whole company absent every morning.
    notMarked: Math.max(0, totalEmployees - marked),
    totalEmployees,
  }
}

export interface UpsertInput {
  employeeId: string
  date: CalendarDate
  checkIn: Date | null
  checkOut: Date | null
  status: AttendanceStatus
  source: AttendanceSource
  hoursWorked: number | null
  expectedHours: number | null
  shiftId: string | null
  note: string | null
  markedByUserId: string
}

export async function upsertDay(
  db: TxDb,
  organizationId: string,
  input: UpsertInput,
): Promise<AttendanceRow> {
  const existing = await db.attendance.findFirst({
    where: { employeeId: input.employeeId, date: toDateColumn(input.date) },
  })

  const data = {
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    status: input.status,
    source: input.source,
    hoursWorked: input.hoursWorked,
    expectedHours: input.expectedHours,
    shiftId: input.shiftId,
    note: input.note,
    markedByUserId: input.markedByUserId,
  }

  const row = existing
    ? await db.attendance.update({ where: { id: existing.id }, data })
    : await db.attendance.create({
        data: {
          organizationId,
          employeeId: input.employeeId,
          date: toDateColumn(input.date),
          ...data,
        },
      })

  return findById(db, { scope: 'ORGANIZATION', employeeId: null }, row.id) as Promise<AttendanceRow>
}

/** Matches no employee. A uuid column can never hold this. */
const NOBODY: Prisma.EmployeeWhereInput = { id: { equals: '00000000-0000-0000-0000-000000000000' } }

/** The same data scope as `scopeWhere`, expressed on employees. */
function employeeScopeWhere(scope: ScopeContext): Prisma.EmployeeWhereInput {
  switch (scope.scope) {
    case 'ORGANIZATION':
      return {}

    case 'DIRECT_REPORTS':
      if (!scope.employeeId) return NOBODY
      return { OR: [{ reportingManagerId: scope.employeeId }, { id: scope.employeeId }] }

    case 'SELF':
      if (!scope.employeeId) return NOBODY
      return { id: scope.employeeId }

    case 'DEPARTMENT':
      throw new Error('DEPARTMENT scope is not implemented')
  }
}

/**
 * Everybody the caller may see who was employed on `day`, each with that
 * day's row if there is one.
 *
 * The attendance page is a ROSTER, not a list of rows: the person nobody has
 * marked yet is the one HR most needs to see. The old page built that roster in
 * the browser from a second, unrelated employee list and matched the two on an
 * id — which, once the employees came from one system and the attendance from
 * another, matched nothing, and showed people who had punched in as unmarked.
 *
 * Built here instead, under ONE scope, so a manager's roster is their team and
 * nobody else's, and a person who joined next week or left last month is not on
 * it at all.
 */
export async function dayRoster(db: ScopedDb, scope: ScopeContext, day: CalendarDate) {
  const date = toDateColumn(day)

  return db.employee.findMany({
    where: {
      AND: [
        employeeScopeWhere(scope),
        { archivedAt: null },
        { OR: [{ dateOfJoining: null }, { dateOfJoining: { lte: date } }] },
        { OR: [{ lastWorkingDate: null }, { lastWorkingDate: { gte: date } }] },
      ],
    },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      attendanceMode: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
      attendance: { where: { date }, take: 1 },
    },
    orderBy: { fullName: 'asc' },
  })
}

export type RosterRow = Awaited<ReturnType<typeof dayRoster>>[number]

/** One person's row for one day, whatever wrote it. */
export async function findDay(db: TxDb, employeeId: string, date: Date) {
  return db.attendance.findFirst({ where: { employeeId, date } })
}

export async function createDay(db: TxDb, data: Prisma.AttendanceUncheckedCreateInput) {
  return db.attendance.create({ data })
}

/** The rows approved leave wrote between two dates — never a punch. */
export async function deleteLeaveDays(db: TxDb, employeeId: string, from: Date, to: Date) {
  return db.attendance.deleteMany({ where: { employeeId, source: 'leave', date: { gte: from, lte: to } } })
}

/** The values of one day's row, apart from whose and which day it is. */
export type DayValues = Omit<Prisma.AttendanceUncheckedCreateInput, 'organizationId' | 'employeeId' | 'date'>

export async function updateDay(db: TxDb, id: string, data: Prisma.AttendanceUncheckedUpdateInput) {
  return db.attendance.update({ where: { id }, data })
}

/** Writes one person's day: the row there is, changed — or a new one. */
export async function replaceDay(db: TxDb, organizationId: string, employeeId: string, date: Date, data: DayValues) {
  const existing = await findDay(db, employeeId, date)
  return existing
    ? db.attendance.update({ where: { id: existing.id }, data })
    : db.attendance.create({ data: { ...data, organizationId, employeeId, date } })
}

/** An active employee with the shift their day is measured against. */
export async function findEmployeeWithShift(db: ScopedDb, employeeId: string) {
  return db.employee.findFirst({ where: { id: employeeId, archivedAt: null }, include: { shift: true } })
}

/** Today's row, with the shift that decides the break. */
export async function findDayWithShift(db: ScopedDb, employeeId: string, date: Date) {
  return db.attendance.findFirst({ where: { employeeId, date }, include: { shift: true } })
}

/** Names for the ids a monthly aggregate returned — the aggregate cannot carry them. */
export async function namesForTotals(db: ScopedDb, employeeIds: string[]) {
  return db.employee.findMany({
    where: { id: { in: employeeIds } },
    select: { id: true, employeeCode: true, fullName: true, shift: { select: { expectedHours: true } } },
  })
}

/** Everybody an import can match a code to, with the shift that measures their day. */
export async function importableEmployees(db: ScopedDb) {
  return db.employee.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      employeeCode: true,
      attendanceMode: true,
      shiftId: true,
      shift: { select: { breakMinutes: true, expectedHours: true } },
    },
  })
}

/** How many of these person-days already have a row — what an import would replace. */
export async function countExistingDays(db: ScopedDb, days: { employeeId: string; date: Date }[]) {
  if (days.length === 0) return 0
  return db.attendance.count({ where: { OR: days } })
}

/**
 * Everybody active whose attendance the caller may see: the whole company for
 * HR, a manager's team and the manager, or only oneself.
 */
export async function peopleInScope(db: ScopedDb, scope: ScopeContext) {
  return db.employee.findMany({
    where: { AND: [employeeScopeWhere(scope), { archivedAt: null }] },
    select: {
      id: true,
      fullName: true,
      employeeCode: true,
      dateOfJoining: true,
      department: { select: { name: true } },
    },
    orderBy: { dateOfJoining: 'desc' },
  })
}

/** Who had which status on each day between two dates, for the rows the caller may see. */
export async function statusesBetween(db: ScopedDb, scope: ScopeContext, from: Date, to: Date) {
  return db.attendance.findMany({
    where: { AND: [scopeWhere(scope), { date: { gte: from, lte: to } }] },
    select: { employeeId: true, date: true, status: true },
  })
}

/** One person's rows between two dates — their own month. */
export async function daysFor(db: ScopedDb, employeeId: string, from: Date, to: Date) {
  return db.attendance.findMany({
    where: { employeeId, date: { gte: from, lte: to } },
    select: { date: true, status: true, checkIn: true, checkOut: true, hoursWorked: true },
  })
}
