import type { AppContext } from '../../platform/context'
import { Forbidden } from '../../platform/errors/AppError'
import { zonedToday, toDateColumn, fromDateColumn, isoInstant, addCalendarDays, mondayOf, type CalendarDate } from '../../domain/shared/dates'
import * as leaveRepo from '../leave/leave.repository'
import * as attendanceRepo from '../attendance/attendance.repository'
import * as employeeRepo from '../employee/employee.repository'
import { leaveYearOf } from '../leave/leave.service'
import { companyTimezone } from '../organization/organization.service'
import { getCurrentPolicy } from '../settings/settings.repository'
import { approvalWorld, deciderOf, peopleDecidedBy, rightsOn } from '../leave/leaveApprover.service'

/**
 * The first screen every role sees.
 *
 * It had no day at all in version 1 of the plan, and it is where the audit's
 * worst habit lived: a leave balance that fell back to a hardcoded 12/12/18/24
 * when the database had nothing. An employee with no entitlement saw twelve
 * days of casual leave, applied for them, and was refused by a system that had
 * just told them they were available.
 *
 * Nothing here invents a number. A figure that is not known comes back as null
 * or zero with a name that says which.
 */

export interface CompanySummary {
  date: CalendarDate
  totalEmployees: number
  presentToday: number
  onLeaveToday: number
  absentToday: number
  /** Nobody has recorded anything for these people yet — not the same as absent. */
  /**
   * Whether today is a company weekly off, and how many people that covers.
   *
   * DERIVED from the policy, not counted from attendance — the system does not
   * create rows for days nobody works, so there is nothing to count. Reporting
   * zero would be wrong in a different way: it would say everybody was absent
   * on a Sunday.
   */
  isWeeklyOffToday: boolean
  weeklyOffToday: number
  notMarkedToday: number
  pendingLeaveCount: number
  /** Of those, the ones the caller decides in the company tree (Day 22). */
  pendingForMe: number
  pendingLeaves: {
    /** Theirs to decide — the screen draws Approve and Reject only on these. */
    canDecide: boolean
    id: string
    employeeId: string
    employeeCode: string
    fullName: string
    department: string | null
    leaveType: string
    leaveTypeName: string
    fromDate: CalendarDate
    toDate: CalendarDate
    days: number
    reason: string
    appliedAt: string
  }[]
  byDepartment: { department: string; headcount: number; presentToday: number }[]
  thisWeek: { date: CalendarDate; present: number; absent: number; onLeave: number }[]
  recentJoiners: { id: string; fullName: string; employeeCode: string; department: string | null; dateOfJoining: CalendarDate | null }[]
}

/**
 * The company view, for anybody who manages people.
 *
 * Scoped like everything else: a manager's figures cover their team, HR's cover
 * the company. The same endpoint, two different truths, decided by the scope
 * rather than by which page called it.
 */
export async function companySummary(ctx: AppContext): Promise<CompanySummary> {
  const today = zonedToday(new Date(), await companyTimezone(ctx))
  const weekStart = mondayOf(today)

  // The ATTENDANCE scope, deliberately — not the employee one — and for every
  // figure: the headcount, today, and the week.
  //
  // A manager may browse the whole staff directory (§4.4) but may only see
  // their own team attendance. Counting headcount from the directory would
  // produce "2 present out of 40" on a dashboard that can see two people
  // attendance — arithmetically true and completely misleading. The week's
  // figures used to be counted across the whole company whatever the scope,
  // and anybody who could open this — Admin, whom the matrix keeps out of
  // attendance altogether — saw today's for the whole company too.
  const scope = ctx.scopeFor('attendance')

  const policy = await getCurrentPolicy(ctx.db)
  const weeklyOffDays = policy?.weeklyOffDays ?? [0]
  const isWeeklyOffToday = weeklyOffDays.includes(new Date(`${today}T00:00:00Z`).getUTCDay())

  const [employees, weekRows, seen, world] = await Promise.all([
    attendanceRepo.peopleInScope(ctx.db, scope),
    attendanceRepo.statusesBetween(ctx.db, scope, toDateColumn(weekStart), toDateColumn(today)),
    leaveRepo.listRequests(ctx.db, ctx.scopeFor('leave'), { status: 'pending' }),
    approvalWorld(ctx.db, ctx.organizationId),
  ])
  // Waiting leave: what the leave scope shows (all of it for HR, who decides
  // none), and the requests the caller decides in the company tree (Day 22)
  // whatever their scope — those first, each saying whether it is theirs.
  const decider = deciderOf(ctx)
  const decides = await leaveRepo.requestsOf(ctx.db, peopleDecidedBy(world, decider), { status: 'pending' })
  const byId = new Map([...decides, ...seen].map((r) => [r.id, r]))
  const pending = [...byId.values()]
    .map((r) => {
      const rights = rightsOn(world, decider, r)
      // "Yours" is the requests asked of the caller — not every one they could
      // decide as the stand-in, which for a Super Admin is all of them.
      return { request: r, canDecide: rights.canDecide, mine: rights.canDecide && !rights.asBackup }
    })
    .sort((a, b) => Number(b.mine) - Number(a.mine) || b.request.appliedAt.getTime() - a.request.appliedAt.getTime())

  // Today's counts are of the people on the headcount, so the two agree.
  const visible = new Set(employees.map((e) => e.id))
  const mine = weekRows.filter((r) => fromDateColumn(r.date) === today && visible.has(r.employeeId))

  const countOf = (status: string) => mine.filter((r) => r.status === status).length

  const byDepartment = new Map<string, { headcount: number; presentToday: number }>()
  for (const employee of employees) {
    const name = employee.department?.name ?? 'Unassigned'
    const entry = byDepartment.get(name) ?? { headcount: 0, presentToday: 0 }
    entry.headcount += 1
    byDepartment.set(name, entry)
  }
  for (const row of mine) {
    if (row.status !== 'present') continue
    const employee = employees.find((e) => e.id === row.employeeId)
    const name = employee?.department?.name ?? 'Unassigned'
    const entry = byDepartment.get(name)
    if (entry) entry.presentToday += 1
  }

  const thisWeek: CompanySummary['thisWeek'] = []
  for (let offset = 0; offset < 7; offset++) {
    const date = addCalendarDays(weekStart, offset)
    if (date > today) break

    const rows = weekRows.filter((r) => fromDateColumn(r.date) === date)
    thisWeek.push({
      date,
      present: rows.filter((r) => r.status === 'present').length,
      absent: rows.filter((r) => r.status === 'absent').length,
      onLeave: rows.filter((r) => r.status === 'on_leave').length,
    })
  }

  return {
    date: today,
    totalEmployees: employees.length,
    presentToday: countOf('present'),
    onLeaveToday: countOf('on_leave'),
    absentToday: countOf('absent'),
    // Kept separate from absent. The old dashboard added them together and
    // reported the whole company absent every morning until somebody marked.
    isWeeklyOffToday,
    weeklyOffToday: isWeeklyOffToday ? employees.length : 0,
    // On a weekly off nobody is expected to mark anything, so "not marked" is
    // not a gap — it is the day working as intended.
    notMarkedToday: isWeeklyOffToday ? 0 : Math.max(0, employees.length - mine.length),
    pendingLeaveCount: pending.length,
    pendingForMe: pending.filter((p) => p.mine).length,
    pendingLeaves: pending.slice(0, 5).map(({ request, canDecide }) => ({
      canDecide,
      id: request.id,
      employeeId: request.employeeId,
      employeeCode: request.employee.employeeCode,
      fullName: request.employee.fullName,
      department: request.employee.department?.name ?? null,
      leaveType: request.leaveType.code,
      leaveTypeName: request.leaveType.name,
      fromDate: fromDateColumn(request.fromDate),
      toDate: fromDateColumn(request.toDate),
      days: Number(request.days),
      reason: request.reason,
      appliedAt: isoInstant(request.appliedAt),
    })),
    byDepartment: [...byDepartment.entries()].map(([department, counts]) => ({
      department,
      ...counts,
    })),
    thisWeek,
    recentJoiners: employees
      .filter((e) => e.dateOfJoining)
      .slice(0, 5)
      .map((e) => ({
        id: e.id,
        fullName: e.fullName,
        employeeCode: e.employeeCode,
        department: e.department?.name ?? null,
        dateOfJoining: fromDateColumn(e.dateOfJoining),
      })),
  }
}

export interface MySummary {
  date: CalendarDate
  employee: {
    fullName: string
    employeeCode: string
    department: string | null
    designation: string | null
    dateOfJoining: CalendarDate | null
    attendanceMode: string
    phone: string | null
    reportingManagerName: string | null
    reportingManagerDesignation: string | null
  }
  thisMonth: {
    presentDays: number
    halfDays: number
    absentDays: number
    leaveDays: number
    totalHours: number
    /** The company's weekly offs from the 1st to today — counted from the rule, not from rows. */
    weeklyOffDays: number
  }
  today: { status: string | null; checkIn: string | null; checkOut: string | null; hoursWorked: number | null }
  leaveBalances: { code: string; name: string; annualQuota: number; balance: number; pending: number; available: number }[]
  /** Leave requests waiting for this person to decide (Day 22: they have people under them). */
  waitingForMe: number
  recentLeaves: {
    id: string
    leaveType: string
    leaveTypeName: string
    fromDate: CalendarDate
    toDate: CalendarDate
    days: number
    status: string
    appliedAt: string
  }[]
}

/** The employee's own view. */
export async function mySummary(ctx: AppContext): Promise<MySummary> {
  if (!ctx.employeeId) {
    throw Forbidden('Your account has no employee record, so there is no personal dashboard.')
  }

  const timezone = await companyTimezone(ctx)
  const today = zonedToday(new Date(), timezone)
  const monthStart = `${today.slice(0, 7)}-01`

  const policy = await getCurrentPolicy(ctx.db)
  const leaveYear = leaveYearOf(today, policy?.leaveYearStartMonth ?? 4)

  const [employee, monthRows, balances, leaves, world] = await Promise.all([
    employeeRepo.findCard(ctx.db, ctx.employeeId),
    attendanceRepo.daysFor(ctx.db, ctx.employeeId, toDateColumn(monthStart), toDateColumn(today)),
    leaveRepo.balancesFor(ctx.db, ctx.employeeId, leaveYear),
    leaveRepo.listRequests(ctx.db, { scope: 'SELF', employeeId: ctx.employeeId }, {}),
    approvalWorld(ctx.db, ctx.organizationId),
  ])
  const waitingForMe = await leaveRepo.countPendingOf(ctx.db, peopleDecidedBy(world, deciderOf(ctx)))

  const countOf = (status: string) => monthRows.filter((r) => r.status === status).length
  const todayRow = monthRows.find((r) => fromDateColumn(r.date) === today)

  // Nobody marks a weekly off, so there are no rows to count: the days are
  // counted from the company's rule, over the same 1st-to-today window.
  // From the joining day, for somebody who started this month.
  const offs = policy?.weeklyOffDays ?? []
  const joined = fromDateColumn(employee?.dateOfJoining)
  const countFrom = joined && joined > monthStart ? joined : monthStart
  let weeklyOffDays = 0
  for (let day = countFrom; day <= today; day = addCalendarDays(day, 1)) {
    if (offs.includes(new Date(`${day}T00:00:00Z`).getUTCDay())) weeklyOffDays++
  }

  return {
    date: today,
    employee: {
      fullName: employee?.fullName ?? '',
      employeeCode: employee?.employeeCode ?? '',
      department: employee?.department?.name ?? null,
      designation: employee?.designation?.name ?? null,
      dateOfJoining: fromDateColumn(employee?.dateOfJoining),
      attendanceMode: employee?.attendanceMode ?? 'app',
      phone: employee?.phone ?? null,
      // One who has left decides nothing (Day 22): nobody is above them until placed.
      reportingManagerName: employee?.reportingManager && !employee.reportingManager.archivedAt ? employee.reportingManager.fullName : null,
      reportingManagerDesignation: employee?.reportingManager?.designation?.name ?? null,
    },
    thisMonth: {
      presentDays: countOf('present'),
      halfDays: countOf('half_day'),
      absentDays: countOf('absent'),
      leaveDays: countOf('on_leave'),
      // The figure the client asked to see. Summed from stored hours, so it
      // matches what the attendance page and the payslip will say.
      totalHours:
        Math.round(
          monthRows.reduce((sum, r) => sum + (r.hoursWorked ? Number(r.hoursWorked) : 0), 0) * 100,
        ) / 100,
      weeklyOffDays,
    },
    today: {
      status: todayRow?.status ?? null,
      checkIn: isoInstant(todayRow?.checkIn),
      checkOut: isoInstant(todayRow?.checkOut),
      hoursWorked: todayRow?.hoursWorked ? Number(todayRow.hoursWorked) : null,
    },
    // Straight from the ledger. NO FALLBACK — somebody with no entitlement sees
    // zero, which is the truth, rather than a comfortable twelve that would let
    // them apply for leave they do not have.
    leaveBalances: balances.map((b) => ({
      code: b.code,
      name: b.name,
      annualQuota: b.annualQuota,
      balance: b.balance,
      pending: b.pending,
      available: b.available,
    })),
    waitingForMe,
    recentLeaves: leaves.slice(0, 5).map((request) => ({
      id: request.id,
      leaveType: request.leaveType.code,
      leaveTypeName: request.leaveType.name,
      fromDate: fromDateColumn(request.fromDate),
      toDate: fromDateColumn(request.toDate),
      days: Number(request.days),
      status: request.status,
      appliedAt: isoInstant(request.appliedAt),
    })),
  }
}
