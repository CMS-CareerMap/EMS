import type { Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'

/**
 * The reports' reads. Counting and summing happen in Postgres (groupBy), so a
 * figure describes every row in the month — not whatever rows a page loaded,
 * which is how the old reports got their numbers.
 */

export interface ReportFilters {
  departmentId?: string | undefined
  employeeId?: string | undefined
  /** Whom the caller may report on — their data scope for the report's kind (client §46). */
  people?: Prisma.EmployeeWhereInput | undefined
}

/** One AND, so it can sit beside another condition without either replacing the other. */
function employeeFilter(f: ReportFilters): Prisma.EmployeeWhereInput {
  return {
    AND: [
      f.departmentId ? { departmentId: f.departmentId } : {},
      f.employeeId ? { id: f.employeeId } : {},
      f.people ?? {},
    ],
  }
}

/** A day either side, so a moment near midnight is not lost to the time zone; the exact day is the service's to decide. */
const dayBefore = (d: Date) => new Date(d.getTime() - 86400000)
const dayAfter = (d: Date) => new Date(d.getTime() + 86400000)

/**
 * Everybody who may have been employed at some point in the window —
 * ARCHIVED PEOPLE INCLUDED. Letting somebody go archives them, and a report on
 * a month they worked must still count them. Their last day is the last
 * working day recorded, or, when none was, the day they were archived; the
 * service settles which, in the company's time zone.
 */
export async function employeesIn(db: ScopedDb, from: Date, to: Date, f: ReportFilters) {
  return db.employee.findMany({
    where: {
      AND: [
        employeeFilter(f),
        { OR: [{ dateOfJoining: null }, { dateOfJoining: { lte: to } }] },
        {
          OR: [
            { lastWorkingDate: { gte: from } },
            { lastWorkingDate: null, archivedAt: null },
            { lastWorkingDate: null, archivedAt: { gte: dayBefore(from) } },
          ],
        },
      ],
    },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      status: true,
      employmentType: true,
      dateOfJoining: true,
      lastWorkingDate: true,
      archivedAt: true,
      department: { select: { id: true, name: true } },
      designation: { select: { name: true } },
    },
    orderBy: { fullName: 'asc' },
  })
}

export type ReportEmployee = Awaited<ReturnType<typeof employeesIn>>[number]

/** Attendance rows by person and status, counted, with hours summed. */
export async function attendanceCounts(db: ScopedDb, employeeIds: string[], from: Date, to: Date) {
  if (employeeIds.length === 0) return { counts: [], hours: [] }
  const where: Prisma.AttendanceWhereInput = { employeeId: { in: employeeIds }, date: { gte: from, lte: to } }
  const [counts, hours] = await Promise.all([
    db.attendance.groupBy({ by: ['employeeId', 'status'], where, _count: { _all: true } }),
    db.attendance.groupBy({ by: ['employeeId'], where, _sum: { hoursWorked: true } }),
  ])
  return { counts, hours }
}

/** Which days each person has anything recorded — to count the days nobody marked. */
export async function markedDays(db: ScopedDb, employeeIds: string[], from: Date, to: Date) {
  if (employeeIds.length === 0) return []
  return db.attendance.findMany({
    where: { employeeId: { in: employeeIds }, date: { gte: from, lte: to } },
    select: { employeeId: true, date: true },
  })
}

export async function daysOff(db: ScopedDb, from: Date, to: Date) {
  return db.holiday.findMany({
    where: { date: { gte: from, lte: to }, type: { in: ['public', 'weekly_off'] } },
    select: { date: true },
  })
}

/**
 * The weekly offs of the policy in force on a day — policies are dated, and a
 * past month is counted by the rules it had (as payroll does), not today's.
 * Before the first policy, the earliest one; with none at all, null.
 */
export async function weeklyOffDays(db: ScopedDb, on: Date): Promise<number[] | null> {
  const inForce = await db.organizationPolicy.findFirst({
    where: { effectiveFrom: { lte: on }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }] },
    orderBy: { effectiveFrom: 'desc' },
    select: { weeklyOffDays: true },
  })
  if (inForce) return inForce.weeklyOffDays
  const earliest = await db.organizationPolicy.findFirst({ orderBy: { effectiveFrom: 'asc' }, select: { weeklyOffDays: true } })
  return earliest?.weeklyOffDays ?? null
}

export async function leaveYearStartMonth(db: ScopedDb): Promise<number> {
  const policy = await db.organizationPolicy.findFirst({ where: { effectiveTo: null }, select: { leaveYearStartMonth: true } })
  return policy?.leaveYearStartMonth ?? 4
}

/** Every leave type, archived ones too: leave taken under a type since archived was still taken. */
export async function leaveTypes(db: ScopedDb) {
  return db.leaveType.findMany({
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, isPaid: true, archivedAt: true },
  })
}

/** Approved leave that touches the window, day ranges and half days included. */
export async function approvedLeave(db: ScopedDb, employeeIds: string[], from: Date, to: Date) {
  if (employeeIds.length === 0) return []
  return db.leaveRequest.findMany({
    where: { employeeId: { in: employeeIds }, status: 'approved', fromDate: { lte: to }, toDate: { gte: from } },
    select: { employeeId: true, leaveTypeId: true, fromDate: true, toDate: true, halfDayDates: true },
  })
}

/** Ledger balances for a leave year, summed in Postgres, and what is held by pending requests. */
export async function leaveBalances(db: ScopedDb, employeeIds: string[], leaveYear: number) {
  if (employeeIds.length === 0) return { ledger: [], pending: [] }
  const [ledger, pending] = await Promise.all([
    db.leaveLedgerEntry.groupBy({
      by: ['employeeId', 'leaveTypeId'],
      where: { employeeId: { in: employeeIds }, leaveYear },
      _sum: { days: true },
    }),
    db.leaveRequest.groupBy({
      by: ['employeeId'],
      where: { employeeId: { in: employeeIds }, leaveYear, status: 'pending' },
      _sum: { days: true },
    }),
  ])
  return { ledger, pending }
}

export async function runForMonth(db: ScopedDb, year: number, month: number) {
  return db.payrollRun.findFirst({ where: { year, month }, select: { id: true, status: true, paidOn: true } })
}

/** The runs of some months — for the trend. */
export async function runsFor(db: ScopedDb, keys: { year: number; month: number }[]) {
  if (keys.length === 0) return []
  return db.payrollRun.findMany({
    where: { OR: keys.map((k) => ({ year: k.year, month: k.month })) },
    select: { id: true, year: true, month: true, status: true, netPayable: true },
  })
}

/** A department's name, for filtering payslips by the name copied onto them. */
export async function departmentName(db: ScopedDb, id: string): Promise<string | null> {
  return (await db.department.findFirst({ where: { id }, select: { name: true } }))?.name ?? null
}

/**
 * Payslips are filtered by what was copied onto them — the department the
 * person was in THAT month, which is also what the report's column shows. The
 * employee's current department would move a transferred person's old
 * payslips into their new department's totals.
 */
function payslipFilter(f: ReportFilters & { departmentName?: string | null }): Prisma.PayslipWhereInput {
  return {
    ...(f.employeeId ? { employeeId: f.employeeId } : {}),
    ...(f.people ? { employee: f.people } : {}),
    // A department that does not exist matches nothing, rather than everything.
    ...(f.departmentId ? (f.departmentName ? { department: f.departmentName } : { id: { in: [] } }) : {}),
  }
}

/** Net pay per run, summed in Postgres over the same payslips the table shows. */
export async function netByRun(db: ScopedDb, runIds: string[], f: ReportFilters & { departmentName?: string | null }) {
  if (runIds.length === 0) return []
  return db.payslip.groupBy({
    by: ['payrollRunId'],
    where: { payrollRunId: { in: runIds }, ...payslipFilter(f) },
    _sum: { netPayable: true },
  })
}

export async function payslipsOfRun(db: ScopedDb, runId: string, f: ReportFilters & { departmentName?: string | null }) {
  return db.payslip.findMany({
    where: {
      payrollRunId: runId,
      ...payslipFilter(f),
    },
    orderBy: { employeeName: 'asc' },
    select: {
      employeeId: true,
      employeeCode: true,
      employeeName: true,
      department: true,
      uan: true,
      paidDays: true,
      lopDays: true,
      grossEarnings: true,
      pfWages: true,
      employeePf: true,
      employeeEsi: true,
      professionalTax: true,
      tds: true,
      otherDeductions: true,
      totalDeductions: true,
      netPayable: true,
      employerEps: true,
      employerEpf: true,
      employerEsi: true,
    },
  })
}

/**
 * Who joined in the window, and who left — archived people included, since
 * leaving is what archives them. Somebody archived with no last working day
 * recorded is a candidate by the day they were archived; the service keeps
 * them only if that day, in the company's zone, falls in the window.
 */
export async function movements(db: ScopedDb, from: Date, to: Date, f: ReportFilters) {
  const select = {
    id: true,
    employeeCode: true,
    fullName: true,
    dateOfJoining: true,
    lastWorkingDate: true,
    archivedAt: true,
    department: { select: { name: true } },
    designation: { select: { name: true } },
  } as const
  const [joined, left] = await Promise.all([
    db.employee.findMany({ where: { ...employeeFilter(f), dateOfJoining: { gte: from, lte: to } }, select, orderBy: { dateOfJoining: 'asc' } }),
    db.employee.findMany({
      where: {
        ...employeeFilter(f),
        OR: [
          { lastWorkingDate: { gte: from, lte: to } },
          { lastWorkingDate: null, archivedAt: { gte: dayBefore(from), lte: dayAfter(to) } },
        ],
      },
      select,
      orderBy: { fullName: 'asc' },
    }),
  ])
  return { joined, left }
}

/** Each day's marks against the shift (client §34–35): late, early, overtime worked. */
export async function shiftMarks(db: ScopedDb, employeeIds: string[], from: Date, to: Date) {
  if (employeeIds.length === 0) return []
  return db.attendance.findMany({
    where: { employeeId: { in: employeeIds }, date: { gte: from, lte: to } },
    select: { employeeId: true, lateMinutes: true, earlyLeavingMinutes: true, overtimeMinutes: true },
  })
}

/** Overtime claimed for days of the window, whatever became of it. */
export async function overtimeClaims(db: ScopedDb, employeeIds: string[], from: Date, to: Date) {
  if (employeeIds.length === 0) return []
  return db.employeeRequest.findMany({
    where: { employeeId: { in: employeeIds }, type: 'overtime', fromDate: { gte: from, lte: to } },
    select: { employeeId: true, status: true, details: true },
  })
}

/** Requests sent in the window (client §28–29), oldest first. */
export async function requestsSent(db: ScopedDb, from: Date, to: Date, f: ReportFilters, reach: Prisma.EmployeeRequestWhereInput[]) {
  return db.employeeRequest.findMany({
    where: { createdAt: { gte: dayBefore(from), lt: dayAfter(dayAfter(to)) }, employee: employeeFilter(f), OR: reach },
    select: {
      number: true,
      type: true,
      status: true,
      fromDate: true,
      toDate: true,
      createdAt: true,
      decidedAt: true,
      decidedByUserId: true,
      employee: { select: { employeeCode: true, fullName: true, department: { select: { name: true } } } },
    },
    orderBy: { createdAt: 'asc' },
    take: 2000,
  })
}

/** The names of the people who decided — by their employee record, else their sign-in. */
export async function deciderNames(db: ScopedDb, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const rows = await db.membership.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, user: { select: { email: true } }, employee: { select: { fullName: true } } },
  })
  return new Map(rows.map((r) => [r.userId, r.employee?.fullName ?? r.user.email]))
}
