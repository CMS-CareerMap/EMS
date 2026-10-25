import Papa from 'papaparse'
import type { AttendanceStatus } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { BadRequest, Forbidden } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import { addCalendarDays, dayLabel, fromDateColumn, toDateColumn, zonedToday, type CalendarDate } from '../../domain/shared/dates'
import { hoursBetweenWallClock } from '../../domain/attendance/hours'
import { clockMinutes, forWorkedHalf, gradedBy, halfDayReason, marksOf, measureDay, shiftRulesOf, withHalfDayLeave, type DayMeasure } from '../../domain/attendance/shiftRules'
import {
  machineDays,
  machineHeader,
  matchMachineDay,
  mergeScans,
  parseMachineDate,
  parseMachineDateTime,
  parseMachineTime,
  type MachineLine,
  type MachineMatchResult,
} from '../../domain/attendance/machineFile'
import * as repo from './attendance.repository'
import { companyTimezone } from '../organization/organization.service'
import { assertDaysOpen, closedMonthKeys } from '../payroll/payrollLock.service'
import { audit } from '../audit/audit.service'
import { tellAbsent } from './attendanceNotices'
import { checkWork, loadWork } from '../organization/workRules.service'
import { attendanceSecurityOf } from '../settings/settings.repository'

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
 *
 * Check-in security (client, 11 Oct 2026):
 *   - ANY MACHINE'S FILE: one line a day (in, out) or one line a scan; a
 *     person's day is its scans — the first the check-in, the last the
 *     check-out (domain/attendance/machineFile.ts). A line is matched to a
 *     person by their Machine ID first, then their employee code.
 *   - CONFIRMATION, with "Confirm by the fingerprint machine" on (Settings →
 *     Attendance Security): a day an app punch made is never overwritten — the
 *     machine's scans are kept beside it and the day is confirmed, its times
 *     differ, or — no scan at all that day, within the file's dates — it is not
 *     on the machine: flagged, or made absent, as the company chose. A day with
 *     scans and no app punch is filled from the machine, when the company says.
 */

const MAX_BYTES = 1_000_000
/** A file of one line a scan has several lines a person a day: a month of a company's scans fits. */
const MAX_ROWS = 10_000
/** The people and days named in the preview; the counts cover them all. */
const LIST_MAX = 100

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

/** What the machine's file said of the app's days (client, 11 Oct 2026). */
export interface MachineSummary {
  /** The file's first and last day: "not on the machine" is said only between them. */
  from: CalendarDate
  to: CalendarDate
  confirmed: number
  timeDiffers: number
  notOnMachine: number
  /** Days with scans and no app punch, filled from the machine. */
  fromMachine: number
  /** Days with scans and no app punch, left alone (the company does not fill them). */
  notFilled: number
  /** Of the days not on the machine, those the company's rule makes absent. */
  madeAbsent: number
  missing: { employeeCode: string; fullName: string; date: CalendarDate }[]
  /** People with app days in the file's dates and not a single line in it — a partial file? */
  notInFile: { employeeCode: string; fullName: string; days: number }[]
}

export interface AttendanceImportResult {
  dryRun: boolean
  summary: {
    totalRows: number
    /** The days the import writes: from the machine, or the machine's word on an app day. */
    valid: number
    invalid: number
    wouldOverwrite: number
    /** Lines with no times on a day of whole-day approved leave: left as the leave, not imported. */
    onLeave: number
    /**
     * Night shifts' morning scans on the file's first day, which belong to the
     * night before it, left out: that night has nothing recorded yet to make
     * whole (or its month is closed, or it was leave). Including the day
     * before in the file brings them in.
     */
    edgeNightsLeftOut: number
    imported: number
    /** Null with "Confirm by the fingerprint machine" off. */
    machine: MachineSummary | null
  }
  rows: ImportRow[]
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

type Employee = Awaited<ReturnType<typeof repo.importableEmployees>>[number]
type Recorded = Awaited<ReturnType<typeof repo.recordedDays>>[number]

/** A day the machine's file writes: graded as the import always graded it. */
interface Replace {
  employee: Employee
  date: CalendarDate
  start: number | null
  /** Minutes from the day's midnight; past 1440 is the next morning. */
  end: number | null
  hours: number | null
  status: 'present' | 'half_day' | 'absent'
  note: string | null
  measure: DayMeasure | null
  expectedHours: number | null
  shiftId: string | null
  /** An app employee's day filled from the machine: its scans, kept as such. */
  fromMachine: { first: number | null; last: number | null } | null
}

/** The machine's word on a day an app punch made. */
interface Match {
  id: string
  employeeId: string
  date: CalendarDate
  result: Exclude<MachineMatchResult, 'not_on_machine'>
  first: number | null
  last: number | null
  /** The status the machine's rule took away before, given back now the machine has the day — only while the day is still the absent it made. */
  restore: AttendanceStatus | null
}

/** An app office day with no scan in the file. */
interface Missing {
  id: string
  employeeId: string
  date: CalendarDate
  status: AttendanceStatus
  /** Made absent by the company's rule: a day closed (checked out) and not absent already. One still open is graded at its check-out — flagged only. */
  makeAbsent: boolean
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
    transformHeader: machineHeader,
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
  const [employees, work, security] = await Promise.all([
    repo.importableEmployees(ctx.db, ctx.scopeFor('attendance')),
    loadWork(ctx.db, ctx.organizationId, 'attendance'),
    attendanceSecurityOf(ctx.db, ctx.organizationId),
  ])
  const matching = security?.punchMachineMatch === true
  const byCode = new Map(employees.map((e) => [e.employeeCode.toLowerCase(), e]))
  const byMachineId = new Map(employees.flatMap((e) => (e.machineId ? [[e.machineId.toLowerCase(), e] as const] : [])))
  const employeeById = new Map(employees.map((e) => [e.id, e]))

  const rows: ImportRow[] = []
  const rowByLine = new Map<number, ImportRow>()
  const lines: MachineLine[] = []
  // Lines that say nobody was there (no time at all): "employeeId|date".
  const blank = new Set<string>()

  for (const [index, raw] of parsed.data.entries()) {
    const line = index + 2
    const issues: RowIssue[] = []

    const code = (raw.code ?? '').trim()
    const rawDate = (raw.date ?? '').trim()
    const rawIn = (raw.checkIn ?? '').trim()
    const rawOut = (raw.checkOut ?? '').trim()
    const rawScan = (raw.time ?? '').trim()

    // The machine's own number first, then the employee code.
    const employee = code ? (byMachineId.get(code.toLowerCase()) ?? byCode.get(code.toLowerCase())) : undefined
    if (!code) {
      issues.push({ field: 'employee_code', message: 'An employee code is required' })
    } else if (!employee) {
      issues.push({
        field: 'employee_code',
        message: `No employee with code or Machine ID ${code}. Set their Machine ID on their page, import them first, or fix the code.`,
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
            : `${code} marks attendance too, so their attendance is done by the people above them. Ask ${check.ask}.`,
        })
      }
    }

    // A scan's time may carry its date ("10/10/2026 10:08") — or have it in its own column.
    const stamped = rawScan ? parseMachineDateTime(rawScan) : null
    const scan = stamped ? stamped.minutes : rawScan ? parseMachineTime(rawScan) : null
    if (rawScan && scan === null) {
      issues.push({ field: 'time', message: `"${rawScan}" is not a time. Use 09:30, 9:30 AM, or a date and a time.` })
    }

    const date = rawDate ? parseMachineDate(rawDate) : stamped?.date ?? null
    if (!rawDate && !stamped) {
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

    const start = rawIn ? parseMachineTime(rawIn) : null
    if (rawIn && start === null) {
      issues.push({ field: 'check_in', message: `"${rawIn}" is not a time. Use 09:30 or 9:30 AM.` })
    }

    const end = rawOut ? parseMachineTime(rawOut) : null
    if (rawOut && end === null) {
      issues.push({ field: 'check_out', message: `"${rawOut}" is not a time. Use 18:30 or 6:30 PM.` })
    }

    // Several lines for one person and day are one day — its first scan and its
    // last (client, 11 Oct 2026); they used to be refused as a duplicate.
    const row: ImportRow = { line, employeeCode: code, date: date ?? rawDate, checkIn: rawIn || rawScan || null, checkOut: rawOut || null, hours: null, issues }
    rows.push(row)
    rowByLine.set(line, row)
    if (issues.length === 0 && employee && date) {
      lines.push({ line, employeeId: employee.id, date, checkIn: start, checkOut: end, scan })
      if (start === null && end === null && scan === null) blank.add(`${employee.id}|${date}`)
    }
  }

  // The lines as days — a night's early-morning scan going to the night before.
  const days = machineDays(lines, (id) => shiftRulesOf(employeeById.get(id)?.shift))
  const scannedDays = new Set(days.map((d) => `${d.employeeId}|${d.date}`))

  // The file's own dates, from its lines: what "not on the machine" is judged
  // between. A night shift's morning scan on the first of them belongs to the
  // night before — outside them. That is an EDGE NIGHT: made whole with what
  // is already recorded for it (an earlier file's evening), never judged — nor
  // written — on the file's morning alone.
  const lineDates = lines.map((l) => l.date).sort()
  const from = lineDates[0]
  const to = lineDates[lineDates.length - 1]
  const isEdge = (date: CalendarDate) => from !== undefined && date < from

  // A night's day can land before its lines' own dates: its month and the
  // person's employment, checked again. Inside the file's dates that refuses
  // its lines; an edge night is left out instead — its month is not the file's.
  const edgeLeftOutKeys = new Set<string>()
  for (const d of days) {
    if (!d.nightMoved) continue
    const employee = employeeById.get(d.employeeId)!
    const joined = fromDateColumn(employee.dateOfJoining)
    const last = fromDateColumn(employee.lastWorkingDate)
    const problem = closed.has(d.date.slice(0, 7))
      ? `Payroll for ${dayLabel(d.date)}'s month is already ${closed.get(d.date.slice(0, 7))}, so its attendance can no longer change`
      : joined && d.date < joined ? `${employee.fullName} joined on ${dayLabel(joined)}, after ${dayLabel(d.date)}`
      : last && d.date > last ? `${employee.fullName}’s last working day was ${dayLabel(last)}, before ${dayLabel(d.date)}`
      : null
    if (!problem) continue
    if (isEdge(d.date)) edgeLeftOutKeys.add(`${d.employeeId}|${d.date}`)
    else for (const n of d.lines) rowByLine.get(n)!.issues.push({ field: 'date', message: problem })
  }
  const blankDays = [...blank].filter((key) => !scannedDays.has(key)).map((key) => {
    const [employeeId, date] = key.split('|') as [string, CalendarDate]
    return { employeeId, date }
  })
  // What is read from the database starts at the earliest day, edge nights included.
  const readFrom = from !== undefined && days[0] !== undefined && days[0].date < from ? days[0].date : from

  // App employees the importer may record for, who should be on the machine: not remote.
  const expected = matching
    ? employees.filter((e) => e.attendanceMode === 'app' && e.workArrangement !== 'remote' && checkWork(ctx, work, e.id).allowed)
    : []

  const ids = [...new Set([...days.map((d) => d.employeeId), ...blankDays.map((d) => d.employeeId)])]
  const [recorded, leave, appDays] = readFrom && from && to
    ? await Promise.all([
        repo.recordedDays(ctx.db, ids, readFrom, to),
        repo.approvedLeaveDays(ctx.db, ids, readFrom, to),
        repo.appOfficeDays(ctx.db, expected.map((e) => e.id), from, to),
      ])
    : [[], [], []]
  const recordedOn = new Map(recorded.map((r) => [`${r.employeeId}|${fromDateColumn(r.date)}`, r]))
  const leaveOn = leaveByDay(leave)

  const replace: Replace[] = []
  const matches: Match[] = []
  let wouldOverwrite = 0
  let onLeave = 0
  let notFilled = 0
  let edgeNightsLeftOut = 0

  /** A day the machine's file writes, graded as the import always graded it. */
  function plan(employee: Employee, date: CalendarDate, existing: Recorded | undefined, first: number | null, last: number | null, fromMachine: boolean): Replace {
    const leaveDay = leaveOn.get(`${employee.id}|${date}`) ?? null
    const halfLeave = leaveDay?.kind === 'half'
    // Graded against the shift the day was recorded on, if it was — not one assigned since.
    const graded = gradedBy(existing, employee)
    const rules = leaveDay?.kind === 'half' ? forWorkedHalf(graded.rules, leaveDay.session) : graded.rules
    let hours: number | null = null
    // Neither time: the machine has nobody that day. One: they were there, and
    // forgot the other punch — present, as an app day with no check-out is, for
    // HR to correct; never a whole day's pay docked for it.
    let status: 'present' | 'half_day' | 'absent' = first === null && last === null ? 'absent' : 'present'
    let note: string | null = first === null && last !== null ? 'No check-in on the machine' : first !== null && last === null ? 'No check-out on the machine' : null
    let measure: DayMeasure | null = null
    if (first !== null && last !== null) {
      // The machine's times are the company's wall clock; a check-out at or
      // before the check-in is the next morning, as hoursBetweenWallClock reads it.
      const result = hoursBetweenWallClock(first % 1440, last % 1440, graded.breakMinutes)
      hours = result.hours
      measure = measureDay({ rules, checkIn: first, checkOut: last <= first ? last + 1440 : last, hoursWorked: hours })
      note = [result.warning, halfDayReason(measure)].filter(Boolean).join(' · ') || null
      const classification = halfLeave ? withHalfDayLeave(measure.classification) : measure.classification
      status = classification?.status ?? 'present'
    }
    // An Absent the no-check-in rule wrote is nobody's record: the machine's day replaces it as marking, not correcting (client, 25 Oct 2026).
    if (existing && existing.source !== 'system') wouldOverwrite += 1
    return { employee, date, start: first, end: last, hours, status, note, measure, expectedHours: graded.expectedHours, shiftId: graded.shiftId, fromMachine: fromMachine && (first !== null || last !== null) ? { first, last } : null }
  }

  for (const d of days) {
    const employee = employeeById.get(d.employeeId)!
    const key = `${d.employeeId}|${d.date}`
    if (d.lines.some((n) => rowByLine.get(n)!.issues.length > 0)) continue
    const existing = recordedOn.get(key)
    const edge = isEdge(d.date)
    // An edge night with nothing recorded to make whole — or its month closed — is left out, not guessed at.
    if (edge && (edgeLeftOutKeys.has(key) || !existing)) {
      edgeNightsLeftOut += 1
      continue
    }
    // A whole day of approved leave is the leave: a scan over it would charge
    // the balance for a day worked. Half of one leaves the other half to grade.
    if (leaveOn.get(key)?.kind === 'full' && existing?.status === 'on_leave') {
      if (edge) {
        edgeNightsLeftOut += 1
        continue
      }
      for (const n of d.lines) {
        rowByLine.get(n)!.issues.push({ field: 'date', message: `${employee.employeeCode} has approved leave on ${dayLabel(d.date)}. Reverse the leave first if they worked, or leave this line out.` })
      }
      continue
    }
    const minutesOf = (instant: Date | null) => (instant ? clockMinutes(instant, d.date, zone) : null)
    if (matching && employee.attendanceMode === 'app') {
      // The app's day stands; the machine confirms it (client, 11 Oct 2026) —
      // a day checked in on the app, whoever recorded its check-out since.
      if (existing && repo.isAppDay(existing)) {
        const scans = edge ? mergeScans(d, [minutesOf(existing.machineFirstScan), minutesOf(existing.machineLastScan)]) : d
        const app = { checkIn: minutesOf(existing.checkIn), checkOut: minutesOf(existing.checkOut) }
        const verdict = matchMachineDay(app, scans, security!.punchMachineMinutes)
        matches.push({
          id: existing.id,
          employeeId: d.employeeId,
          date: d.date,
          result: verdict.result === 'time_differs' ? 'time_differs' : 'confirmed',
          first: scans.first,
          last: scans.last,
          restore: existing.status === 'absent' ? existing.statusBeforeMachine : null,
        })
        continue
      }
      if (!security!.punchMachineFills) {
        notFilled += 1
        continue
      }
    }
    // An edge night is made whole only on a day the machine itself wrote — never over the app's or HR's.
    // An Absent the no-check-in rule wrote is nobody's, and the file replaces it (25 Oct 2026).
    if (edge && existing!.source !== 'biometric' && existing!.source !== 'system') {
      edgeNightsLeftOut += 1
      continue
    }
    const scans = edge ? mergeScans(d, [minutesOf(existing!.checkIn), minutesOf(existing!.checkOut)]) : d
    const replaced = plan(employee, d.date, existing, scans.first, scans.last, matching && employee.attendanceMode === 'app')
    replace.push(replaced)
    const firstRow = rowByLine.get(d.lines[0]!)!
    firstRow.hours = replaced.hours
  }

  for (const b of blankDays) {
    const employee = employeeById.get(b.employeeId)!
    const key = `${b.employeeId}|${b.date}`
    const existing = recordedOn.get(key)
    // No times on a day of whole-day approved leave: the machine agrees nobody
    // came — the leave stands, and the line is left out (client, 10 Oct 2026).
    if (leaveOn.get(key)?.kind === 'full' && existing?.status === 'on_leave') {
      onLeave += 1
      continue
    }
    if (matching && employee.attendanceMode === 'app') {
      // No scan: an app day is judged below, with the rest of the file's dates.
      if (existing && repo.isAppDay(existing)) continue
      // Not filled — and not counted with the days that had scans.
      if (!security!.punchMachineFills) continue
    }
    replace.push(plan(employee, b.date, existing, null, null, false))
  }

  // App office days with no scan in the file's dates: not on the machine. Never
  // today, which is not over; a day not yet checked out is flagged, never made
  // absent — its check-out grades it.
  const makesAbsent = security?.punchMachineMissing === 'absent'
  const missing: Missing[] = matching
    ? appDays
        .map((a) => ({ id: a.id, employeeId: a.employeeId, date: fromDateColumn(a.date), status: a.status, makeAbsent: makesAbsent && a.status !== 'absent' && a.checkOut !== null }))
        .filter((a) => a.date < today && !scannedDays.has(`${a.employeeId}|${a.date}`) && !closed.has(a.date.slice(0, 7)))
    : []
  const madeAbsent = missing.filter((m) => m.makeAbsent).length
  const restored = matches.filter((m) => m.restore).length

  // `wouldOverwrite` — how many replace a recorded day — is in the preview
  // because overwriting a day HR corrected by hand is the thing somebody
  // wants to know BEFORE pressing import, not after.

  // Replacing a recorded day is correcting it — its own tick. The preview
  // says so too: it promises what the import will do. So is making a day
  // absent, or giving back what an earlier file made absent.
  if ((wouldOverwrite > 0 || madeAbsent > 0 || restored > 0) && !ctx.can('attendance:update')) {
    throw Forbidden(
      wouldOverwrite > 0
        ? `${wouldOverwrite} of these days ${wouldOverwrite === 1 ? 'is' : 'are'} already recorded, and replacing them needs “Correct attendance”, which your role does not have. Leave those days out of the file.`
        : madeAbsent > 0
          ? `${madeAbsent} app-punched ${madeAbsent === 1 ? 'day is' : 'days are'} not on the machine and would be made absent, which needs “Correct attendance”, which your role does not have.`
          : `${restored} ${restored === 1 ? 'day' : 'days'} an earlier file made absent would be given back, which needs “Correct attendance”, which your role does not have.`,
    )
  }

  const invalid = rows.filter((r) => r.issues.length > 0).length
  const nameOf = (employeeId: string) => employeeById.get(employeeId)!
  const linesOf = new Set(days.map((d) => d.employeeId).concat(blankDays.map((d) => d.employeeId)))
  const notInFile = expected
    .filter((e) => !linesOf.has(e.id))
    .map((e) => ({ employeeCode: e.employeeCode, fullName: e.fullName, days: missing.filter((m) => m.employeeId === e.id).length }))
    .filter((e) => e.days > 0)

  const summary: AttendanceImportResult['summary'] = {
    totalRows: rows.length,
    valid: replace.length + matches.length,
    invalid,
    wouldOverwrite,
    onLeave,
    edgeNightsLeftOut,
    imported: 0,
    machine: matching && from && to
      ? {
          from,
          to,
          confirmed: matches.filter((m) => m.result === 'confirmed').length,
          timeDiffers: matches.filter((m) => m.result === 'time_differs').length,
          notOnMachine: missing.length,
          fromMachine: replace.filter((r) => r.fromMachine).length,
          notFilled,
          madeAbsent,
          missing: missing.slice(0, LIST_MAX).map((m) => ({ employeeCode: nameOf(m.employeeId).employeeCode, fullName: nameOf(m.employeeId).fullName, date: m.date })),
          notInFile: notInFile.slice(0, LIST_MAX),
        }
      : null,
  }

  if (input.dryRun) return { dryRun: true, summary, rows }

  if (invalid > 0) {
    throw BadRequest(
      `${invalid} of ${rows.length} rows have problems. Fix them and run the preview again.`,
    )
  }

  const now = new Date()
  await withTransaction(ctx.db, async (tx) => {
    // Under the payroll lock of every month in the file: one approved since the preview is refused, not missed.
    await assertDaysOpen(ctx, [...replace.map((r) => r.date), ...matches.map((m) => m.date), ...missing.map((m) => m.date)], 'importing attendance for those days', tx)
    for (const row of replace) {
      const data = {
        checkIn: row.start !== null ? at(row.date, row.start, zone) : null,
        checkOut: row.end !== null ? at(row.date, row.end <= (row.start ?? 0) ? row.end + 1440 : row.end, zone) : null,
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
        // An app employee's day the machine filled says so (client, 11 Oct 2026);
        // any other day the machine writes is the machine's own — nothing to match.
        ...(row.fromMachine
          ? {
              machineFirstScan: row.fromMachine.first !== null ? at(row.date, row.fromMachine.first, zone) : null,
              machineLastScan: row.fromMachine.last !== null ? at(row.date, row.fromMachine.last, zone) : null,
              machineMatch: 'from_machine' as const,
              machineCheckedAt: now,
            }
          : { machineFirstScan: null, machineLastScan: null, machineMatch: null, machineCheckedAt: null }),
        statusBeforeMachine: null,
      }

      await repo.replaceDay(tx, ctx.organizationId, row.employee.id, toDateColumn(row.date), data)
    }

    // The machine's word on the app's days: kept beside them, never over them.
    for (const m of matches) {
      await repo.updateDay(tx, m.id, {
        machineFirstScan: m.first !== null ? at(m.date, m.first, zone) : null,
        machineLastScan: m.last !== null ? at(m.date, m.last, zone) : null,
        machineMatch: m.result,
        machineCheckedAt: now,
        // Made absent by an earlier file that did not have the day: given back.
        ...(m.restore ? { status: m.restore, statusBeforeMachine: null } : {}),
      })
    }
    for (const m of missing) {
      await repo.updateDay(tx, m.id, {
        machineFirstScan: null,
        machineLastScan: null,
        machineMatch: 'not_on_machine',
        machineCheckedAt: now,
        ...(m.makeAbsent ? { status: 'absent' as const, statusBeforeMachine: m.status } : {}),
      })
    }

    await audit(ctx, {
      action: 'attendance.imported',
      entityType: 'import',
      details: {
        rows: replace.length + matches.length,
        replacedExisting: wouldOverwrite,
        ...(summary.machine
          ? { confirmed: summary.machine.confirmed, timeDiffers: summary.machine.timeDiffers, notOnMachine: summary.machine.notOnMachine, madeAbsent: summary.machine.madeAbsent, fromMachine: summary.machine.fromMachine }
          : {}),
      },
    }, tx)

    // Each person absent on a day that was not absent before is told — once,
    // with every such day of the file (client, 10 Oct 2026) — the days the
    // machine's rule made absent included.
    const absentOf = new Map<string, CalendarDate[]>()
    const absentDay = (employeeId: string, date: CalendarDate) => absentOf.set(employeeId, [...(absentOf.get(employeeId) ?? []), date])
    for (const row of replace) {
      if (row.status !== 'absent' || recordedOn.get(`${row.employee.id}|${row.date}`)?.status === 'absent') continue
      absentDay(row.employee.id, row.date)
    }
    for (const m of missing) if (m.makeAbsent) absentDay(m.employeeId, m.date)
    for (const [employeeId, absentDays] of absentOf) await tellAbsent(ctx, tx, employeeId, absentDays)
  })

  summary.imported = replace.length + matches.length

  logger.info('Biometric attendance imported', {
    by: ctx.userId,
    rows: summary.imported,
    overwritten: wouldOverwrite,
    ...(summary.machine ? { confirmed: summary.machine.confirmed, notOnMachine: summary.machine.notOnMachine } : {}),
  })

  return { dryRun: false, summary, rows }
}

/** Minutes from a day's midnight on the company's clock — past 1440 the next morning — as an instant. */
function at(date: string, minutes: number, zone: string): Date {
  return instantFor(date, minutes % 1440, zone, minutes >= 1440)
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
