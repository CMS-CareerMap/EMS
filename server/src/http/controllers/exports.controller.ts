import type { RequestHandler } from 'express'
import { z } from 'zod'
import { listEmployees } from '../../modules/employee/employee.service'
import { dayRoster } from '../../modules/attendance/attendanceAdmin.service'
import { companyTimezone, companyToday } from '../../modules/organization/organization.service'
import { recordSecurityEvent } from '../../modules/audit/audit.service'
import { toCsv, type CsvCell } from '../../domain/shared/csv'
import { zonedMinutes } from '../../domain/shared/dates'
import { LIFECYCLE_STAGES, type LifecycleStage } from '../../domain/org/lifecycle'
import { serializeEmployees } from '../serializers/employee.serializer'
import { employeeQuerySchema } from '../validators/employee.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { sendFile } from '../download'

/**
 * Every CSV the app hands out goes through domain/shared/csv.ts — one writer,
 * with the BOM Excel needs for ₹ and Hindi names, CRLF line endings, quoting
 * that survives a comma or a quote in a name, and a guard that stops a cell
 * beginning "=" from running as a formula. The six exporters this replaces
 * each had their own, and all six had the same bugs (audit §6.7).
 *
 * The rows are the same ones the page shows — the same filters, the same
 * field access (a salary column only for those who may see salaries) — and
 * every export is recorded.
 */

const CSV = 'text/csv; charset=utf-8'
const csvBytes = (rows: CsvCell[][]) => Buffer.from(toCsv(rows), 'utf8')

const EMPLOYMENT: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', intern: 'Intern' }
const STATUS: Record<string, string> = {
  present: 'Present',
  half_day: 'Half day',
  absent: 'Absent',
  on_leave: 'On leave',
  holiday: 'Holiday',
  weekly_off: 'Weekly off',
}
/** Where somebody worked from (client §33) — blank for a day marked by hand. */
const WORK_MODE: Record<string, string> = { office: 'Office', wfh: 'Work from home', on_duty: 'On duty', remote: 'Remote' }

/** Where somebody stands in the lifecycle (client §43), as the list's Stage column says it. */
const STAGE: Record<LifecycleStage, string> = {
  joining_soon: 'Joining soon',
  onboarding: 'Onboarding',
  probation: 'On probation',
  confirmed: 'Confirmed',
  resigned: 'Resigned',
  notice_period: 'Serving notice',
  exit_due: 'Exit due',
  left: 'Left',
}

/** The list's filters, and the Stage filter the page applies to them. */
const employeeExportSchema = employeeQuerySchema.extend({ stage: z.enum(LIFECYCLE_STAGES as [LifecycleStage, ...LifecycleStage[]]).optional() })

/** GET /api/employees/export?search=&departmentId=&status=&stage= */
export const getEmployeesExport: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const query = parseBody(employeeExportSchema, req.query)
  const { rows: found, access } = await listEmployees(ctx, query)
  // The list's search also matches a personal email; the page's matches only
  // the name and the code, and the file is the page's rows.
  const needle = query.search?.toLowerCase()
  const rows = needle
    ? found.filter((e) => e.fullName.toLowerCase().includes(needle) || e.employeeCode.toLowerCase().includes(needle))
    : found
  const employees = (serializeEmployees(rows, access) as Array<Record<string, unknown>>)
    .filter((e) => !query.stage || e.lifecycle_stage === query.stage)
  const withPay = access.includeCompensation

  const header: CsvCell[] = ['Full Name', 'Employee Code', 'Department', 'Designation', 'Phone', 'Employment Type', 'Date of Joining', 'Last Working Day', 'Stage', 'Status']
  if (withPay) header.push('CTC')

  const body = employees.map((e) => {
    const line: CsvCell[] = [
      e.full_name as CsvCell,
      e.employee_id as CsvCell,
      e.department as CsvCell,
      e.designation as CsvCell,
      e.phone as CsvCell,
      EMPLOYMENT[String(e.employment_type)] ?? (e.employment_type as CsvCell),
      e.date_of_joining as CsvCell,
      e.last_working_date as CsvCell,
      STAGE[e.lifecycle_stage as LifecycleStage] ?? (e.lifecycle_stage as CsvCell),
      e.status as CsvCell,
    ]
    // Blank when not recorded — never 0, which would read as a salary of nothing.
    // Left out by the salary scope (Day 21) says so, rather than looking unrecorded.
    if (withPay) line.push(Object.hasOwn(e, 'ctc') ? ((e.ctc as CsvCell) ?? null) : 'Not shown to you')
    return line
  })

  await recordSecurityEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    requestId: ctx.requestId,
    action: 'employee.exported',
    entityType: 'employee',
    details: { rows: body.length, withCompensation: withPay, filters: query },
  })

  sendFile(res, { filename: `employees-${await companyToday(ctx)}.csv`, bytes: csvBytes([header, ...body]), contentType: CSV })
}

/** GET /api/employees/import/template — the columns the importer reads, with one example row. */
export const getEmployeeImportTemplate: RequestHandler = async (_req, res) => {
  sendFile(res, {
    filename: 'employee-import-template.csv',
    bytes: csvBytes([
      // confirmed_on: for somebody already working here — left empty, a new joiner.
      ['employee_code', 'full_name', 'email', 'personal_email', 'phone', 'date_of_joining', 'employment_type', 'department', 'designation', 'shift', 'pan', 'gender', 'confirmed_on'],
      ['CMS-1001', 'Priya Sharma', 'priya@company.in', null, '9876543210', '01/10/2026', 'full_time', 'Sales', 'Executive', 'General', null, 'female', null],
      ['CMS-0412', 'Ravi Patil', 'ravi@company.in', null, '9876500000', '06/01/2025', 'full_time', 'Sales', 'Executive', 'General', null, 'male', '06/07/2025'],
    ]),
    contentType: CSV,
  })
}

function wallClock(instant: Date | null, timezone: string): string | null {
  if (!instant) return null
  const minutes = zonedMinutes(instant, timezone)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** The Attendance page's own filters, so the file is the rows on the screen. */
const attendanceExportSchema = z
  .object({
    date: z.iso.date().optional(),
    status: z.enum(['all', 'unmarked', 'present', 'half_day', 'absent', 'on_leave', 'holiday', 'weekly_off']).default('all'),
    department: z.string().trim().max(100).optional(),
    search: z.string().trim().max(100).optional(),
  })
  .strict()

/** GET /api/attendance/export?date=&status=&department=&search= — one day's roster, as the page shows it. */
export const getAttendanceExport: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const q = parseBody(attendanceExportSchema, req.query)
  const [full, timezone] = await Promise.all([dayRoster(ctx, q.date), companyTimezone(ctx)])
  const search = q.search?.toLowerCase()
  const roster = {
    date: full.date,
    employees: full.employees.filter((e) => {
      const status = e.attendance[0]?.status ?? null
      if (q.status === 'unmarked' ? status !== null : q.status !== 'all' && status !== q.status) return false
      if (q.department && (e.department?.name ?? '') !== q.department) return false
      if (search && !e.fullName.toLowerCase().includes(search) && !e.employeeCode.toLowerCase().includes(search)) return false
      return true
    }),
  }

  const header: CsvCell[] = ['Employee Name', 'Employee Code', 'Department', 'Designation', 'Status', 'Check In', 'Check Out', 'Hours Worked', 'Work Mode', 'Note']
  const body = roster.employees.map((e) => {
    const day = e.attendance[0]
    return [
      e.fullName,
      e.employeeCode,
      e.department?.name ?? null,
      e.designation?.name ?? null,
      day ? (STATUS[day.status] ?? day.status) : 'Not marked',
      day ? wallClock(day.checkIn, timezone) : null,
      day ? wallClock(day.checkOut, timezone) : null,
      day?.hoursWorked != null ? Number(day.hoursWorked) : null,
      day?.workMode ? WORK_MODE[day.workMode] : null,
      day?.note ?? null,
    ] satisfies CsvCell[]
  })

  await recordSecurityEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    requestId: ctx.requestId,
    action: 'attendance.exported',
    entityType: 'attendance',
    details: { date: roster.date, rows: body.length, filters: { status: q.status, department: q.department ?? null, search: q.search ?? null } },
  })

  sendFile(res, { filename: `attendance-${roster.date}.csv`, bytes: csvBytes([header, ...body]), contentType: CSV })
}
