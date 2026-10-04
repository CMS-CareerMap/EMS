import Papa from 'papaparse'
import type { AppContext } from '../../platform/context'
import { BadRequest, Forbidden } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import { addCalendarDays, dayLabel, fromDateColumn, isCalendarDate, parseWallClock, toDateColumn, zonedToday, type CalendarDate } from '../../domain/shared/dates'
import { hoursBetweenWallClock } from '../../domain/attendance/hours'
import { forWorkedHalf, gradedBy, halfDayReason, marksOf, measureDay, withHalfDayLeave, type DayMeasure } from '../../domain/attendance/shiftRules'
import * as repo from './attendance.repository'
import { companyTimezone } from '../organization/organization.service'
import { closedMonthKeys } from '../payroll/payrollLock.service'
import { audit } from '../audit/audit.service'
import { checkWork, loadWork } from '../organization/workRules.service'

/**
 * Biometric attendance import.
 *
 * The client's machine exports CSV, and direct device integration is deferred
 * until the machine is actually bought — so this is how biometric days reach
 * the system. Same shape as the employee importer: preview first, commit
 * explicitly, all or nothing.
 *
 * Rows land with `source = biometric`, which is the point. A day that came off
 * a fingerprint reader and a day HR typed in are different kinds of evidence,
 * and six months later somebody will need to know which one they are looking at.
 */

const MAX_BYTES = 1_000_000
const MAX_ROWS = 2_000

export interface RowIssue {
  field: string
  message: string
}

export interface ImportRow {
  line: number
  employeeCode: string
  date: string
  checkIn: string | null
  checkOut: string | null
  hours: number | null
  issues: RowIssue[]
}

export interface AttendanceImportResult {
  dryRun: boolean
  summary: {
    totalRows: number
    valid: number
    invalid: number
    wouldOverwrite: number
    imported: number
  }
  rows: ImportRow[]
}

const HEADER_ALIASES: Record<string, string[]> = {
  employeeCode: ['employee_code', 'employee_id', 'emp_code', 'emp_id', 'code', 'user_id'],
  date: ['date', 'att_date', 'attendance_date', 'punch_date'],
  checkIn: ['check_in', 'in_time', 'in', 'punch_in', 'first_in'],
  checkOut: ['check_out', 'out_time', 'out', 'punch_out', 'last_out'],
}

function normaliseHeader(header: string): string {
  const cleaned = header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(cleaned)) return field
  }
  return cleaned
}

/** DD/MM/YYYY or ISO, same as the employee importer. */
function parseDate(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return isCalendarDate(trimmed) ? trimmed : null

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed)
  if (!dmy) return null

  const [, d, m, y] = dmy
  const iso = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
  return isCalendarDate(iso) ? iso : null
}

/**
 * Biometric machines write times in whatever their firmware felt like.
 *
 * "09:30", "09:30:00" and "9:30 AM" all appear in real exports, sometimes in
 * the same file. Accepting all three costs a few lines; rejecting a roster over
 * a trailing ":00" costs an afternoon.
 */
function parseTime(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const ampm = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i.exec(trimmed)
  if (ampm) {
    let hours = Number(ampm[1])
    const minutes = Number(ampm[2])
    const isPm = ampm[3]!.toUpperCase() === 'PM'
    if (hours === 12) hours = 0
    if (isPm) hours += 12
    return hours > 23 || minutes > 59 ? null : hours * 60 + minutes
  }

  return parseWallClock(trimmed.replace(/:\d{2}$/, (m) => (trimmed.split(':').length === 3 ? '' : m)))
}

export interface AttendanceImportInput {
  csv: string
  dryRun: boolean
}

/** Approved leave as "employeeId|YYYY-MM-DD" → the whole day, or half of it (and which half). */
function leaveByDay(leave: { employeeId: string; fromDate: Date; toDate: Date; halfDayDates: string[]; halfDaySessions: unknown }[]) {
  const map = new Map<string, repo.LeaveOnDay>()
  for (const l of leave) {
    const to = fromDateColumn(l.toDate)
    for (let day = fromDateColumn(l.fromDate); day <= to; day = addCalendarDays(day, 1)) {
      const key = `${l.employeeId}|${day}`
      // A whole day — or a second half on a day that already has one — is the whole day.
      const isHalf = l.halfDayDates.includes(day)
      map.set(key, isHalf && !map.has(key) ? { kind: 'half', session: repo.sessionOf(l.halfDaySessions, day) } : { kind: 'full' })
    }
  }
  return map
}

export async function importAttendance(
  ctx: AppContext,
  input: AttendanceImportInput,
): Promise<AttendanceImportResult> {
  if (Buffer.byteLength(input.csv, 'utf8') > MAX_BYTES) {
    throw BadRequest('That file is larger than 1 MB. Export a shorter date range.')
  }

  const parsed = Papa.parse<Record<string, string>>(input.csv.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: normaliseHeader,
  })

  if (parsed.data.length === 0) {
    throw BadRequest('That file has no rows. Check it has a header line.')
  }

  if (parsed.data.length > MAX_ROWS) {
    throw BadRequest(`That file has ${parsed.data.length} rows. The limit is ${MAX_ROWS}.`)
  }

  const zone = await companyTimezone(ctx)
  const today = zonedToday(new Date(), zone)
  // Months whose payroll is signed off. Their days are reported line by line,
  // so the rest of the file can still go in.
  const closed = await closedMonthKeys(ctx)

  // Only the people the importer's attendance scope reaches; a code outside it
  // reads like an unknown code, so the file cannot be used to probe who exists.
  const [employees, work] = await Promise.all([
    repo.importableEmployees(ctx.db, ctx.scopeFor('attendance')),
    loadWork(ctx.db, ctx.organizationId, 'attendance'),
  ])
  const byCode = new Map(employees.map((e) => [e.employeeCode.toLowerCase(), e]))

  const seen = new Map<string, number>()
  const rows: ImportRow[] = []
  const prepared: {
    employee: (typeof employees)[number]
    date: string
    start: number | null
    end: number | null
    hours: number | null
    status: 'present' | 'half_day' | 'absent'
    note: string | null
    measure: DayMeasure | null
    expectedHours: number | null
    shiftId: string | null
  }[] = []
  // Rows that read cleanly, graded once the days already recorded and the
  // leave on them are known.
  const candidates: { row: ImportRow; employee: (typeof employees)[number]; date: CalendarDate; start: number | null; end: number | null }[] = []

  let wouldOverwrite = 0

  for (const [index, raw] of parsed.data.entries()) {
    const line = index + 2
    const issues: RowIssue[] = []

    const employeeCode = (raw.employeeCode ?? '').trim()
    const rawDate = (raw.date ?? '').trim()
    const rawIn = (raw.checkIn ?? '').trim()
    const rawOut = (raw.checkOut ?? '').trim()

    const employee = employeeCode ? byCode.get(employeeCode.toLowerCase()) : undefined
    if (!employeeCode) {
      issues.push({ field: 'employee_code', message: 'An employee code is required' })
    } else if (!employee) {
      issues.push({
        field: 'employee_code',
        message: `No employee with code ${employeeCode}. Import them first, or fix the code.`,
      })
    } else {
      // Your own attendance, or that of somebody who marks attendance too, goes
      // up the company tree (Day 22) — a file is no way round it.
      const check = checkWork(ctx, work, employee.id)
      if (!check.allowed) {
        issues.push({
          field: 'employee_code',
          message: check.own
            ? `This is your own attendance. It goes to the person above you: ${check.ask}.`
            : `${employeeCode} marks attendance too, so their attendance is done by the people above them. Ask ${check.ask}.`,
        })
      }
    }

    const date = rawDate ? parseDate(rawDate) : null
    if (!rawDate) {
      issues.push({ field: 'date', message: 'A date is required' })
    } else if (!date) {
      issues.push({
        field: 'date',
        message: `"${rawDate}" is not a date this can read. Use DD/MM/YYYY or YYYY-MM-DD.`,
      })
    } else if (date > today) {
      issues.push({ field: 'date', message: 'That day has not happened yet' })
    } else if (closed.has(date.slice(0, 7))) {
      issues.push({
        field: 'date',
        message: `Payroll for that month is already ${closed.get(date.slice(0, 7))}, so its attendance can no longer change`,
      })
    } else if (employee) {
      // Not a working day of theirs: before they joined, or after they left.
      const joined = fromDateColumn(employee.dateOfJoining)
      const last = fromDateColumn(employee.lastWorkingDate)
      if (joined && date < joined) issues.push({ field: 'date', message: `${employee.fullName} joined on ${dayLabel(joined)}, after this day` })
      else if (last && date > last) issues.push({ field: 'date', message: `${employee.fullName}’s last working day was ${dayLabel(last)}, before this day` })
    }

    const start = rawIn ? parseTime(rawIn) : null
    if (rawIn && start === null) {
      issues.push({ field: 'check_in', message: `"${rawIn}" is not a time. Use 09:30 or 9:30 AM.` })
    }

    const end = rawOut ? parseTime(rawOut) : null
    if (rawOut && end === null) {
      issues.push({ field: 'check_out', message: `"${rawOut}" is not a time. Use 18:30 or 6:30 PM.` })
    }

    // A file that lists the same person twice on the same day would fail on the
    // unique index halfway through, with no useful message about which lines.
    if (employeeCode && date) {
      const key = `${employeeCode.toLowerCase()}|${date}`
      const first = seen.get(key)
      if (first !== undefined) {
        issues.push({
          field: 'date',
          message: `${employeeCode} already appears for ${date} on line ${first}`,
        })
      } else {
        seen.set(key, line)
      }
    }

    const row: ImportRow = { line, employeeCode, date: date ?? rawDate, checkIn: rawIn || null, checkOut: rawOut || null, hours: null, issues }
    rows.push(row)
    if (issues.length === 0 && employee && date) candidates.push({ row, employee, date, start, end })
  }

  // What is already recorded on these days, and the leave approved on them.
  const ids = [...new Set(candidates.map((c) => c.employee.id))]
  const days = candidates.map((c) => c.date).sort()
  const [recorded, leave] = candidates.length
    ? await Promise.all([
        repo.recordedDays(ctx.db, ids, days[0]!, days[days.length - 1]!),
        repo.approvedLeaveDays(ctx.db, ids, days[0]!, days[days.length - 1]!),
      ])
    : [[], []]
  const recordedOn = new Map(recorded.map((r) => [`${r.employeeId}|${fromDateColumn(r.date)}`, r]))
  const leaveOn = leaveByDay(leave)

  for (const { row, employee, date, start, end } of candidates) {
    const key = `${employee.id}|${date}`
    const existing = recordedOn.get(key)
    // A whole day of approved leave is the leave: a punch over it would charge
    // the balance for a day worked. Half of one leaves the other half to grade.
    const leave = leaveOn.get(key) ?? null
    if (leave?.kind === 'full' && existing?.status === 'on_leave') {
      row.issues.push({ field: 'date', message: `${employee.employeeCode} has approved leave on ${dayLabel(date)}. Reverse the leave first if they worked, or leave this line out.` })
      continue
    }
    const halfLeave = leave?.kind === 'half'
    // Graded against the shift the day was recorded on, if it was — not one assigned since.
    const graded = gradedBy(existing, employee)
    const rules = leave?.kind === 'half' ? forWorkedHalf(graded.rules, leave.session) : graded.rules

    let hours: number | null = null
    // Neither time: the machine has nobody that day. One of the two: they were
    // there, and forgot the other punch — present, as an app day with no
    // check-out is, for HR to correct; never a whole day's pay docked for it.
    let status: 'present' | 'half_day' | 'absent' = start === null && end === null ? 'absent' : 'present'
    let note: string | null = start === null && end !== null ? 'No check-in on the machine' : start !== null && end === null ? 'No check-out on the machine' : null
    let measure: DayMeasure | null = null

    if (start !== null && end !== null) {
      const result = hoursBetweenWallClock(start, end, graded.breakMinutes)
      hours = result.hours
      // The machine's times are the company's wall clock; a check-out at or
      // before the check-in is the next morning, as hoursBetweenWallClock reads it.
      measure = measureDay({ rules, checkIn: start, checkOut: end <= start ? end + 1440 : end, hoursWorked: hours })
      note = [result.warning, halfDayReason(measure)].filter(Boolean).join(' · ') || null
      const classification = halfLeave ? withHalfDayLeave(measure.classification) : measure.classification
      status = classification?.status ?? 'present'
    }

    row.hours = hours
    if (existing) wouldOverwrite += 1
    prepared.push({ employee, date, start, end, hours, status, note, measure, expectedHours: graded.expectedHours, shiftId: graded.shiftId })
  }

  // `wouldOverwrite` — how many replace a recorded day — is in the preview
  // because overwriting a day HR corrected by hand is the thing somebody
  // wants to know BEFORE pressing import, not after.

  // Replacing a recorded day is correcting it — its own tick. The preview
  // says so too: it promises what the import will do.
  if (wouldOverwrite > 0 && !ctx.can('attendance:update')) {
    throw Forbidden(
      `${wouldOverwrite} of these days ${wouldOverwrite === 1 ? 'is' : 'are'} already recorded, and replacing them needs “Correct attendance”, which your role does not have. Leave those days out of the file.`,
    )
  }

  const invalid = rows.filter((r) => r.issues.length > 0).length

  const summary = {
    totalRows: rows.length,
    valid: prepared.length,
    invalid,
    wouldOverwrite,
    imported: 0,
  }

  if (input.dryRun) return { dryRun: true, summary, rows }

  if (invalid > 0) {
    throw BadRequest(
      `${invalid} of ${rows.length} rows have problems. Fix them and run the preview again.`,
    )
  }

  await withTransaction(ctx.db, async (tx) => {
    for (const row of prepared) {
      const data = {
        checkIn: row.start !== null ? instantFor(row.date, row.start, zone) : null,
        checkOut:
          row.end !== null
            ? instantFor(row.date, row.end, zone, row.end <= (row.start ?? 0))
            : null,
        status: row.status,
        // The whole reason this importer exists as its own path.
        source: 'biometric' as const,
        hoursWorked: row.hours,
        expectedHours: row.expectedHours,
        shiftId: row.shiftId,
        note: row.note,
        markedByUserId: ctx.userId,
        ...(row.measure ? marksOf(row.measure) : { lateMinutes: null, earlyLeavingMinutes: null, overtimeMinutes: null }),
        // No geofence columns. A fingerprint at the machine IS the location
        // evidence, and leaving these null says "no GPS check was made" rather
        // than inventing one.
      }

      await repo.replaceDay(tx, ctx.organizationId, row.employee.id, toDateColumn(row.date), data)
    }

    await audit(ctx, {
      action: 'attendance.imported',
      entityType: 'import',
      details: { rows: prepared.length, replacedExisting: wouldOverwrite },
    }, tx)
  })

  summary.imported = prepared.length

  logger.info('Biometric attendance imported', {
    by: ctx.userId,
    rows: prepared.length,
    overwritten: wouldOverwrite,
  })

  return { dryRun: false, summary, rows }
}

/** "09:30 on 2026-04-15 in Asia/Kolkata" as an instant. */
function instantFor(date: string, minutes: number, zone: string, nextDay = false): Date {
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mins = String(minutes % 60).padStart(2, '0')

  const base = new Date(`${date}T${hours}:${mins}:00Z`)
  const shifted = nextDay ? new Date(base.getTime() + 86_400_000) : base

  const asZoned = new Date(shifted.toLocaleString('en-US', { timeZone: zone }))
  const asUtc = new Date(shifted.toLocaleString('en-US', { timeZone: 'UTC' }))

  return new Date(shifted.getTime() - (asZoned.getTime() - asUtc.getTime()))
}
