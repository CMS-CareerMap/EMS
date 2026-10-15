import type { Prisma, AttendanceStatus, AttendanceSource } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import type { ScopeContext } from '../../platform/authz/scope'
import { employeesInScope, ownedRowsInScope } from '../../platform/authz/scopeWhere'
import { addCalendarDays, toDateColumn, type CalendarDate } from '../../domain/shared/dates'

/**
 * Reading attendance.
 *
 * Same two restrictions as everywhere: the company filter comes free from the
 * scoped client, and WHOSE rows is the data scope — ORGANIZATION for HR,
 * DIRECT_REPORTS for a manager, SELF for an employee. Every function takes the
 * scope as a required argument, so it cannot be forgotten.
 */

/** The data scope on attendance rows — one definition for every module (platform/authz/scopeWhere). */
function scopeWhere(scope: ScopeContext): Prisma.AttendanceWhereInput {
  return ownedRowsInScope(scope)
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
    // The same people the counts are about. Counting the whole company here
    // told a manager the company's headcount, and reported everybody outside
    // their team as "not marked".
    db.employee.count({ where: { AND: [employeeScopeWhere(scope), { archivedAt: null }] } }),
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
  /** Measured against the shift (client §34–35); null when there was nothing to measure. */
  lateMinutes?: number | null
  earlyLeavingMinutes?: number | null
  overtimeMinutes?: number | null
}

/** A shift's times and rules — what a day is measured against. */
export const SHIFT_RULES_SELECT = {
  startTime: true,
  endTime: true,
  breakMinutes: true,
  expectedHours: true,
  graceMinutes: true,
  lateThresholdMinutes: true,
  earlyLeavingMinutes: true,
  minFullDayHours: true,
  minHalfDayHours: true,
  overtimeAfterMinutes: true,
} as const

/** Whether this person's day is already recorded — marking it again is correcting it. */
export async function dayRecorded(db: TxDb, employeeId: string, date: CalendarDate): Promise<boolean> {
  return (await db.attendance.count({ where: { employeeId, date: toDateColumn(date) } })) > 0
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
    lateMinutes: input.lateMinutes ?? null,
    earlyLeavingMinutes: input.earlyLeavingMinutes ?? null,
    overtimeMinutes: input.overtimeMinutes ?? null,
    // Written by hand now: whatever an approved leave took over is no longer there to give back.
    statusBeforeLeave: null,
    sourceBeforeLeave: null,
    // …nor what the fingerprint machine made of the day as it was: the next file judges it again.
    machineFirstScan: null,
    machineLastScan: null,
    machineMatch: null,
    machineCheckedAt: null,
    statusBeforeMachine: null,
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

/** The same data scope as `scopeWhere`, expressed on employees. */
const employeeScopeWhere = employeesInScope

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
      // With the shift it was recorded on: whether an open day is still somebody's day depends on it.
      attendance: { where: { date }, take: 1, include: { shift: { select: SHIFT_RULES_SELECT } } },
    },
    orderBy: { fullName: 'asc' },
  })
}

export type RosterRow = Awaited<ReturnType<typeof dayRoster>>[number]

/** Which of these people have checked in on a day — a new day begun leaves an open one before it behind. */
export async function checkedInOn(db: ScopedDb, employeeIds: string[], day: CalendarDate): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set()
  const rows = await db.attendance.findMany({
    where: { employeeId: { in: employeeIds }, date: toDateColumn(day), checkIn: { not: null } },
    select: { employeeId: true },
  })
  return new Set(rows.map((r) => r.employeeId))
}

/** One person's row for one day, whatever wrote it. */
export async function findDay(db: TxDb, employeeId: string, date: Date) {
  return db.attendance.findFirst({ where: { employeeId, date } })
}

/** Approved leave on a day: all of it, half of it, or none. */
/** Approved leave on a day: the whole day, or half of it — and which half, when the request says. */
export type LeaveOnDay = { kind: 'full' } | { kind: 'half'; session: 'first_half' | 'second_half' | null } | null

/** Which half of a day a request takes, from its sessions; null when it does not say. */
export function sessionOf(sessions: unknown, date: CalendarDate): 'first_half' | 'second_half' | null {
  const value = sessions && typeof sessions === 'object' ? (sessions as Record<string, unknown>)[date] : null
  return value === 'first_half' || value === 'second_half' ? value : null
}

export async function approvedLeaveOn(db: TxDb, employeeId: string, date: CalendarDate): Promise<LeaveOnDay> {
  const leave = await db.leaveRequest.findMany({
    where: { employeeId, status: 'approved', fromDate: { lte: toDateColumn(date) }, toDate: { gte: toDateColumn(date) } },
    select: { halfDayDates: true, halfDaySessions: true },
  })
  if (leave.length === 0) return null
  // Two halves on one day are the whole day.
  if (leave.length > 1 || !leave[0]!.halfDayDates.includes(date)) return { kind: 'full' }
  return { kind: 'half', session: sessionOf(leave[0]!.halfDaySessions, date) }
}

/** Approved leave touching two days, for some people. */
export async function approvedLeaveDays(db: ScopedDb | TxDb, employeeIds: string[], from: CalendarDate, to: CalendarDate) {
  const leave = await db.leaveRequest.findMany({
    where: { employeeId: { in: employeeIds }, status: 'approved', fromDate: { lte: toDateColumn(to) }, toDate: { gte: toDateColumn(from) } },
    select: { employeeId: true, fromDate: true, toDate: true, halfDayDates: true, halfDaySessions: true },
  })
  return leave
}

export async function createDay(db: TxDb, data: Prisma.AttendanceUncheckedCreateInput) {
  return db.attendance.create({ data })
}

/**
 * The days approved leave wrote between two dates, given back when the leave
 * is: a day it created is removed (never a punch); an absent day it took over
 * (client, 10 Oct 2026) is put back as it was.
 */
export async function releaseLeaveDays(db: TxDb, employeeId: string, from: Date, to: Date) {
  const where = { employeeId, source: 'leave' as const, date: { gte: from, lte: to } }
  await db.attendance.deleteMany({ where: { ...where, statusBeforeLeave: null } })
  const takenOver = await db.attendance.findMany({ where: { ...where, statusBeforeLeave: { not: null } }, select: { id: true, statusBeforeLeave: true, sourceBeforeLeave: true } })
  for (const day of takenOver) {
    await db.attendance.update({
      where: { id: day.id },
      data: { status: day.statusBeforeLeave!, source: day.sourceBeforeLeave ?? 'manual', statusBeforeLeave: null, sourceBeforeLeave: null },
    })
  }
}

/**
 * An absent day with no punch, taken over by approved leave (client, 10 Oct
 * 2026): it now says leave — what it was is kept, for a reversal to put back.
 */
export async function takeOverAbsentDay(db: TxDb, day: { id: string; status: AttendanceStatus; source: AttendanceSource }, markedByUserId: string) {
  return db.attendance.update({
    where: { id: day.id },
    data: { status: 'on_leave', source: 'leave', statusBeforeLeave: day.status, sourceBeforeLeave: day.source, markedByUserId },
  })
}

/** The values of one day's row, apart from whose and which day it is. */
export type DayValues = Omit<Prisma.AttendanceUncheckedCreateInput, 'organizationId' | 'employeeId' | 'date'>

export async function updateDay(db: TxDb, id: string, data: Prisma.AttendanceUncheckedUpdateInput) {
  return db.attendance.update({ where: { id }, data })
}

/** One app punch's evidence, accepted or refused (client, 11 Oct 2026). */
export async function recordPunch(db: ScopedDb | TxDb, data: Prisma.PunchEvidenceUncheckedCreateInput) {
  return db.punchEvidence.create({ data, select: { id: true } })
}

/**
 * Punches with something to look at, between two days, of the people the
 * caller's attendance reach covers (client, 11 Oct 2026): refused, or with a
 * flag. Newest first, the most recent 500.
 */
export async function questionablePunches(db: ScopedDb, scope: ScopeContext, from: CalendarDate, to: CalendarDate, notOwn: string | null) {
  return db.punchEvidence.findMany({
    where: {
      employee: employeesInScope(scope),
      ...(notOwn ? { employeeId: { not: notOwn } } : {}),
      date: { gte: toDateColumn(from), lte: toDateColumn(to) },
      OR: [{ refusedFor: { not: null } }, { flags: { isEmpty: false } }],
    },
    select: {
      id: true, employeeId: true, date: true, action: true, at: true, refusedFor: true, flags: true,
      latitude: true, longitude: true, distanceMeters: true, accuracyMeters: true, fenceApplied: true, readings: true, ip: true, userAgent: true, workMode: true,
      employee: { select: { fullName: true, employeeCode: true } },
    },
    orderBy: { at: 'desc' },
    take: 500,
  })
}

/** App days the fingerprint machine did not bear out, between two days, of the people in reach: not on it, or at other times. */
export async function machineQuestionedDays(db: ScopedDb, scope: ScopeContext, from: CalendarDate, to: CalendarDate, notOwn: string | null) {
  return db.attendance.findMany({
    where: {
      employee: employeesInScope(scope),
      ...(notOwn ? { employeeId: { not: notOwn } } : {}),
      date: { gte: toDateColumn(from), lte: toDateColumn(to) },
      machineMatch: { in: ['not_on_machine', 'time_differs'] },
    },
    select: {
      employeeId: true, date: true, status: true, checkIn: true, checkOut: true, machineMatch: true, machineFirstScan: true, machineLastScan: true,
      employee: { select: { fullName: true, employeeCode: true } },
    },
    orderBy: { date: 'desc' },
    take: 500,
  })
}

// ── Phones (client, 11 Oct 2026: one phone per employee) ─────────────────

/** One person's phones, as HR left them. */
export async function devicesOf(db: ScopedDb | TxDb, employeeId: string) {
  return db.punchDevice.findMany({ where: { employeeId }, orderBy: { firstSeenAt: 'asc' } })
}

export async function createDevice(tx: TxDb, data: Prisma.PunchDeviceUncheckedCreateInput) {
  return tx.punchDevice.create({ data })
}

export async function updateDevice(tx: TxDb, id: string, data: Prisma.PunchDeviceUncheckedUpdateInput) {
  return tx.punchDevice.update({ where: { id }, data })
}

/** One phone approved: the person's others taken off. How many were. */
export async function retireOtherDevices(tx: TxDb, employeeId: string, keepId: string, decidedByUserId: string, at: Date): Promise<number> {
  const result = await tx.punchDevice.updateMany({
    where: { employeeId, id: { not: keepId }, status: { not: 'retired' } },
    data: { status: 'retired', decidedByUserId, decidedAt: at },
  })
  return result.count
}

/**
 * Phones of the people in reach, but for `notOwn`'s — the most recently used
 * first — for whoever may replace them; only one person's when `employeeId`.
 */
export async function devicesInScope(db: ScopedDb, scope: ScopeContext, status: 'waiting' | 'all', notOwn: string | null, employeeId?: string) {
  const person = [...(notOwn ? [{ employeeId: { not: notOwn } }] : []), ...(employeeId ? [{ employeeId }] : [])]
  return db.punchDevice.findMany({
    where: {
      employee: employeesInScope(scope),
      ...(person.length ? { AND: person } : {}),
      ...(status === 'waiting' ? { status: 'waiting' as const } : {}),
    },
    include: { employee: { select: { fullName: true, employeeCode: true } } },
    orderBy: { lastSeenAt: 'desc' },
    take: 500,
  })
}

/** One phone, if its person is in the caller's reach. */
export async function deviceInScope(db: ScopedDb, scope: ScopeContext, id: string) {
  return db.punchDevice.findFirst({ where: { id, employee: employeesInScope(scope) }, include: { employee: { select: { fullName: true } } } })
}

/** One phone, as it stands — read again under its person's lock. */
export async function deviceById(tx: TxDb, id: string) {
  return tx.punchDevice.findUnique({ where: { id } })
}

/** The phones somebody punched from on other days, the last two months — what "another phone" is told by. */
export async function earlierDeviceHashes(db: ScopedDb | TxDb, employeeId: string, date: CalendarDate): Promise<Set<string>> {
  const rows = await db.punchEvidence.findMany({
    where: { employeeId, date: { gte: toDateColumn(addCalendarDays(date, -60)), lt: toDateColumn(date) }, deviceKeyHash: { not: null } },
    select: { deviceKeyHash: true },
    distinct: ['deviceKeyHash'],
  })
  return new Set(rows.flatMap((r) => (r.deviceKeyHash ? [r.deviceKeyHash] : [])))
}

/** A day's punches of somebody in reach — every one, accepted or refused — for the roster's "Evidence". */
export async function punchesOfDay(db: ScopedDb, scope: ScopeContext, employeeId: string, date: CalendarDate) {
  return db.punchEvidence.findMany({
    where: { employeeId, date: toDateColumn(date), employee: employeesInScope(scope) },
    orderBy: { at: 'asc' },
  })
}

/** A punch's selfie, if its person is in reach — not `notOwn` — and it is still kept. */
export async function punchPhoto(db: ScopedDb, scope: ScopeContext, id: string, notOwn: string | null) {
  return db.punchEvidence.findFirst({
    where: { id, employee: employeesInScope(scope), ...(notOwn ? { employeeId: { not: notOwn } } : {}), photoKey: { not: null } },
    select: { photoKey: true, photoSha: true },
  })
}

/** Selfies taken before a moment, still stored — the nightly job's to delete. */
export async function photosBefore(db: ScopedDb, before: Date) {
  return db.punchEvidence.findMany({ where: { photoKey: { not: null }, at: { lt: before } }, select: { id: true, photoKey: true }, take: 5_000 })
}

export async function forgetPhoto(db: ScopedDb | TxDb, id: string) {
  await db.punchEvidence.update({ where: { id }, data: { photoKey: null, photoSha: null, photoBytes: null } })
}

/** How many of somebody's refused punches that day kept a photo — so a refusal cannot be repeated to fill the storage. */
export async function refusedPhotosOn(db: ScopedDb, employeeId: string, date: CalendarDate): Promise<number> {
  return db.punchEvidence.count({ where: { employeeId, date: toDateColumn(date), refusedFor: { not: null }, photoKey: { not: null } } })
}

/** Whether this very photo, to the byte, came with an earlier accepted punch of theirs — a live camera never gives the same file twice. */
export async function photoSeenBefore(db: ScopedDb | TxDb, employeeId: string, sha256: string): Promise<boolean> {
  return (await db.punchEvidence.count({ where: { employeeId, photoSha: sha256, refusedFor: null } })) > 0
}

/** Writes a check-in on a day that has a row with none yet — null when a check-in landed a moment ago (two taps at once). */
export async function checkInIf(db: TxDb, id: string, data: Prisma.AttendanceUncheckedUpdateManyInput) {
  const result = await db.attendance.updateMany({ where: { id, checkIn: null }, data })
  return result.count === 1 ? db.attendance.findUniqueOrThrow({ where: { id } }) : null
}

/** The points of somebody's punches on other days, the last two months — what "the very same point" is checked against. */
export async function earlierPunchPoints(db: ScopedDb | TxDb, employeeId: string, date: CalendarDate) {
  const rows = await db.punchEvidence.findMany({
    where: {
      employeeId,
      date: { gte: toDateColumn(addCalendarDays(date, -60)), lt: toDateColumn(date) },
      latitude: { not: null },
      longitude: { not: null },
    },
    select: { latitude: true, longitude: true },
    orderBy: { at: 'desc' },
    // Two months of punches, twice a day, and the refused ones.
    take: 250,
  })
  return rows.map((r) => ({ latitude: Number(r.latitude), longitude: Number(r.longitude) }))
}

/** Closes a day still open, in one statement — null when it was closed a moment ago (two taps at once). */
export async function closeDayIf(db: TxDb, id: string, data: Prisma.AttendanceUncheckedUpdateManyInput) {
  const result = await db.attendance.updateMany({ where: { id, checkOut: null }, data })
  return result.count === 1 ? db.attendance.findUniqueOrThrow({ where: { id } }) : null
}

/** Writes one person's day: the row there is, changed — or a new one. */
export async function replaceDay(db: TxDb, organizationId: string, employeeId: string, date: Date, data: DayValues) {
  const existing = await findDay(db, employeeId, date)
  // Replaced now: whatever an approved leave took over is no longer there to give back.
  return existing
    ? db.attendance.update({ where: { id: existing.id }, data: { ...data, statusBeforeLeave: null, sourceBeforeLeave: null } })
    : db.attendance.create({ data: { ...data, organizationId, employeeId, date } })
}

/** An active employee with the shift their day is measured against. */
/**
 * An employee still on the books, with their shift — if `scope` reaches them.
 * Marking somebody's day is limited to the people one's attendance scope
 * covers (Day 21): a role marking for its team marks its team's days only.
 */
export async function findEmployeeWithShift(db: TxDb, scope: ScopeContext, employeeId: string) {
  return db.employee.findFirst({
    where: { AND: [employeesInScope(scope), { id: employeeId, archivedAt: null }] },
    include: { shift: true },
  })
}

/**
 * One person whose attendance the caller sees (client, 15 Oct 2026), for the
 * month page HR or a manager opens for them — somebody who has left too, whose
 * days are still history. Null outside the caller's attendance reach.
 */
export async function personForMonth(db: ScopedDb, scope: ScopeContext, employeeId: string) {
  return db.employee.findFirst({
    where: { AND: [employeesInScope(scope), { id: employeeId }] },
    select: {
      id: true,
      fullName: true,
      employeeCode: true,
      dateOfJoining: true,
      lastWorkingDate: true,
      archivedAt: true,
      attendanceMode: true,
      // Where they sit — whether the caller's LEAVE reach takes them in too.
      reportingManagerId: true,
      departmentId: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
      shift: { select: { name: true, startTime: true, endTime: true, expectedHours: true } },
    },
  })
}

/** Today's row, with the shift that decides the break. */
export async function findDayWithShift(db: ScopedDb | TxDb, employeeId: string, date: Date) {
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
/** Everybody an import may write days for: on the books, and within the importer's attendance scope. */
export async function importableEmployees(db: ScopedDb, scope: ScopeContext) {
  return db.employee.findMany({
    where: { AND: [employeesInScope(scope), { archivedAt: null }] },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      dateOfJoining: true,
      lastWorkingDate: true,
      attendanceMode: true,
      workArrangement: true,
      // The number the fingerprint machine knows them by (client, 11 Oct 2026).
      machineId: true,
      shiftId: true,
      shift: { select: SHIFT_RULES_SELECT },
    },
  })
}

/** The days already recorded for some people between two dates, each with the shift it was recorded on. */
export async function recordedDays(db: ScopedDb, employeeIds: string[], from: CalendarDate, to: CalendarDate) {
  return db.attendance.findMany({
    where: { employeeId: { in: employeeIds }, date: { gte: toDateColumn(from), lte: toDateColumn(to) } },
    select: {
      id: true, employeeId: true, date: true, status: true, source: true, shiftId: true, expectedHours: true, shift: { select: SHIFT_RULES_SELECT },
      // An app punch is matched against the machine, not overwritten (client, 11 Oct 2026).
      checkIn: true, checkOut: true, workMode: true, machineMatch: true, machineFirstScan: true, machineLastScan: true, statusBeforeMachine: true,
      punchEvidence: { where: APP_CHECK_IN, select: { id: true }, take: 1 },
    },
  })
}

/** An accepted check-in on the app: what makes a day the app's, whoever touched it since. */
const APP_CHECK_IN = { action: 'in' as const, refusedFor: null }

/**
 * Whether a day is the app's — checked in on the app — even after HR recorded
 * its check-out or corrected it: the fingerprint machine is asked about it
 * all the same (client, 11 Oct 2026). A day from before the evidence was kept
 * is known by its source.
 */
export const isAppDay = (day: { source: AttendanceSource; checkIn: Date | null; punchEvidence: { id: string }[] }) =>
  day.checkIn !== null && (day.source === 'punch' || day.punchEvidence.length > 0)

/**
 * The app's office days of some people between two dates (client, 11 Oct
 * 2026): what the fingerprint machine's file is expected to have. A day worked
 * away — home, on duty, remote — is not, nor one on leave.
 */
export async function appOfficeDays(db: ScopedDb | TxDb, employeeIds: string[], from: CalendarDate, to: CalendarDate) {
  if (employeeIds.length === 0) return []
  return db.attendance.findMany({
    where: {
      employeeId: { in: employeeIds },
      date: { gte: toDateColumn(from), lte: toDateColumn(to) },
      checkIn: { not: null },
      status: { in: ['present', 'half_day', 'absent'] },
      AND: [
        { OR: [{ source: 'punch' }, { punchEvidence: { some: APP_CHECK_IN } }] },
        { OR: [{ workMode: 'office' }, { workMode: null }] },
      ],
    },
    select: { id: true, employeeId: true, date: true, status: true, checkOut: true, statusBeforeMachine: true },
  })
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
    select: { date: true, status: true, checkIn: true, checkOut: true, hoursWorked: true, lateMinutes: true },
  })
}
