import type { RequestHandler } from 'express'
import type { Prisma } from '@prisma/client'
import {
  listAttendance,
  monthlySummary,
  todaySummary,
  markAttendance,
  amendAttendance,
  dayRoster,
} from '../../modules/attendance/attendanceAdmin.service'
import { importAttendance } from '../../modules/attendance/attendanceImport.service'
import {
  attendanceQuerySchema,
  monthQuerySchema,
  daySummaryQuerySchema,
  markAttendanceSchema,
  amendAttendanceSchema,
  attendanceIdSchema,
  attendanceImportSchema,
} from '../validators/attendance.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import type { AttendanceRow } from '../../modules/attendance/attendance.repository'
import { fromDateColumn, isoInstant } from '../../domain/shared/dates'

/** Snake_case out, matching the names the Attendance page already reads. */
/** The day itself, without who it belongs to. Shared by the list and the roster. */
function dayFields(record: Omit<AttendanceRow, 'employee'>) {
  const num = (value: Prisma.Decimal | null) => (value == null ? null : Number(value))

  return {
    id: record.id,
    date: fromDateColumn(record.date),

    check_in: isoInstant(record.checkIn),
    check_out: isoInstant(record.checkOut),
    status: record.status,
    source: record.source,

    hours_worked: num(record.hoursWorked),
    expected_hours: num(record.expectedHours),

    // Evidence, sent so a dispute can be settled without a database query.
    geofence_verified: record.geofenceVerified,
    distance_meters: record.checkInDistanceMeters,
    accuracy_meters: record.checkInAccuracyMeters,

    note: record.note,
  }
}

function row(record: AttendanceRow) {
  return {
    ...dayFields(record),
    // employee_id is the UUID, matching what attendance.employee_id meant in
    // the original backend. The human-readable code is employee_code.
    // Confusing, and not ours to rename in the same commit that moves the data.
    employee_id: record.employeeId,
    employee_code: record.employee.employeeCode,
    full_name: record.employee.fullName,
    department: record.employee.department?.name ?? null,
    designation: record.employee.designation?.name ?? null,
    attendance_mode: record.employee.attendanceMode,
  }
}

/**
 * GET /api/attendance/day?date=
 *
 * The roster for one day: every employee the caller may see who was employed
 * that day, each with their row — or `attendance: null`, which means NOT
 * MARKED. Not absent: nobody has said anything about that person yet, and the
 * page must be able to tell the two apart.
 */
export const getDayRoster: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { date } = parseBody(daySummaryQuerySchema, req.query)

  const roster = await dayRoster(ctx, date)

  res.status(200).json({
    data: {
      date: roster.date,
      employees: roster.employees.map((employee) => ({
        employee_id: employee.id,
        employee_code: employee.employeeCode,
        full_name: employee.fullName,
        department: employee.department?.name ?? null,
        designation: employee.designation?.name ?? null,
        attendance_mode: employee.attendanceMode,
        attendance: employee.attendance[0] ? dayFields(employee.attendance[0]) : null,
        // Null when the caller may mark this day; otherwise whom it goes to (Day 22).
        mark_goes_to: roster.markGoesTo.get(employee.id) ?? null,
      })),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** GET /api/attendance */
export const getAttendance: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const query = parseBody(attendanceQuerySchema, req.query)

  const rows = await listAttendance(ctx, query)

  res.status(200).json({
    data: rows.map(row),
    meta: { requestId: res.locals.requestId, total: rows.length },
  })
}

/**
 * GET /api/attendance/monthly-summary
 *
 * The hours report the client asked for by name. Aggregated in Postgres, so the
 * total describes every row in the month rather than the ones a page loaded.
 */
export const getMonthlySummary: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { year, month, employeeId } = parseBody(monthQuerySchema, req.query)

  const result = await monthlySummary(ctx, year, month, employeeId)

  res.status(200).json({
    data: {
      year: result.year,
      month: result.month,
      grand_total_hours: result.grandTotalHours,
      employees: result.employees.map((e) => ({
        employee_uuid: e.employeeId,
        employee_id: e.employeeCode,
        full_name: e.fullName,
        total_hours: e.totalHours,
        expected_hours: e.expectedHours,
        days_present: e.daysPresent,
        days_half: e.daysHalf,
        days_absent: e.daysAbsent,
        days_on_leave: e.daysOnLeave,
      })),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/**
 * GET /api/attendance/summary
 *
 * One day's figures for the dashboard. `not_marked` is sent separately from
 * `absent` on purpose: the old dashboard conflated them and reported the whole
 * company absent every morning until somebody started marking.
 */
export const getDaySummary: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { date } = parseBody(daySummaryQuerySchema, req.query)

  const summary = await todaySummary(ctx, date)

  res.status(200).json({
    data: {
      date: summary.date,
      present: summary.present,
      absent: summary.absent,
      half_day: summary.halfDay,
      on_leave: summary.onLeave,
      not_marked: summary.notMarked,
      total_employees: summary.totalEmployees,
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** POST /api/attendance/mark */
export const postMark: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(markAttendanceSchema, req.body)

  const saved = await markAttendance(ctx, input)

  res.status(201).json({ data: row(saved), meta: { requestId: res.locals.requestId } })
}

/** PATCH /api/attendance/:id — regularisation. */
export const patchAttendance: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(attendanceIdSchema, req.params)
  const input = parseBody(amendAttendanceSchema, req.body)

  const saved = await amendAttendance(ctx, id, input)

  res.status(200).json({ data: row(saved), meta: { requestId: res.locals.requestId } })
}

/**
 * POST /api/attendance/import
 *
 * Preview by default. `would_overwrite` is in the summary because replacing a
 * day HR already corrected by hand is the thing somebody wants to know BEFORE
 * pressing import.
 */
export const postImport: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { csv, dryRun } = parseBody(attendanceImportSchema, req.body)

  const result = await importAttendance(ctx, { csv, dryRun })

  res.status(dryRun ? 200 : 201).json({
    data: {
      dry_run: result.dryRun,
      summary: {
        total_rows: result.summary.totalRows,
        valid: result.summary.valid,
        invalid: result.summary.invalid,
        would_overwrite: result.summary.wouldOverwrite,
        imported: result.summary.imported,
      },
      rows: result.rows.map((r) => ({
        line: r.line,
        employee_id: r.employeeCode,
        date: r.date,
        check_in: r.checkIn,
        check_out: r.checkOut,
        hours: r.hours,
        issues: r.issues,
      })),
    },
    meta: { requestId: res.locals.requestId },
  })
}
