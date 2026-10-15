import type { RequestHandler } from 'express'
import type { Prisma } from '@prisma/client'
import {
  listAttendance,
  monthCalendar,
  monthlySummary,
  todaySummary,
  markAttendance,
  amendAttendance,
  dayRoster,
} from '../../modules/attendance/attendanceAdmin.service'
import { importAttendance } from '../../modules/attendance/attendanceImport.service'
import { dayEvidence, suspiciousPunches } from '../../modules/attendance/suspicious.service'
import { readPunchPhoto } from '../../modules/attendance/punchPhotos.service'
import { approveDevice, listDevices, retireDevice, type DeviceRow } from '../../modules/attendance/punchDevices.service'
import { personMonth } from '../../modules/attendance/personMonth.service'
import { payDaysPayload } from '../serializers/payDays.serializer'
import { sendFile } from '../download'
import {
  attendanceQuerySchema,
  monthQuerySchema,
  daySummaryQuerySchema,
  markAttendanceSchema,
  amendAttendanceSchema,
  attendanceIdSchema,
  attendanceImportSchema,
  suspiciousQuerySchema,
  dayEvidenceQuerySchema,
  devicesQuerySchema,
  personMonthParamsSchema,
  personMonthQuerySchema,
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
    // Where it was worked from (client §33), and the device that checked in (§31).
    work_mode: record.workMode,
    check_in_device: record.checkInDevice,
    late_minutes: record.lateMinutes,
    early_leaving_minutes: record.earlyLeavingMinutes,
    overtime_minutes: record.overtimeMinutes,
    // The fingerprint machine's word on an app day (client, 11 Oct 2026): null until its file is imported.
    machine_match: record.machineMatch,
    machine_first_scan: isoInstant(record.machineFirstScan),
    machine_last_scan: isoInstant(record.machineLastScan),

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
      // The server's clock, so the time at work runs right on a computer whose own is out.
      server_now: isoInstant(roster.now),
      employees: roster.employees.map((employee) => ({
        employee_id: employee.id,
        employee_code: employee.employeeCode,
        full_name: employee.fullName,
        department: employee.department?.name ?? null,
        designation: employee.designation?.name ?? null,
        attendance_mode: employee.attendanceMode,
        attendance: employee.attendance[0] ? dayFields(employee.attendance[0]) : null,
        // Checked in and still at work now, by the rule their own card counts by:
        // the roster runs their time from check-in (client, 9 Oct 2026).
        at_work: roster.atWork.has(employee.id),
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
 * GET /api/attendance/people/:employeeId/month?year=&month= — one person's
 * month (client, 15 Oct 2026): who they are, their days, the company's days
 * off, the month in pay terms, and the month so far, counted to today. For
 * the page a name on Attendance opens, and for the person's own figures.
 */
export const getPersonMonth: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { employeeId } = parseBody(personMonthParamsSchema, req.params)
  const { year, month } = parseBody(personMonthQuerySchema, req.query)
  const m = await personMonth(ctx, employeeId, year, month)
  const t = m.totals
  res.status(200).json({
    data: {
      person: {
        id: m.person.id,
        full_name: m.person.fullName,
        employee_code: m.person.employeeCode,
        department: m.person.department?.name ?? null,
        designation: m.person.designation?.name ?? null,
        date_of_joining: fromDateColumn(m.person.dateOfJoining),
        last_working_date: fromDateColumn(m.person.lastWorkingDate),
        // The last day they are counted: the last working day, or the day they were removed.
        employed_until: m.employedUntil,
        left: m.person.archivedAt !== null,
        attendance_mode: m.person.attendanceMode,
        shift: m.person.shift
          ? { name: m.person.shift.name, start_time: m.person.shift.startTime, end_time: m.person.shift.endTime }
          : null,
      },
      year: m.year,
      month: m.month,
      today: m.today,
      totals: {
        from: t.from,
        to: t.to,
        ongoing: t.ongoing,
        working_days: t.workingDays,
        present: t.present,
        half_days: t.halfDays,
        absent: t.absent,
        on_leave: t.onLeave,
        not_marked: t.notMarked,
        weekly_offs: t.weeklyOffs,
        holidays: t.holidays,
        hours_worked: t.hoursWorked,
        expected_hours: t.expectedHours,
        days_worked: t.daysWorked,
        average_hours: t.averageHours,
        arrivals: t.arrivals,
        late_days: t.lateDays,
        // Still at work today: the page counts the time since, by the server's clock (meta.server_now).
        open_since: isoInstant(m.openSince),
        open_day: m.openDay,
      },
      days: m.days.map(row),
      weekly_off_days: m.calendar.weeklyOffDays,
      days_off: m.calendar.daysOff,
      pay_days: payDaysPayload(m.payDays),
    },
    meta: { requestId: res.locals.requestId, server_now: isoInstant(new Date()) },
  })
}

/**
 * GET /api/attendance/calendar?year=&month=
 *
 * The company's days off in a month — holidays by name, and weekly offs — for
 * the attendance calendar, which has no rows on those days to draw from.
 */
export const getMonthCalendar: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { year, month } = parseBody(monthQuerySchema, req.query)

  const calendar = await monthCalendar(ctx, year, month)

  res.status(200).json({
    data: {
      year: calendar.year,
      month: calendar.month,
      weekly_off_days: calendar.weeklyOffDays,
      days_off: calendar.daysOff,
    },
    meta: { requestId: res.locals.requestId },
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
        on_leave: result.summary.onLeave,
        edge_nights_left_out: result.summary.edgeNightsLeftOut,
        imported: result.summary.imported,
        // What the machine's file said of the app's days (client, 11 Oct 2026); null with the layer off.
        machine: result.summary.machine
          ? {
              from: result.summary.machine.from,
              to: result.summary.machine.to,
              confirmed: result.summary.machine.confirmed,
              time_differs: result.summary.machine.timeDiffers,
              not_on_machine: result.summary.machine.notOnMachine,
              from_machine: result.summary.machine.fromMachine,
              not_filled: result.summary.machine.notFilled,
              made_absent: result.summary.machine.madeAbsent,
              missing: result.summary.machine.missing.map((m) => ({ employee_code: m.employeeCode, full_name: m.fullName, date: m.date })),
              not_in_file: result.summary.machine.notInFile.map((m) => ({ employee_code: m.employeeCode, full_name: m.fullName, days: m.days })),
            }
          : null,
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

/**
 * GET /api/attendance/suspicious?from=&to= — punches worth a second look
 * (client, 11 Oct 2026), by person and day, for whoever looks after other
 * people's attendance; the last week unless the days are given.
 */
export const getSuspicious: RequestHandler = async (req, res) => {
  const { from, to } = parseBody(suspiciousQuerySchema, req.query)
  const result = await suspiciousPunches(appContext(res), { from, to })
  res.status(200).json({
    data: {
      from: result.from,
      to: result.to,
      days: result.days.map((d) => ({
        employee_id: d.employeeId,
        full_name: d.fullName,
        employee_code: d.employeeCode,
        date: d.date,
        punches: d.punches.map((p) => ({
          id: p.id,
          action: p.action,
          at: isoInstant(p.at),
          refused_for: p.refusedFor,
          flags: p.flags,
          work_mode: p.workMode,
          fence_applied: p.fenceApplied,
          // Where it was taken — for a location kept but not fenced, the map is the evidence (14 Oct 2026).
          latitude: p.latitude == null ? null : Number(p.latitude),
          longitude: p.longitude == null ? null : Number(p.longitude),
          distance_meters: p.distanceMeters,
          accuracy_meters: p.accuracyMeters,
          readings: Array.isArray(p.readings) ? p.readings.length : 0,
          ip: p.ip,
          device: p.userAgent,
        })),
        machine: d.machine
          ? {
              match: d.machine.machineMatch,
              status: d.machine.status,
              check_in: isoInstant(d.machine.checkIn),
              check_out: isoInstant(d.machine.checkOut),
              first_scan: isoInstant(d.machine.machineFirstScan),
              last_scan: isoInstant(d.machine.machineLastScan),
            }
          : null,
      })),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** One punch's evidence, for the roster's "Evidence" and the phones list's context. */
function punchEvidencePayload(p: Awaited<ReturnType<typeof dayEvidence>>[number]) {
  return {
    id: p.id,
    action: p.action,
    at: isoInstant(p.at),
    started_at: isoInstant(p.startedAt),
    refused_for: p.refusedFor,
    flags: p.flags,
    work_mode: p.workMode,
    fence_applied: p.fenceApplied,
    latitude: p.latitude == null ? null : Number(p.latitude),
    longitude: p.longitude == null ? null : Number(p.longitude),
    distance_meters: p.distanceMeters,
    accuracy_meters: p.accuracyMeters,
    readings: Array.isArray(p.readings) ? p.readings.length : 0,
    ip: p.ip,
    device: p.userAgent,
    has_photo: p.photoKey !== null,
  }
}

/** GET /api/attendance/evidence?employeeId=&date= — one person's punches that day (client, 11 Oct 2026). */
export const getDayEvidence: RequestHandler = async (req, res) => {
  const { employeeId, date } = parseBody(dayEvidenceQuerySchema, req.query)
  const rows = await dayEvidence(appContext(res), employeeId, date)
  res.status(200).json({ data: rows.map(punchEvidencePayload), meta: { requestId: res.locals.requestId } })
}

/** GET /api/attendance/evidence/:id/photo — a punch's selfie, while it is kept. */
export const getPunchPhoto: RequestHandler = async (req, res) => {
  const { id } = parseBody(attendanceIdSchema, req.params)
  const photo = await readPunchPhoto(appContext(res), id)
  sendFile(res, { filename: `punch-${id}.${photo.type.split('/')[1]}`, bytes: photo.bytes, contentType: photo.type })
}

/** GET /api/attendance/devices?status=waiting|all&employee=<id> — phones of the people in reach (client, 11 and 14 Oct 2026). */
export const getDevices: RequestHandler = async (req, res) => {
  const { status, employee } = parseBody(devicesQuerySchema, req.query)
  const list = await listDevices(appContext(res), { status, employeeId: employee })
  // With whether phones are checked at all (one phone per employee): the person's page says so when not.
  res.status(200).json({ data: { one_device: list.oneDevice, phones: list.phones.map(devicePayload) }, meta: { requestId: res.locals.requestId } })
}

/** POST /api/attendance/devices/:id/approve — Replace: this phone is theirs; their others are taken off. */
export const postApproveDevice: RequestHandler = async (req, res) => {
  const { id } = parseBody(attendanceIdSchema, req.params)
  const saved = await approveDevice(appContext(res), id)
  res.status(200).json({ data: { id: saved.id, status: saved.status }, meta: { requestId: res.locals.requestId } })
}

/** POST /api/attendance/devices/:id/retire — their phone reset, or a waiting one refused. */
export const postRetireDevice: RequestHandler = async (req, res) => {
  const { id } = parseBody(attendanceIdSchema, req.params)
  const saved = await retireDevice(appContext(res), id)
  res.status(200).json({ data: { id: saved.id, status: saved.status }, meta: { requestId: res.locals.requestId } })
}

function devicePayload(d: DeviceRow) {
  return {
    id: d.id,
    employee_id: d.employeeId,
    full_name: d.fullName,
    employee_code: d.employeeCode,
    label: d.label,
    status: d.status,
    first_seen_at: isoInstant(d.firstSeenAt),
    last_seen_at: isoInstant(d.lastSeenAt),
    decided_at: isoInstant(d.decidedAt),
    may_decide: d.mayDecide,
    ask: d.ask,
  }
}
