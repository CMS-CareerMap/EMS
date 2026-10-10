import type { AppContext } from '../../platform/context'
import type { ScopeContext } from '../../platform/authz/scope'
import { Forbidden } from '../../platform/errors/AppError'
import { zonedToday, toDateColumn, fromDateColumn, isoInstant, addCalendarDays, type CalendarDate } from '../../domain/shared/dates'
import { shiftRulesOf, stillAtWork } from '../../domain/attendance/shiftRules'
import * as leaveRepo from '../leave/leave.repository'
import { asApplications } from '../../domain/leave/applications'
import * as attendanceRepo from '../attendance/attendance.repository'
import * as employeeRepo from '../employee/employee.repository'
import * as repo from './dashboard.repository'
import { leaveYearOf } from '../leave/leave.service'
import { companyTimezone } from '../organization/organization.service'
import { getCurrentPolicy } from '../settings/settings.repository'
import { approvalWorld, deciderOf, peopleDecidedBy } from '../leave/leaveApprover.service'
import { listRuns } from '../payroll/payrollRun.service'
import { listLoans } from '../payroll/loans.service'
import { listBankAccounts } from '../payroll/bankAccount.service'
import { listMonthlyEntries } from '../payroll/payrollInputs.service'

/**
 * The home page, one section at a time.
 *
 * Each section answers from its own question and its own reach, and the page
 * shows a section only to a login whose permissions open it:
 *
 *   - `today`    — the ATTENDANCE reach (a manager's team, HR's company);
 *   - `people`   — the EMPLOYEE reach (the staff a login looks after);
 *   - `payroll`  — the company's payroll, for whoever reads payroll;
 *   - `me`       — the signed-in person's own day, month and leave.
 *
 * They used to be one "company summary" counted on the attendance reach,
 * which gave Admin — whose attendance reach is their own — a company of one,
 * and listed as "joined in the last 60 days" the first five people of the
 * list whenever they had joined.
 *
 * Nothing here invents a number. A figure that is not known comes back as null
 * or zero with a name that says which.
 */

const JOINERS_WINDOW_DAYS = 60

/** How far a reach goes, as the screen says it. */
function reachOf(scope: ScopeContext): 'company' | 'team' | 'self' {
  if (scope.scope === 'SELF') return 'self'
  if (scope.scope === 'ORGANIZATION' || scope.scope === 'ORGANIZATION_EXCEPT_ABOVE') return 'company'
  return 'team'
}

const weekdayOf = (day: CalendarDate) => new Date(`${day}T00:00:00Z`).getUTCDay()

// ── Today ───────────────────────────────────────────────────────────────────

export interface TodaySummary {
  date: CalendarDate
  reach: 'company' | 'team' | 'self'
  /** Today is a company day off: nobody is expected in, so nobody is "not marked". */
  dayOff: 'holiday' | 'weekly_off' | null
  holiday: string | null
  /** The people at work today within the reach — joined by today, not yet gone. */
  headcount: number
  counts: {
    present: number
    halfDay: number
    absent: number
    onLeave: number
    /** Present or half day, and in after the shift's grace. */
    late: number
    /** Working, from home or on duty rather than the office. */
    away: number
    notMarked: number
  }
  /** The last seven days, today last. */
  week: { date: CalendarDate; present: number; halfDay: number; absent: number; onLeave: number; dayOff: 'holiday' | 'weekly_off' | null; holiday: string | null }[]
  people: {
    id: string
    fullName: string
    employeeCode: string
    designation: string | null
    department: string | null
    status: string | null
    checkIn: string | null
    checkOut: string | null
    lateMinutes: number | null
    workMode: string | null
    isSelf: boolean
    /** Checked in on the app and still at work now (stillAtWork) — the card runs their time. */
    atWork: boolean
  }[]
  /** Leave, working from home and on duty from today to six days ahead — waiting or approved. */
  away: { employeeId: string; fullName: string; kind: 'leave' | 'work_from_home' | 'on_duty'; label: string; from: CalendarDate; to: CalendarDate; status: string }[]
}

export async function todaySummary(ctx: AppContext): Promise<TodaySummary> {
  const scope = ctx.scopeFor('attendance')
  // Somebody who sees only their own attendance has no "today at work" to
  // show: it would be a company of one (Admin's used to read "1 employee,
  // 0 present"). Their own day is on the home page.
  if (scope.scope === 'SELF') {
    throw Forbidden('You see only your own attendance. Your own day is on your home page.')
  }
  const timezone = await companyTimezone(ctx)
  const now = new Date()
  const today = zonedToday(now, timezone)
  const weekFrom = addCalendarDays(today, -6)
  const aheadTo = addCalendarDays(today, 6)

  const policy = await getCurrentPolicy(ctx.db)
  const weeklyOffDays = policy?.weeklyOffDays ?? [0]

  const [roster, weekRows, daysOff] = await Promise.all([
    attendanceRepo.dayRoster(ctx.db, scope, today),
    attendanceRepo.statusesBetween(ctx.db, scope, toDateColumn(weekFrom), toDateColumn(today)),
    repo.daysOffBetween(ctx.db, toDateColumn(weekFrom), toDateColumn(aheadTo)),
  ])
  const ids = roster.map((r) => r.id)
  // Leave — its type, waiting or approved — only for a login that reads
  // leave, and within its leave reach: the attendance reach says who came
  // in, not why somebody is off. (A role made with attendance and no leave
  // saw everybody's sick leave here.)
  const leaveReach = ctx.can('leave:read') ? new Set((await leaveRepo.peopleInScope(ctx.db, ctx.scopeFor('leave'))).map((p) => p.id)) : new Set<string>()
  const [leave, requests] = await Promise.all([
    repo.leaveTouching(ctx.db, ids.filter((id) => leaveReach.has(id)), toDateColumn(today), toDateColumn(aheadTo)),
    repo.awayRequestsTouching(ctx.db, ids, toDateColumn(today), toDateColumn(aheadTo)),
  ])

  const holidays = new Map(daysOff.filter((d) => d.type === 'public').map((d) => [fromDateColumn(d.date), d.name]))
  const offRows = new Set(daysOff.filter((d) => d.type === 'weekly_off').map((d) => fromDateColumn(d.date)))
  const dayOffOf = (day: CalendarDate): 'holiday' | 'weekly_off' | null =>
    holidays.has(day) ? 'holiday' : weeklyOffDays.includes(weekdayOf(day)) || offRows.has(day) ? 'weekly_off' : null

  const todays = roster.map((person) => ({ person, row: person.attendance[0] ?? null }))
  const statusCount = (status: string) => todays.filter((t) => t.row?.status === status).length
  const dayOff = dayOffOf(today)

  const week: TodaySummary['week'] = []
  for (let day = weekFrom; day <= today; day = addCalendarDays(day, 1)) {
    const rows = weekRows.filter((r) => fromDateColumn(r.date) === day)
    const of = (status: string) => rows.filter((r) => r.status === status).length
    week.push({ date: day, present: of('present'), halfDay: of('half_day'), absent: of('absent'), onLeave: of('on_leave'), dayOff: dayOffOf(day), holiday: holidays.get(day) ?? null })
  }

  const away: TodaySummary['away'] = [
    ...leave.map((l) => ({
      employeeId: l.employeeId,
      fullName: l.employee.fullName,
      kind: 'leave' as const,
      label: l.leaveType.name,
      from: fromDateColumn(l.fromDate),
      to: fromDateColumn(l.toDate),
      status: l.status,
    })),
    ...requests.map((r) => ({
      employeeId: r.employeeId,
      fullName: r.employee.fullName,
      kind: r.type as 'work_from_home' | 'on_duty',
      label: r.type === 'work_from_home' ? 'Work from home' : 'On duty',
      from: fromDateColumn(r.fromDate) as CalendarDate,
      to: (fromDateColumn(r.toDate) ?? fromDateColumn(r.fromDate)) as CalendarDate,
      status: r.status,
    })),
  ].sort((a, b) => a.from.localeCompare(b.from) || a.fullName.localeCompare(b.fullName))

  return {
    date: today,
    reach: reachOf(scope),
    dayOff,
    holiday: holidays.get(today) ?? null,
    headcount: roster.length,
    counts: {
      present: statusCount('present'),
      halfDay: statusCount('half_day'),
      absent: statusCount('absent'),
      onLeave: statusCount('on_leave'),
      late: todays.filter((t) => t.row && ['present', 'half_day'].includes(t.row.status) && (t.row.lateMinutes ?? 0) > 0).length,
      away: todays.filter((t) => t.row?.workMode && t.row.workMode !== 'office').length,
      // Kept apart from absent: nobody marked is not the same as away. On a
      // day off nobody is expected to mark anything.
      notMarked: dayOff ? 0 : todays.filter((t) => !t.row).length,
    },
    week,
    people: todays.map(({ person, row }) => ({
      id: person.id,
      fullName: person.fullName,
      employeeCode: person.employeeCode,
      designation: person.designation?.name ?? null,
      department: person.department?.name ?? null,
      status: row?.status ?? null,
      checkIn: isoInstant(row?.checkIn),
      checkOut: isoInstant(row?.checkOut),
      lateMinutes: row?.lateMinutes ?? null,
      workMode: row?.workMode ?? null,
      isSelf: person.id === ctx.employeeId,
      // At work now, by the roster's rule (stillAtWork): only somebody who
      // checks in on the app — a day HR typed or the machine sent is not run on.
      atWork: Boolean(person.attendanceMode === 'app' && row && stillAtWork({
        date: today, today, checkIn: row.checkIn, checkOut: row.checkOut, rules: shiftRulesOf(row.shift),
        timezone, now, checkedInToday: false,
      })),
    })),
    away,
  }
}

// ── People ──────────────────────────────────────────────────────────────────

export interface PeopleSummary {
  date: CalendarDate
  total: number
  active: number
  inactive: number
  byDepartment: { department: string; headcount: number }[]
  /** Who joined in the last 60 days, newest first. */
  joiners: { id: string; fullName: string; employeeCode: string; department: string | null; designation: string | null; dateOfJoining: CalendarDate }[]
  /** Still working, with a last day ahead — serving notice, or a contract's end. Soonest first. */
  leaving: { id: string; fullName: string; department: string | null; lastWorkingDate: CalendarDate }[]
  /** Gone in the last 60 days, most recent first. */
  recentlyLeft: { id: string; fullName: string; department: string | null; lastWorkingDate: CalendarDate }[]
}

export async function peopleSummary(ctx: AppContext): Promise<PeopleSummary> {
  const today = zonedToday(new Date(), await companyTimezone(ctx))
  const since = addCalendarDays(today, -JOINERS_WINDOW_DAYS)
  const people = await repo.peopleInReach(ctx.db, ctx.scopeFor('employee'))
  const active = people.filter((p) => p.status === 'active')

  const departments = new Map<string, number>()
  for (const p of active) {
    const name = p.department?.name ?? 'Unassigned'
    departments.set(name, (departments.get(name) ?? 0) + 1)
  }

  const brief = (p: (typeof people)[number]) => ({ id: p.id, fullName: p.fullName, department: p.department?.name ?? null })

  return {
    date: today,
    total: people.length,
    active: active.length,
    inactive: people.length - active.length,
    byDepartment: [...departments.entries()].map(([department, headcount]) => ({ department, headcount })).sort((a, b) => b.headcount - a.headcount || a.department.localeCompare(b.department)),
    joiners: people
      .map((p) => ({ p, joined: fromDateColumn(p.dateOfJoining) }))
      .filter(({ joined }) => joined !== null && joined >= since && joined <= today)
      .sort((a, b) => (b.joined as string).localeCompare(a.joined as string))
      .map(({ p, joined }) => ({ ...brief(p), employeeCode: p.employeeCode, designation: p.designation?.name ?? null, dateOfJoining: joined as CalendarDate })),
    leaving: active
      .map((p) => ({ p, last: fromDateColumn(p.lastWorkingDate) }))
      .filter(({ last }) => last !== null && last >= today)
      .sort((a, b) => (a.last as string).localeCompare(b.last as string))
      .map(({ p, last }) => ({ ...brief(p), lastWorkingDate: last as CalendarDate })),
    recentlyLeft: people
      .filter((p) => p.status !== 'active')
      .map((p) => ({ p, last: fromDateColumn(p.lastWorkingDate) }))
      .filter(({ last }) => last !== null && last >= since && last < today)
      .sort((a, b) => (b.last as string).localeCompare(a.last as string))
      .map(({ p, last }) => ({ ...brief(p), lastWorkingDate: last as CalendarDate })),
  }
}

// ── Payroll ─────────────────────────────────────────────────────────────────

interface RunBrief {
  id: string
  year: number
  month: number
  status: string
  employees: number
  gross: number
  deductions: number
  net: number
  employerPf: number
  employerEsi: number
  calculatedAt: string | null
  approvedAt: string | null
  paidOn: CalendarDate | null
}

export interface PayrollSummary {
  date: CalendarDate
  latest: RunBrief | null
  previous: RunBrief | null
  /** The month the next run is for — the one after the newest run, never past this month. Null when this month has one. */
  next: { year: number; month: number } | null
  /** Salary accounts of the people at work. Null for a login that may not see bank accounts. */
  bank: {
    verified: number
    waiting: number
    rejected: number
    unchecked: number
    none: number
    /** Waiting for this login to check, and people with no account yet — the first few of each. */
    toCheck: { employeeId: string; fullName: string; employeeCode: string }[]
    without: { employeeId: string; fullName: string; employeeCode: string }[]
  } | null
  /** Amounts entered for a month (incentives and the like), for the newest run's month and this one. */
  entries: { year: number; month: number; count: number; total: number }[]
  loans: { active: number; left: number }
}

const monthKey = (m: { year: number; month: number }) => m.year * 12 + m.month

export async function payrollSummary(ctx: AppContext): Promise<PayrollSummary> {
  const today = zonedToday(new Date(), await companyTimezone(ctx))
  const thisMonth = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }

  const [runs, loans, bankRows] = await Promise.all([
    listRuns(ctx),
    listLoans(ctx),
    ctx.can('employee:bank:read') ? listBankAccounts(ctx) : Promise.resolve(null),
  ])

  const brief = (run: (typeof runs)[number] | undefined): RunBrief | null => (run
    ? {
        id: run.id,
        year: run.year,
        month: run.month,
        status: run.status,
        employees: run.employeeCount,
        gross: Number(run.grossEarnings),
        deductions: Number(run.totalDeductions),
        net: Number(run.netPayable),
        employerPf: Number(run.employerPf),
        employerEsi: Number(run.employerEsi),
        calculatedAt: isoInstant(run.calculatedAt),
        approvedAt: isoInstant(run.approvedAt),
        paidOn: fromDateColumn(run.paidOn),
      }
    : null)

  const latest = runs[0]
  let next: { year: number; month: number } | null = thisMonth
  if (latest) {
    const after = latest.month === 12 ? { year: latest.year + 1, month: 1 } : { year: latest.year, month: latest.month + 1 }
    next = monthKey(after) <= monthKey(thisMonth) ? after : null
  }

  const months = [latest ? { year: latest.year, month: latest.month } : null, thisMonth]
    .filter((m): m is { year: number; month: number } => m !== null)
    .filter((m, i, all) => all.findIndex((o) => monthKey(o) === monthKey(m)) === i)
  const entries = await Promise.all(months.map(async (m) => {
    const { entries: rows } = await listMonthlyEntries(ctx, m.year, m.month)
    return { ...m, count: rows.length, total: Math.round(rows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100 }
  }))

  let bank: PayrollSummary['bank'] = null
  if (bankRows) {
    const working = bankRows.filter(({ row }) => row.status === 'active')
    const statusOf = (s: string) => working.filter(({ row }) => row.bankAccount?.verificationStatus === s)
    const person = ({ row }: (typeof working)[number]) => ({ employeeId: row.id, fullName: row.fullName, employeeCode: row.employeeCode })
    bank = {
      verified: statusOf('verified').length,
      waiting: statusOf('pending').length,
      rejected: statusOf('rejected').length,
      unchecked: statusOf('unverified').length,
      none: working.filter(({ row }) => !row.bankAccount).length,
      toCheck: working.filter(({ row, check }) => ['pending', 'unverified'].includes(row.bankAccount?.verificationStatus ?? '') && check.allowed).slice(0, 5).map(person),
      without: working.filter(({ row }) => !row.bankAccount).slice(0, 5).map(person),
    }
  }

  const running = loans.filter((l) => l.status === 'active')
  return {
    date: today,
    latest: brief(runs[0]),
    previous: brief(runs[1]),
    next,
    bank,
    entries,
    loans: { active: running.length, left: Math.round(running.reduce((s, l) => s + l.left, 0) * 100) / 100 },
  }
}

// ── Me ──────────────────────────────────────────────────────────────────────

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
  today: { status: string | null; checkIn: string | null; checkOut: string | null; hoursWorked: number | null; lateMinutes: number | null }
  /** Their last seven days, today last — with the company's days off named, which have no rows. */
  recentDays: {
    date: CalendarDate
    status: string | null
    checkIn: string | null
    checkOut: string | null
    hoursWorked: number | null
    lateMinutes: number | null
    dayOff: 'holiday' | 'weekly_off' | null
    holiday: string | null
    /** Checked into and still theirs now, by the rule their own card counts by (stillAtWork; client, 9 Oct 2026). */
    atWork: boolean
  }[]
  /** `unlimited`: unpaid with no days a year (Loss of Pay) — shown only once some is `taken`. */
  leaveBalances: { code: string; name: string; annualQuota: number; balance: number; pending: number; available: number; isPaid: boolean; unlimited: boolean; taken: number }[]
  /** Leave requests waiting for this person to decide (Day 22: they have people under them). */
  waitingForMe: number
  /** Their latest applications — one in parts (client, 9 Oct 2026) as one, its types joined. */
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
  const now = new Date()
  const today = zonedToday(now, timezone)
  const monthStart = `${today.slice(0, 7)}-01`
  const weekFrom = addCalendarDays(today, -6)

  const policy = await getCurrentPolicy(ctx.db)
  const leaveYear = leaveYearOf(today, policy?.leaveYearStartMonth ?? 4)

  const [employee, monthRows, balances, leaves, world, lastWeek, daysOff] = await Promise.all([
    employeeRepo.findCard(ctx.db, ctx.employeeId),
    attendanceRepo.daysFor(ctx.db, ctx.employeeId, toDateColumn(monthStart), toDateColumn(today)),
    leaveRepo.balancesFor(ctx.db, ctx.employeeId, leaveYear),
    leaveRepo.listRequests(ctx.db, { scope: 'SELF', employeeId: ctx.employeeId }, {}),
    approvalWorld(ctx.db, ctx.organizationId),
    repo.myDays(ctx.db, ctx.employeeId, toDateColumn(weekFrom), toDateColumn(today)),
    repo.daysOffBetween(ctx.db, toDateColumn(weekFrom), toDateColumn(today)),
  ])
  const waitingForMe = await leaveRepo.countPendingOf(ctx.db, peopleDecidedBy(world, deciderOf(ctx)))

  const countOf = (status: string) => monthRows.filter((r) => r.status === status).length
  const todayRow = lastWeek.find((r) => fromDateColumn(r.date) === today)

  // Nobody marks a weekly off, so there are no rows to count: the days are
  // counted from the company's rule, over the same 1st-to-today window.
  // From the joining day, for somebody who started this month.
  // Sunday with no policy written yet — as leave is counted, and as the column defaults.
  const offs = policy?.weeklyOffDays ?? [0]
  const joined = fromDateColumn(employee?.dateOfJoining)
  const countFrom = joined && joined > monthStart ? joined : monthStart
  let weeklyOffDays = 0
  for (let day = countFrom; day <= today; day = addCalendarDays(day, 1)) {
    if (offs.includes(weekdayOf(day))) weeklyOffDays++
  }

  const holidays = new Map(daysOff.filter((d) => d.type === 'public').map((d) => [fromDateColumn(d.date), d.name]))
  const offRows = new Set(daysOff.filter((d) => d.type === 'weekly_off').map((d) => fromDateColumn(d.date)))
  const recentDays: MySummary['recentDays'] = []
  // Still at work, by the rule their own card and the roster count by — a night
  // shift's day is yesterday's — for somebody who checks in on the app (client, 9 Oct 2026).
  const punches = employee?.attendanceMode === 'app'
  for (let day = weekFrom; day <= today; day = addCalendarDays(day, 1)) {
    const row = lastWeek.find((r) => fromDateColumn(r.date) === day)
    const atWork = Boolean(punches && row && stillAtWork({
      date: day, today, checkIn: row.checkIn, checkOut: row.checkOut, rules: shiftRulesOf(row.shift),
      timezone, now, checkedInToday: Boolean(todayRow?.checkIn),
    }))
    recentDays.push({
      date: day,
      status: row?.status ?? null,
      checkIn: isoInstant(row?.checkIn),
      checkOut: isoInstant(row?.checkOut),
      hoursWorked: row?.hoursWorked ? Number(row.hoursWorked) : null,
      lateMinutes: row?.lateMinutes ?? null,
      dayOff: holidays.has(day) ? 'holiday' : offs.includes(weekdayOf(day)) || offRows.has(day) ? 'weekly_off' : null,
      holiday: holidays.get(day) ?? null,
      atWork,
    })
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
      lateMinutes: todayRow?.lateMinutes ?? null,
    },
    recentDays,
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
      isPaid: b.isPaid,
      unlimited: b.unlimited,
      taken: b.taken,
    })),
    waitingForMe,
    recentLeaves: asApplications(leaves, (r) => fromDateColumn(r.fromDate)!).slice(0, 5).map(({ lead, parts }) => ({
      id: lead.id,
      leaveType: lead.leaveType.code,
      leaveTypeName: parts.map((p) => p.leaveType.name).join(' + '),
      fromDate: fromDateColumn(lead.fromDate),
      toDate: fromDateColumn(parts[parts.length - 1]!.toDate),
      days: Math.round(parts.reduce((a, p) => a + Number(p.days), 0) * 2) / 2,
      status: lead.status,
      appliedAt: isoInstant(lead.appliedAt),
    })),
  }
}
