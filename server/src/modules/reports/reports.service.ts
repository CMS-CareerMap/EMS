import type { AppContext } from '../../platform/context'
import { BadRequest } from '../../platform/errors/AppError'
import type { Weekday } from '../../domain/leave/leaveDays'
import { attendancePercent, leaveDaysWithin, notMarkedDays, type Calendar } from '../../domain/reports/reportMath'
import {
  addCalendarDays,
  dayLabel,
  fromDateColumn,
  monthKey,
  monthName,
  toDateColumn,
  zonedToday,
  type CalendarDate,
} from '../../domain/shared/dates'
import { companyToday, companyTimezone } from '../organization/organization.service'
import { leaveYearOf } from '../leave/leave.service'
import * as repo from './reports.repository'

/**
 * The eight reports on the Reports page, worked out here from the records.
 *
 * Each one comes back as columns, rows and totals — the page draws any report
 * with the same table, and the CSV export is made from the very same rows
 * (reports.controller), so the file and the screen cannot disagree.
 *
 * Nothing is invented for what is not recorded. The old leave-balance report
 * showed 12 / 12 / 18 / 24 / 5 for anybody with no balance row; this shows the
 * ledger, and a person with no ledger has a balance of 0 — which is the truth
 * until their leave is granted.
 */

export const REPORT_IDS = [
  'attendance-summary',
  'attendance-by-department',
  'leave-taken',
  'leave-balances',
  'payroll-summary',
  'pf-esi',
  'headcount',
  'joiners-exits',
] as const

export type ReportId = (typeof REPORT_IDS)[number]

export type ColumnType = 'text' | 'number' | 'days' | 'hours' | 'money' | 'percent' | 'date'

export interface ReportColumn {
  key: string
  label: string
  type: ColumnType
}

export type Cell = string | number | null
export type ReportRow = Record<string, Cell>

export interface ReportResult {
  id: ReportId
  title: string
  period: string
  columns: ReportColumn[]
  rows: ReportRow[]
  totals: ReportRow | null
  notes: string[]
  chart: { kind: 'bar' | 'pie'; label: string; points: { label: string; value: number | null }[] } | null
}

export interface ReportParams extends repo.ReportFilters {
  year: number
  month: number
}

export const REPORT_TITLES: Record<ReportId, string> = {
  'attendance-summary': 'Monthly attendance summary',
  'attendance-by-department': 'Attendance by department',
  'leave-taken': 'Leave taken',
  'leave-balances': 'Leave balances',
  'payroll-summary': 'Monthly payroll',
  'pf-esi': 'PF and ESI contributions',
  headcount: 'Headcount',
  'joiners-exits': 'Joiners and exits',
}

const round2 = (n: number) => Math.round(n * 100) / 100

function monthWindow(year: number, month: number) {
  const from = `${monthKey(year, month)}-01` as CalendarDate
  const next = month === 12 ? `${year + 1}-01-01` : `${monthKey(year, month + 1)}-01`
  const to = addCalendarDays(next as CalendarDate, -1)
  return { from, to }
}

/**
 * When somebody's employment ended: the last working day recorded — or, when
 * nobody recorded one, the day they were let go (archived), in the company's
 * time zone. Null while they still work here.
 */
function lastDayOf(e: { lastWorkingDate: Date | null; archivedAt: Date | null }, timezone: string): CalendarDate | null {
  if (e.lastWorkingDate) return fromDateColumn(e.lastWorkingDate)
  if (e.archivedAt) return zonedToday(e.archivedAt, timezone)
  return null
}

/**
 * Marked inactive, with no last working day and never archived: nobody can say
 * when they left. Payroll leaves such a person out and asks for the date; the
 * reports do the same rather than count them as working every day since.
 */
function unplaceable(e: repo.ReportEmployee): boolean {
  return e.status === 'inactive' && !e.lastWorkingDate && !e.archivedAt
}

/** A person's days in the window: from joining (or the start) to leaving (or the end). */
function employedWithin(e: repo.ReportEmployee, window: { from: CalendarDate; to: CalendarDate }, timezone: string) {
  const joined = e.dateOfJoining ? fromDateColumn(e.dateOfJoining) : null
  const left = lastDayOf(e, timezone)
  const from = joined && joined > window.from ? joined : window.from
  const to = left && left < window.to ? left : window.to
  return from <= to ? { from, to } : null
}

/** Everybody employed in the window, with their days in it — and how many could not be placed. */
async function peopleIn(ctx: AppContext, window: { from: CalendarDate; to: CalendarDate }, p: repo.ReportFilters) {
  const [employees, timezone] = await Promise.all([
    repo.employeesIn(ctx.db, toDateColumn(window.from), toDateColumn(window.to), p),
    companyTimezone(ctx),
  ])
  const people: { employee: repo.ReportEmployee; employed: { from: CalendarDate; to: CalendarDate } }[] = []
  let leftOut = 0
  for (const e of employees) {
    if (unplaceable(e)) {
      leftOut += 1
      continue
    }
    const employed = employedWithin(e, window, timezone)
    if (employed) people.push({ employee: e, employed })
  }
  return { people, leftOut, timezone }
}

const leftOutNote = (n: number): string[] =>
  n === 0 ? [] : [`${n === 1 ? 'One person is' : `${n} people are`} marked inactive with no last working day recorded, and left out — as payroll leaves them out. Record the day on their profile.`]

/** A leave type's column is kept while the type is in use, or while it has days in these rows. */
function typesShown<T extends { code: string; archivedAt: Date | null }>(types: T[], rows: ReportRow[]): T[] {
  return types.filter((t) => !t.archivedAt || rows.some((r) => (r[`type_${t.code}`] ?? 0) !== 0))
}

function sum(rows: ReportRow[], key: string): number {
  return round2(rows.reduce((s, r) => s + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0))
}

async function calendarFor(ctx: AppContext, window: { from: CalendarDate; to: CalendarDate }): Promise<Calendar> {
  const [off, holidays] = await Promise.all([
    // The rules the month had, as payroll counts it — not today's.
    repo.weeklyOffDays(ctx.db, toDateColumn(window.from)),
    repo.daysOff(ctx.db, toDateColumn(window.from), toDateColumn(window.to)),
  ])
  return { weeklyOffDays: (off ?? [0]) as Weekday[], holidays: holidays.map((h) => fromDateColumn(h.date)) }
}

// ── Attendance ──────────────────────────────────────────────────────────────

async function attendanceRows(ctx: AppContext, p: ReportParams) {
  const window = monthWindow(p.year, p.month)
  const today = await companyToday(ctx)
  const [{ people, leftOut }, calendar] = await Promise.all([peopleIn(ctx, window, p), calendarFor(ctx, window)])
  const ids = people.map((x) => x.employee.id)
  const [{ counts, hours }, marked] = await Promise.all([
    repo.attendanceCounts(ctx.db, ids, toDateColumn(window.from), toDateColumn(window.to)),
    repo.markedDays(ctx.db, ids, toDateColumn(window.from), toDateColumn(window.to)),
  ])

  const countOf = new Map<string, number>()
  for (const c of counts) countOf.set(`${c.employeeId}:${c.status}`, c._count._all)
  const hoursOf = new Map(hours.map((h) => [h.employeeId, h._sum.hoursWorked ? Number(h._sum.hoursWorked) : 0]))
  const markedOf = new Map<string, Set<CalendarDate>>()
  for (const m of marked) {
    const set = markedOf.get(m.employeeId) ?? new Set<CalendarDate>()
    set.add(fromDateColumn(m.date))
    markedOf.set(m.employeeId, set)
  }

  const rows = people.flatMap(({ employee: e, employed }) => {
    const n = (status: string) => countOf.get(`${e.id}:${status}`) ?? 0
    const present = n('present')
    const half = n('half_day')
    const absent = n('absent')
    return [{
      employee: e,
      row: {
        employee_code: e.employeeCode,
        full_name: e.fullName,
        department: e.department?.name ?? null,
        present,
        half_day: half,
        absent,
        on_leave: n('on_leave'),
        holiday: n('holiday'),
        weekly_off: n('weekly_off'),
        not_marked: notMarkedDays(employed, today, calendar, markedOf.get(e.id) ?? new Set()),
        hours: round2(hoursOf.get(e.id) ?? 0),
        attendance_pct: attendancePercent(present, half, absent),
      } satisfies ReportRow,
    }]
  })
  return { rows, leftOut }
}

async function attendanceSummary(ctx: AppContext, p: ReportParams): Promise<Omit<ReportResult, 'id' | 'title'>> {
  const found = await attendanceRows(ctx, p)
  const rows = found.rows.map((r) => r.row)
  const totalsRow: ReportRow = {
    employee_code: null,
    full_name: `Total (${rows.length})`,
    department: null,
    present: sum(rows, 'present'),
    half_day: sum(rows, 'half_day'),
    absent: sum(rows, 'absent'),
    on_leave: sum(rows, 'on_leave'),
    holiday: sum(rows, 'holiday'),
    weekly_off: sum(rows, 'weekly_off'),
    not_marked: sum(rows, 'not_marked'),
    hours: sum(rows, 'hours'),
    attendance_pct: attendancePercent(sum(rows, 'present'), sum(rows, 'half_day'), sum(rows, 'absent')),
  }
  return {
    period: monthName(p.year, p.month),
    columns: [
      { key: 'employee_code', label: 'Code', type: 'text' },
      { key: 'full_name', label: 'Employee', type: 'text' },
      { key: 'department', label: 'Department', type: 'text' },
      { key: 'present', label: 'Present', type: 'number' },
      { key: 'half_day', label: 'Half day', type: 'number' },
      { key: 'absent', label: 'Absent', type: 'number' },
      { key: 'on_leave', label: 'On leave', type: 'number' },
      { key: 'holiday', label: 'Holiday', type: 'number' },
      { key: 'weekly_off', label: 'Weekly off', type: 'number' },
      { key: 'not_marked', label: 'Not marked', type: 'number' },
      { key: 'hours', label: 'Hours', type: 'hours' },
      { key: 'attendance_pct', label: 'Attendance %', type: 'percent' },
    ],
    rows,
    totals: rows.length ? totalsRow : null,
    notes: [
      'Attendance % is present days (half days as halves) over the days they were expected to work and were not on leave.',
      'Not marked counts working days up to today with nothing recorded — neither present nor absent.',
      ...leftOutNote(found.leftOut),
    ],
    chart: null,
  }
}

async function attendanceByDepartment(ctx: AppContext, p: ReportParams): Promise<Omit<ReportResult, 'id' | 'title'>> {
  const { rows, leftOut } = await attendanceRows(ctx, p)
  interface DeptTotals {
    department: string
    employees: number
    present: number
    half_day: number
    absent: number
    on_leave: number
    not_marked: number
    hours: number
  }
  const byDept = new Map<string, DeptTotals>()
  for (const { row } of rows) {
    const name = (row.department as string | null) ?? 'No department'
    const agg = byDept.get(name) ?? { department: name, employees: 0, present: 0, half_day: 0, absent: 0, on_leave: 0, not_marked: 0, hours: 0 }
    agg.employees += 1
    for (const key of ['present', 'half_day', 'absent', 'on_leave', 'not_marked', 'hours'] as const) {
      agg[key] = round2(agg[key] + (row[key] as number))
    }
    byDept.set(name, agg)
  }
  const out: ReportRow[] = [...byDept.values()]
    .sort((a, b) => a.department.localeCompare(b.department))
    .map((d) => ({
      department: d.department,
      employees: d.employees,
      present: d.present,
      half_day: d.half_day,
      absent: d.absent,
      on_leave: d.on_leave,
      not_marked: d.not_marked,
      hours: d.hours,
      attendance_pct: attendancePercent(d.present, d.half_day, d.absent),
    }))
  return {
    period: monthName(p.year, p.month),
    columns: [
      { key: 'department', label: 'Department', type: 'text' },
      { key: 'employees', label: 'Employees', type: 'number' },
      { key: 'present', label: 'Present', type: 'number' },
      { key: 'half_day', label: 'Half day', type: 'number' },
      { key: 'absent', label: 'Absent', type: 'number' },
      { key: 'on_leave', label: 'On leave', type: 'number' },
      { key: 'not_marked', label: 'Not marked', type: 'number' },
      { key: 'hours', label: 'Hours', type: 'hours' },
      { key: 'attendance_pct', label: 'Attendance %', type: 'percent' },
    ],
    rows: out,
    totals: null,
    notes: ['Attendance % is present days (half days as halves) over the days people were expected to work and were not on leave.', ...leftOutNote(leftOut)],
    chart: { kind: 'bar', label: 'Attendance %', points: out.map((d) => ({ label: String(d.department), value: typeof d.attendance_pct === 'number' ? d.attendance_pct : null })) },
  }
}

// ── Leave ───────────────────────────────────────────────────────────────────

async function leaveTaken(ctx: AppContext, p: ReportParams): Promise<Omit<ReportResult, 'id' | 'title'>> {
  const window = monthWindow(p.year, p.month)
  const [{ people, leftOut }, types, calendar] = await Promise.all([peopleIn(ctx, window, p), repo.leaveTypes(ctx.db), calendarFor(ctx, window)])
  const employees = people.map((x) => x.employee)
  const requests = await repo.approvedLeave(ctx.db, employees.map((e) => e.id), toDateColumn(window.from), toDateColumn(window.to))

  const daysOf = new Map<string, number>()
  for (const r of requests) {
    const days = leaveDaysWithin({ from: fromDateColumn(r.fromDate), to: fromDateColumn(r.toDate), halfDays: r.halfDayDates as CalendarDate[] }, window, calendar)
    const key = `${r.employeeId}:${r.leaveTypeId}`
    daysOf.set(key, (daysOf.get(key) ?? 0) + days)
  }

  const unpaid = new Set(types.filter((t) => !t.isPaid).map((t) => t.id))
  const rows: ReportRow[] = employees.map((e) => {
    const row: ReportRow = { employee_code: e.employeeCode, full_name: e.fullName, department: e.department?.name ?? null }
    let total = 0
    let unpaidDays = 0
    for (const t of types) {
      const d = daysOf.get(`${e.id}:${t.id}`) ?? 0
      row[`type_${t.code}`] = d
      total += d
      if (unpaid.has(t.id)) unpaidDays += d
    }
    row.total = total
    row.unpaid = unpaidDays
    return row
  })

  const typeColumns: ReportColumn[] = typesShown(types, rows).map((t) => ({ key: `type_${t.code}`, label: t.archivedAt ? `${t.name} (archived)` : t.name, type: 'days' }))
  const totals: ReportRow = { employee_code: null, full_name: `Total (${rows.length})`, department: null, total: sum(rows, 'total'), unpaid: sum(rows, 'unpaid') }
  for (const c of typeColumns) totals[c.key] = sum(rows, c.key)

  return {
    period: monthName(p.year, p.month),
    columns: [
      { key: 'employee_code', label: 'Code', type: 'text' },
      { key: 'full_name', label: 'Employee', type: 'text' },
      { key: 'department', label: 'Department', type: 'text' },
      ...typeColumns,
      { key: 'total', label: 'Total', type: 'days' },
      { key: 'unpaid', label: 'Of which unpaid', type: 'days' },
    ],
    rows,
    totals: rows.length ? totals : null,
    notes: ['Approved leave only, counted for the days inside this month — weekly offs and holidays are not counted, half days count as half.', ...leftOutNote(leftOut)],
    chart: null,
  }
}

async function leaveBalances(ctx: AppContext, p: ReportParams): Promise<Omit<ReportResult, 'id' | 'title'>> {
  const window = monthWindow(p.year, p.month)
  const startMonth = await repo.leaveYearStartMonth(ctx.db)
  const leaveYear = leaveYearOf(window.from, startMonth)
  const [{ people, leftOut }, types] = await Promise.all([peopleIn(ctx, window, p), repo.leaveTypes(ctx.db)])
  const employees = people.map((x) => x.employee)
  const { ledger, pending } = await repo.leaveBalances(ctx.db, employees.map((e) => e.id), leaveYear)

  const balanceOf = new Map(ledger.map((l) => [`${l.employeeId}:${l.leaveTypeId}`, Number(l._sum.days ?? 0)]))
  const pendingOf = new Map(pending.map((q) => [q.employeeId, Number(q._sum.days ?? 0)]))

  const rows: ReportRow[] = employees.map((e) => {
    const row: ReportRow = { employee_code: e.employeeCode, full_name: e.fullName, department: e.department?.name ?? null }
    for (const t of types) row[`type_${t.code}`] = round2(balanceOf.get(`${e.id}:${t.id}`) ?? 0)
    row.pending = round2(pendingOf.get(e.id) ?? 0)
    return row
  })

  const startLabel = monthName(startMonth <= p.month ? p.year : p.year - 1, startMonth).split(' ')[0]
  return {
    period: `Leave year ${leaveYear}${startMonth === 1 ? '' : `-${String((leaveYear + 1) % 100).padStart(2, '0')}`} (from ${startLabel})`,
    columns: [
      { key: 'employee_code', label: 'Code', type: 'text' },
      { key: 'full_name', label: 'Employee', type: 'text' },
      { key: 'department', label: 'Department', type: 'text' },
      ...typesShown(types, rows).map((t): ReportColumn => ({ key: `type_${t.code}`, label: t.archivedAt ? `${t.name} (archived)` : t.name, type: 'days' })),
      { key: 'pending', label: 'Waiting for approval', type: 'days' },
    ],
    rows,
    totals: null,
    notes: [
      'Balances are what the leave ledger holds: what was granted, carried forward, taken and given back. Nothing is assumed for somebody with no entries.',
      'Days waiting for approval are not yet taken off.',
      ...leftOutNote(leftOut),
    ],
    chart: null,
  }
}

// ── Payroll ─────────────────────────────────────────────────────────────────

async function payrollNotes(ctx: AppContext, p: ReportParams) {
  const run = await repo.runForMonth(ctx.db, p.year, p.month)
  if (!run) return { run: null, notes: [`No payroll has been run for ${monthName(p.year, p.month)}.`] }
  const status =
    run.status === 'paid'
      ? `Paid on ${run.paidOn ? dayLabel(fromDateColumn(run.paidOn)) : 'record'}.`
      : run.status === 'approved'
        ? 'Approved, not yet paid.'
        : 'Still a draft: these are working figures and may change before approval.'
  return { run, notes: [status] }
}

/** The filters as payslips take them: the department by the name copied onto each payslip. */
async function payslipFilters(ctx: AppContext, p: ReportParams) {
  return { ...p, departmentName: p.departmentId ? await repo.departmentName(ctx.db, p.departmentId) : null }
}

async function payrollSummary(ctx: AppContext, p: ReportParams): Promise<Omit<ReportResult, 'id' | 'title'>> {
  const [{ run, notes }, filters] = await Promise.all([payrollNotes(ctx, p), payslipFilters(ctx, p)])
  const slips = run ? await repo.payslipsOfRun(ctx.db, run.id, filters) : []
  const rows: ReportRow[] = slips.map((s) => ({
    employee_code: s.employeeCode,
    full_name: s.employeeName,
    department: s.department,
    paid_days: Number(s.paidDays),
    lop_days: Number(s.lopDays),
    gross: Number(s.grossEarnings),
    pf: Number(s.employeePf),
    esi: Number(s.employeeEsi),
    pt: Number(s.professionalTax),
    tds: Number(s.tds),
    other: Number(s.otherDeductions),
    deductions: Number(s.totalDeductions),
    net: Number(s.netPayable),
  }))

  // Six months of net pay ending with this one; a month without a run has none.
  const months: { year: number; month: number }[] = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(p.year, p.month - 1 - i, 1))
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 })
  }
  // Unfiltered, each month is its run's own total. Filtered, it is the same
  // payslips the table shows — the same filters — summed in Postgres.
  const filtered = Boolean(p.departmentId || p.employeeId)
  const runs = await repo.runsFor(ctx.db, months)
  const netOfRun = filtered
    ? new Map((await repo.netByRun(ctx.db, runs.map((r) => r.id), filters)).map((s) => [s.payrollRunId, Number(s._sum.netPayable ?? 0)]))
    : new Map(runs.map((r) => [r.id, Number(r.netPayable)]))
  const runOf = new Map(runs.map((r) => [monthKey(r.year, r.month), r]))

  const totals: ReportRow = { employee_code: null, full_name: `Total (${rows.length})`, department: null }
  for (const key of ['paid_days', 'lop_days', 'gross', 'pf', 'esi', 'pt', 'tds', 'other', 'deductions', 'net']) totals[key] = sum(rows, key)

  return {
    period: monthName(p.year, p.month),
    columns: [
      { key: 'employee_code', label: 'Code', type: 'text' },
      { key: 'full_name', label: 'Employee', type: 'text' },
      { key: 'department', label: 'Department', type: 'text' },
      { key: 'paid_days', label: 'Paid days', type: 'days' },
      { key: 'lop_days', label: 'Loss of pay', type: 'days' },
      { key: 'gross', label: 'Gross', type: 'money' },
      { key: 'pf', label: 'PF', type: 'money' },
      { key: 'esi', label: 'ESI', type: 'money' },
      { key: 'pt', label: 'PT', type: 'money' },
      { key: 'tds', label: 'TDS', type: 'money' },
      { key: 'other', label: 'Other', type: 'money' },
      { key: 'deductions', label: 'Deductions', type: 'money' },
      { key: 'net', label: 'Net pay', type: 'money' },
    ],
    rows,
    totals: rows.length ? totals : null,
    notes,
    chart: {
      kind: 'bar',
      label: filtered ? 'Net pay by month — for these filters' : 'Net pay by month',
      points: months.map((m) => {
        const r = runOf.get(monthKey(m.year, m.month))
        const short = monthName(m.year, m.month).slice(0, 3)
        // A draft's figures may still change; the bar says so.
        return { label: r?.status === 'draft' ? `${short} (draft)` : short, value: r && netOfRun.has(r.id) ? round2(netOfRun.get(r.id)!) : null }
      }),
    },
  }
}

async function pfEsi(ctx: AppContext, p: ReportParams): Promise<Omit<ReportResult, 'id' | 'title'>> {
  const [{ run, notes }, filters] = await Promise.all([payrollNotes(ctx, p), payslipFilters(ctx, p)])
  const slips = run ? await repo.payslipsOfRun(ctx.db, run.id, filters) : []
  const rows: ReportRow[] = slips.map((s) => ({
    employee_code: s.employeeCode,
    full_name: s.employeeName,
    uan: s.uan,
    pf_wages: Number(s.pfWages),
    employee_pf: Number(s.employeePf),
    employer_eps: Number(s.employerEps),
    employer_epf: Number(s.employerEpf),
    employee_esi: Number(s.employeeEsi),
    employer_esi: Number(s.employerEsi),
  }))
  const totals: ReportRow = { employee_code: null, full_name: `Total (${rows.length})`, uan: null }
  for (const key of ['pf_wages', 'employee_pf', 'employer_eps', 'employer_epf', 'employee_esi', 'employer_esi']) totals[key] = sum(rows, key)
  return {
    period: monthName(p.year, p.month),
    columns: [
      { key: 'employee_code', label: 'Code', type: 'text' },
      { key: 'full_name', label: 'Employee', type: 'text' },
      { key: 'uan', label: 'UAN', type: 'text' },
      { key: 'pf_wages', label: 'PF wages', type: 'money' },
      { key: 'employee_pf', label: 'Employee PF', type: 'money' },
      { key: 'employer_eps', label: 'Employer EPS', type: 'money' },
      { key: 'employer_epf', label: 'Employer EPF', type: 'money' },
      { key: 'employee_esi', label: 'Employee ESI', type: 'money' },
      { key: 'employer_esi', label: 'Employer ESI', type: 'money' },
    ],
    rows,
    totals: rows.length ? totals : null,
    notes: [...notes, 'UAN is copied onto the payslip when the payroll is approved; a draft shows none.'],
    chart: null,
  }
}

// ── People ──────────────────────────────────────────────────────────────────

async function headcount(ctx: AppContext, p: ReportParams): Promise<Omit<ReportResult, 'id' | 'title'>> {
  const window = monthWindow(p.year, p.month)
  const today = await companyToday(ctx)
  const asOf = window.to < today ? window.to : today
  const { people, leftOut } = await peopleIn(ctx, { from: asOf, to: asOf }, p)
  const employees = people.map((x) => x.employee)

  const byDept = new Map<string, ReportRow>()
  for (const e of employees) {
    const name = e.department?.name ?? 'No department'
    const agg = byDept.get(name) ?? { department: name, total: 0, full_time: 0, part_time: 0, contract: 0, intern: 0 }
    agg.total = (agg.total as number) + 1
    agg[e.employmentType] = ((agg[e.employmentType] as number) ?? 0) + 1
    byDept.set(name, agg)
  }
  const rows = [...byDept.values()].sort((a, b) => String(a.department).localeCompare(String(b.department)))
  const totals: ReportRow = { department: 'Total' }
  for (const key of ['total', 'full_time', 'part_time', 'contract', 'intern']) totals[key] = sum(rows, key)

  return {
    period: `As of ${dayLabel(asOf)}`,
    columns: [
      { key: 'department', label: 'Department', type: 'text' },
      { key: 'total', label: 'Employees', type: 'number' },
      { key: 'full_time', label: 'Full time', type: 'number' },
      { key: 'part_time', label: 'Part time', type: 'number' },
      { key: 'contract', label: 'Contract', type: 'number' },
      { key: 'intern', label: 'Intern', type: 'number' },
    ],
    rows,
    totals: rows.length ? totals : null,
    notes: ['Everybody employed on that day: joined on or before it, and not yet left.', ...leftOutNote(leftOut)],
    chart: { kind: 'pie', label: 'Employees by department', points: rows.map((r) => ({ label: String(r.department), value: r.total as number })) },
  }
}

async function joinersExits(ctx: AppContext, p: ReportParams): Promise<Omit<ReportResult, 'id' | 'title'>> {
  const window = monthWindow(p.year, p.month)
  const [found, timezone] = await Promise.all([
    repo.movements(ctx.db, toDateColumn(window.from), toDateColumn(window.to), p),
    companyTimezone(ctx),
  ])
  const joined = found.joined
  // Left in the window by the day their employment ended — recorded, or the day they were let go.
  const left = found.left
    .map((e) => ({ e, day: lastDayOf(e, timezone) }))
    .filter((x): x is { e: (typeof found.left)[number]; day: CalendarDate } => x.day !== null && x.day >= window.from && x.day <= window.to)
    .sort((a, b) => a.day.localeCompare(b.day))
  const unrecorded = left.filter((x) => !x.e.lastWorkingDate).length
  const rows: ReportRow[] = [
    ...joined.map((e) => ({
      employee_code: e.employeeCode,
      full_name: e.fullName,
      department: e.department?.name ?? null,
      designation: e.designation?.name ?? null,
      movement: 'Joined',
      date: e.dateOfJoining ? fromDateColumn(e.dateOfJoining) : null,
    })),
    ...left.map(({ e, day }) => ({
      employee_code: e.employeeCode,
      full_name: e.fullName,
      department: e.department?.name ?? null,
      designation: e.designation?.name ?? null,
      movement: e.lastWorkingDate ? 'Left' : 'Left — access removed',
      // The last working day as recorded — the old report printed "Inactive".
      date: day,
    })),
  ]
  return {
    period: monthName(p.year, p.month),
    columns: [
      { key: 'employee_code', label: 'Code', type: 'text' },
      { key: 'full_name', label: 'Employee', type: 'text' },
      { key: 'department', label: 'Department', type: 'text' },
      { key: 'designation', label: 'Designation', type: 'text' },
      { key: 'movement', label: 'Joined / left', type: 'text' },
      { key: 'date', label: 'Date', type: 'date' },
    ],
    rows,
    totals: { employee_code: null, full_name: `Joined ${joined.length} · left ${left.length} · net ${joined.length - left.length >= 0 ? '+' : ''}${joined.length - left.length}`, department: null, designation: null, movement: null, date: null },
    notes: [
      'Leaving is the last working day recorded on the employee.',
      ...(unrecorded > 0 ? [`${unrecorded === 1 ? 'One person' : `${unrecorded} people`} left with no last working day recorded; the date shown is the day their access was removed.`] : []),
    ],
    chart: null,
  }
}

const BUILDERS: Record<ReportId, (ctx: AppContext, p: ReportParams) => Promise<Omit<ReportResult, 'id' | 'title'>>> = {
  'attendance-summary': attendanceSummary,
  'attendance-by-department': attendanceByDepartment,
  'leave-taken': leaveTaken,
  'leave-balances': leaveBalances,
  'payroll-summary': payrollSummary,
  'pf-esi': pfEsi,
  headcount,
  'joiners-exits': joinersExits,
}

export function isReportId(value: string): value is ReportId {
  return (REPORT_IDS as readonly string[]).includes(value)
}

export async function runReport(ctx: AppContext, id: ReportId, params: ReportParams): Promise<ReportResult> {
  if (params.month < 1 || params.month > 12) throw BadRequest('Month must be between 1 and 12')
  const built = await BUILDERS[id](ctx, params)
  return { id, title: REPORT_TITLES[id], ...built }
}
