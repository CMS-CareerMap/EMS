import type { AttendanceStatus } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { logger } from '../../platform/logger'
import {
  zonedToday,
  parseWallClock,
  isCalendarDate,
  fromDateColumn,
  toDateColumn,
  dayLabel,
  addCalendarDays,
  type CalendarDate,
} from '../../domain/shared/dates'
import { listDaysOffNamed } from '../holidays/holidays.repository'
import { workWeekOf } from '../settings/workWeek.repository'
import { dayEndsAt, noCheckOut } from '../../domain/attendance/noCheckIn'
import { isWeeklyOff } from '../../domain/shared/workWeek'
import { hoursBetween, hoursBetweenWallClock } from '../../domain/attendance/hours'
import {
  forWorkedHalf,
  gradedBy,
  halfDayReason,
  marksOf,
  measureInstants,
  shiftRulesOf,
  stillAtWork,
  withHalfDayLeave,
  type DayMeasure,
} from '../../domain/attendance/shiftRules'
import * as repo from './attendance.repository'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { audit } from '../audit/audit.service'
import { tellAbsent } from './attendanceNotices'
import { companyTimezone } from '../organization/organization.service'
import { assertDaysOpen } from '../payroll/payrollLock.service'
import { assertWorkGoesUp, checkWork, loadWork } from '../organization/workRules.service'

/**
 * Attendance as HR sees it: other people's days.
 *
 * Kept apart from the punch flow on purpose. Punching is something an employee
 * does to their own row and needs no employee id at all; everything here takes
 * one, and therefore needs a scope check on every call. Two different shapes of
 * risk, two files.
 */

export interface ListInput {
  date?: string | undefined
  year?: number | undefined
  month?: number | undefined
  employeeId?: string | undefined
  status?: AttendanceStatus | undefined
  departmentId?: string | undefined
}

export async function listAttendance(ctx: AppContext, input: ListInput) {
  if (input.date && !isCalendarDate(input.date)) {
    throw BadRequest(`"${input.date}" is not a date`)
  }

  return repo.list(ctx.db, ctx.scopeFor('attendance'), input)
}

export interface MonthlySummaryResult {
  year: number
  month: number
  employees: {
    employeeId: string
    employeeCode: string
    fullName: string
    totalHours: number
    expectedHours: number
    daysPresent: number
    daysHalf: number
    daysAbsent: number
    daysOnLeave: number
  }[]
  /** Every employee's hours added together, for the company figure. */
  grandTotalHours: number
}

export interface MonthCalendar {
  year: number
  month: number
  /** Every day off in the month, in order: a holiday by its name, or a weekly off. */
  daysOff: { date: CalendarDate; kind: 'holiday' | 'weekly_off'; name: string | null }[]
}

/**
 * The company's days off in a month, for the attendance calendar.
 *
 * Nobody marks a holiday or a weekly off, so a calendar drawn from attendance
 * rows alone showed those days blank — as if the person had simply not come.
 * A holiday wins over a weekly off on the same day, as the dashboard and the
 * leave count decide it.
 */
export async function monthCalendar(ctx: AppContext, year: number, month: number): Promise<MonthCalendar> {
  if (month < 1 || month > 12) throw BadRequest('Month must be between 1 and 12')

  const first = `${year}-${String(month).padStart(2, '0')}-01` as CalendarDate
  const last = fromDateColumn(new Date(Date.UTC(year, month, 0))) as CalendarDate
  const [week, rows] = await Promise.all([
    workWeekOf(ctx.db),
    listDaysOffNamed(ctx.db, toDateColumn(first), toDateColumn(last)),
  ])

  // Each day by the working week in force on it (client, 25 Oct 2026) — as
  // leave and payroll count it: weekly offs changed from the 25th make the
  // 31st off here too, and leave the days before as they were.
  const holidays = new Map(rows.filter((r) => r.type === 'public').map((r) => [fromDateColumn(r.date), r.name]))
  const offRows = new Set(rows.filter((r) => r.type === 'weekly_off').map((r) => fromDateColumn(r.date)))

  const daysOff: MonthCalendar['daysOff'] = []
  for (let day = first; day <= last; day = addCalendarDays(day, 1)) {
    if (holidays.has(day)) daysOff.push({ date: day, kind: 'holiday', name: holidays.get(day) ?? null })
    else if (isWeeklyOff(week, day) || offRows.has(day)) daysOff.push({ date: day, kind: 'weekly_off', name: null })
  }

  return { year, month, daysOff }
}

/**
 * The monthly hours report the client asked for.
 *
 * "month ke last me vo kitna hour job kiya vo total bhi dikhe" — so this is the
 * number that has to be right, and it is aggregated in Postgres rather than
 * added up from whatever rows a page happened to load.
 */
export async function monthlySummary(
  ctx: AppContext,
  year: number,
  month: number,
  employeeId?: string,
): Promise<MonthlySummaryResult> {
  if (month < 1 || month > 12) throw BadRequest('Month must be between 1 and 12')

  const scope = ctx.scopeFor('attendance')
  const totals = await repo.monthlyTotals(ctx.db, scope, year, month, employeeId)

  // Names for the ids the aggregate returned. A separate query because the
  // aggregate groups on employeeId and cannot carry a joined name with it.
  const employees = await repo.namesForTotals(ctx.db, totals.map((t) => t.employeeId))

  const byId = new Map(employees.map((e) => [e.id, e]))

  const rows = totals
    .map((total) => {
      const employee = byId.get(total.employeeId)
      if (!employee) return null

      const perDay = employee.shift ? Number(employee.shift.expectedHours) : 0
      // The days whose hours are known, as the person's month counts them (domain/attendance/monthSoFar).
      const workedDays = total.daysPresentTimed + total.daysHalfTimed * 0.5

      return {
        employeeId: total.employeeId,
        employeeCode: employee.employeeCode,
        fullName: employee.fullName,
        totalHours: total.totalHours,
        // What they were expected to work for the days they were actually
        // here — not for the whole month, which would count leave as shortfall.
        expectedHours: Math.round(perDay * workedDays * 100) / 100,
        daysPresent: total.daysPresent,
        daysHalf: total.daysHalf,
        daysAbsent: total.daysAbsent,
        daysOnLeave: total.daysOnLeave,
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => a.fullName.localeCompare(b.fullName))

  return {
    year,
    month,
    employees: rows,
    grandTotalHours: Math.round(rows.reduce((sum, r) => sum + r.totalHours, 0) * 100) / 100,
  }
}

export async function todaySummary(ctx: AppContext, date?: string) {
  const day = date ?? zonedToday(new Date(), await companyTimezone(ctx))
  if (!isCalendarDate(day)) throw BadRequest(`"${day}" is not a date`)

  return repo.daySummary(ctx.db, ctx.scopeFor('attendance'), day)
}

/**
 * One day's roster: everybody in scope who was employed that day, with their
 * row or none. The company's today unless a date is given — never UTC's.
 */
export async function dayRoster(ctx: AppContext, date?: string) {
  const timezone = await companyTimezone(ctx)
  const now = new Date()
  const today = zonedToday(now, timezone)
  const day = date ?? today
  if (!isCalendarDate(day)) throw BadRequest(`"${day}" is not a date`)

  const [employees, week, holidays] = await Promise.all([
    repo.dayRoster(ctx.db, ctx.scopeFor('attendance'), day),
    workWeekOf(ctx.db),
    listDaysOffNamed(ctx.db, toDateColumn(day), toDateColumn(day)),
  ])
  // The company's day off — a weekly off by the week in force on it, or a holiday: nobody is "no check-in" on it.
  const dayOff = isWeeklyOff(week, day) || holidays.length > 0

  // Who is at work now, by the rule their own card counts by — so whoever
  // watches the roster sees the time run as they do (client, 9 Oct 2026). Only
  // people who check in on the app have that card: somebody on the biometric
  // machine, or marked by HR, is not counted on. Only today's open days and
  // yesterday's can be; yesterday's only for somebody not checked in today.
  const yesterday = addCalendarDays(today, -1)
  const punches = employees.filter((e) => e.attendanceMode === 'app')
  const openIds = punches.filter((e) => e.attendance[0]?.checkIn && !e.attendance[0].checkOut).map((e) => e.id)
  const checkedInToday = day === yesterday ? await repo.checkedInOn(ctx.db, openIds, today) : new Set<string>()
  const atWork = new Set(punches.filter((e) => {
    const row = e.attendance[0]
    return row && stillAtWork({
      date: day, today, checkIn: row.checkIn, checkOut: row.checkOut, rules: shiftRulesOf(row.shift),
      timezone, now, checkedInToday: checkedInToday.has(e.id),
    })
  }).map((e) => e.id))
  // Whose day the caller may mark (Day 22: own work goes up the tree), and if
  // not, whom it goes to — asked only of somebody who marks at all.
  const work = ctx.can('attendance:mark') ? await loadWork(ctx.db, ctx.organizationId, 'attendance') : null
  const markGoesTo = new Map<string, string>()
  if (work) {
    for (const e of employees) {
      const check = checkWork(ctx, work, e.id)
      if (!check.allowed) markGoesTo.set(e.id, check.ask ?? 'the Super Admin')
    }
  }
  // Whose day is over — their shift ended, a night shift the next morning (client, 25 Oct 2026):
  // nothing in it by then is "no check-in", and an open one is a check-out not made.
  const dayOver = new Set(employees.filter((e) => now.getTime() >= dayEndsAt(day, e.attendance[0]?.shift ?? e.shift, timezone).getTime()).map((e) => e.id))
  // In and never out, no longer their day: "No out" — the one rule for the roster and its export.
  const noOut = new Set(employees.filter((e) => {
    const row = e.attendance[0]
    return row && noCheckOut({
      checkedIn: row.checkIn !== null, checkedOut: row.checkOut !== null, hoursWorked: row.hoursWorked === null ? null : Number(row.hoursWorked),
      source: row.source, atWork: atWork.has(e.id), isToday: day === today, dayOver: dayOver.has(e.id),
    })
  }).map((e) => e.id))
  return { date: day, employees, markGoesTo, atWork, dayOver, dayOff, noOut, now }
}

/** A day before somebody joined, or after their last working day, is no working day of theirs. */
function assertEmployedOn(employee: { fullName: string; dateOfJoining: Date | null; lastWorkingDate: Date | null }, date: CalendarDate) {
  const joined = fromDateColumn(employee.dateOfJoining)
  if (joined && date < joined) throw BadRequest(`${employee.fullName} joined on ${dayLabel(joined)}, after ${dayLabel(date)}.`)
  const last = fromDateColumn(employee.lastWorkingDate)
  if (last && date > last) throw BadRequest(`${employee.fullName}’s last working day was ${dayLabel(last)}, before ${dayLabel(date)}.`)
}

/**
 * Approved leave on a day being written. A whole day of it is the leave:
 * recording work over it would charge the balance for a day worked, so the
 * leave is reversed first. Half a day leaves the other half — graded as a half.
 */
async function halfLeaveOn(db: TxDb, employeeId: string, date: CalendarDate, recorded: AttendanceStatus | undefined) {
  const leave = await repo.approvedLeaveOn(db, employeeId, date)
  if (leave?.kind === 'full' && recorded === 'on_leave') {
    throw Conflict(`${dayLabel(date)} is a day of approved leave. Reverse the leave first if it was worked.`)
  }
  // Which half is on leave, so the worked half is measured from its own start or end.
  return leave?.kind === 'half' ? { session: leave.session } : null
}

export interface MarkInput {
  employeeId: string
  date: CalendarDate
  status: AttendanceStatus
  /** Wall-clock "HH:mm" in the company's timezone, as HR types them. */
  checkIn?: string | null | undefined
  checkOut?: string | null | undefined
  note?: string | null | undefined
}

/**
 * HR recording somebody else's day, or correcting one.
 *
 * Marked `source = manual` whatever it replaces, because that is the truth: a
 * person entered it. An amended punch row stops claiming to be a punch — the
 * whole reason `source` exists is so nobody has to guess later who put a row
 * there.
 */
export async function markAttendance(ctx: AppContext, input: MarkInput) {
  if (!isCalendarDate(input.date)) throw BadRequest(`"${input.date}" is not a date`)

  const zone = await companyTimezone(ctx)
  const today = zonedToday(new Date(), zone)

  // A day that has not happened cannot have been worked. Without this, a typo
  // in the year quietly creates attendance in 2027.
  if (input.date > today) {
    throw BadRequest('You cannot mark attendance for a day in the future.')
  }

  // A day inside an approved or paid payroll is part of a signed-off month.
  await assertDaysOpen(ctx, [input.date], 'a change to attendance on that day')

  const employee = await repo.findEmployeeWithShift(ctx.db, ctx.scopeFor('attendance'), input.employeeId)
  if (!employee) throw NotFound('Employee not found')
  // Your own attendance — or that of somebody who marks attendance too — is
  // marked and corrected by the people above them in the company tree (Day 22).
  await assertWorkGoesUp(ctx, ctx.db, 'attendance', input.employeeId)
  assertEmployedOn(employee, input.date)

  // A day already recorded is graded against the shift it was recorded on; a
  // new one against the person's shift now.
  const existing = await repo.findDayWithShift(ctx.db, input.employeeId, toDateColumn(input.date))
  const halfLeave = await halfLeaveOn(ctx.db, input.employeeId, input.date, existing?.status)
  const { rules: dayRules, expectedHours, breakMinutes, shiftId } = gradedBy(existing, employee)

  let hoursWorked: number | null = null
  let status = input.status
  let note = input.note ?? null

  const start = input.checkIn ? parseWallClock(input.checkIn) : null
  const end = input.checkOut ? parseWallClock(input.checkOut) : null

  if (input.checkIn && start === null) throw BadRequest('Check-in must look like 09:30')
  if (input.checkOut && end === null) throw BadRequest('Check-out must look like 18:30')

  const checkInAt = start !== null ? wallClockToInstant(input.date, start, zone) : null
  const checkOutAt = end !== null ? wallClockToInstant(input.date, end, zone, end <= (start ?? 0)) : null

  if (start !== null && end !== null) {
    const result = hoursBetweenWallClock(start, end, breakMinutes)
    hoursWorked = result.hours
    if (result.warning) note = [note, result.warning].filter(Boolean).join(' · ')
  }

  // Late, early and overtime against the shift (client §34–35). A day marked
  // on leave or a holiday is a decision, not a working day: nothing to measure.
  const worked = status === 'present' || status === 'half_day'
  const measure: DayMeasure | null = worked
    ? measureInstants({ rules: halfLeave ? forWorkedHalf(dayRules, halfLeave.session) : dayRules, date: input.date, timezone: zone, checkIn: checkInAt, checkOut: checkOutAt, hoursWorked })
    : null
  // HR chose a status, and the hours may disagree with it. The hours win for
  // present/half_day, because that is arithmetic — but an explicit
  // `on_leave` or `holiday` is a decision and is left alone.
  const classification = halfLeave ? withHalfDayLeave(measure?.classification ?? null) : measure?.classification ?? null
  if (measure && classification) {
    status = classification.status
    const why = halfDayReason(measure)
    if (why) note = [note, why].filter(Boolean).join(' · ')
  }

  const row = await withTransaction(ctx.db, async (tx) => {
    // Again under the month's payroll lock: a month approved since the check above is refused, not missed.
    await assertDaysOpen(ctx, [input.date], 'a change to attendance on that day', tx)
    // Marking a day already recorded — a punch, or an earlier entry — is
    // correcting it, which is its own tick on the Roles screen.
    if (!ctx.can('attendance:update') && (await repo.dayRecorded(tx, input.employeeId, input.date))) {
      throw Forbidden('This day is already recorded. Changing it needs “Correct attendance”, which your role does not have.')
    }
    const before = await repo.findDay(tx, input.employeeId, toDateColumn(input.date))
    const saved = await repo.upsertDay(tx, ctx.organizationId, {
      employeeId: input.employeeId,
      date: input.date,
      checkIn: checkInAt,
      checkOut: checkOutAt,
      status,
      source: 'manual',
      hoursWorked,
      expectedHours,
      shiftId,
      note,
      markedByUserId: ctx.userId,
      ...(measure ? marksOf(measure) : {}),
    })
    // A day entered or corrected by hand changes somebody's pay; who did it,
    // and to what, is kept.
    await audit(ctx, {
      action: 'attendance.marked',
      entityType: 'attendance',
      entityId: saved.id,
      details: { employeeId: input.employeeId, date: input.date, status, hoursWorked },
    }, tx)
    // Marked absent now, and not before: they are told, with the way to apply leave for it.
    if (status === 'absent' && before?.status !== 'absent') await tellAbsent(ctx, tx, input.employeeId, [input.date])
    return saved
  })

  logger.info('Attendance marked manually', {
    by: ctx.userId,
    employeeId: input.employeeId,
    date: input.date,
    status,
  })

  return row
}

export interface MarkManyInput {
  date: CalendarDate
  employeeIds: string[]
  status: AttendanceStatus
  note: string
}

/**
 * Several people's day at once (client, 25 Oct 2026) — a morning the app was
 * down, an office closed for the rain: ONLY the people ticked, each marked
 * exactly as marking them one by one would — the same reach, the same payroll
 * lock, the same audit row, the same notice. Somebody who cannot be marked is
 * named with the reason, and the rest are still marked.
 *
 * A day with a check-in is left out: marked here it would lose its times,
 * which are the evidence of the day. It is opened and changed on its own.
 */
export async function markMany(ctx: AppContext, input: MarkManyInput) {
  const marked: string[] = []
  const refused: { employeeId: string; reason: string }[] = []
  for (const employeeId of [...new Set(input.employeeIds)]) {
    try {
      // Outside the caller's reach is "not found", before anything is said of the day.
      if (!(await repo.findEmployeeWithShift(ctx.db, ctx.scopeFor('attendance'), employeeId))) throw NotFound('Employee not found')
      const existing = await repo.findDay(ctx.db, employeeId, toDateColumn(input.date))
      if (existing?.checkIn) throw Conflict('Checked in that day: open their day to change it, so its times are kept.')
      await markAttendance(ctx, { employeeId, date: input.date, status: input.status, note: input.note })
      marked.push(employeeId)
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      refused.push({ employeeId, reason: err.message })
    }
  }
  logger.info('Attendance marked for several people', { by: ctx.userId, date: input.date, status: input.status, marked: marked.length, refused: refused.length })
  return { marked, refused }
}

/**
 * Writes a day as an approved attendance correction request asked (client
 * §29), inside the approver's transaction. A time the employee left out stays
 * as it was recorded — somebody who forgot only to check out corrects only the
 * check-out. The hours and the status are worked out as for a day HR marks.
 * The request service has already checked the day is theirs, worked, and open.
 */
export async function writeCorrectedDay(
  tx: TxDb,
  ctx: AppContext,
  input: { employeeId: string; date: CalendarDate; checkIn: string | null; checkOut: string | null; note: string },
) {
  const zone = await companyTimezone(ctx)
  const employee = await repo.findEmployeeWithShift(tx, { scope: 'ORGANIZATION', employeeId: null }, input.employeeId)
  if (!employee) throw NotFound('Employee not found')
  const existing = await repo.findDayWithShift(tx, input.employeeId, toDateColumn(input.date))
  // Approved leave is the leave: a correction cannot turn a whole day of it
  // into a short working day and take pay for a day already taken from the
  // balance. Half a day of it leaves the other half, graded as a half.
  const halfLeave = await halfLeaveOn(tx, input.employeeId, input.date, existing?.status)
  if (existing?.status === 'on_leave' && !halfLeave) {
    throw Conflict(`${dayLabel(input.date)} is marked as leave. Cancel or reverse the leave first if it was worked.`)
  }
  const { rules: dayRules, expectedHours, breakMinutes, shiftId } = gradedBy(existing, employee)

  const start = input.checkIn ? parseWallClock(input.checkIn) : null
  const end = input.checkOut ? parseWallClock(input.checkOut) : null
  const checkIn = start !== null ? wallClockToInstant(input.date, start, zone) : (existing?.checkIn ?? null)
  let checkOut = end !== null
    ? wallClockToInstant(input.date, end, zone, start !== null && end <= start)
    : (existing?.checkOut ?? null)
  // A night shift's check-out alone, at or before the check-in on record, is
  // the next morning — as a typed 22:00 to 06:00 is.
  if (end !== null && start === null && checkIn && checkOut && checkOut <= checkIn) {
    checkOut = wallClockToInstant(input.date, end, zone, true)
  }
  if (checkIn && checkOut && checkOut <= checkIn) throw BadRequest('The check-out must be after the check-in.')

  let hoursWorked: number | null = null
  // A holiday or weekly off worked stays one — the times are recorded, the
  // day is not graded as a working day it never was (as marking keeps it).
  const offDay = existing?.status === 'holiday' || existing?.status === 'weekly_off'
  let status: AttendanceStatus = offDay ? existing.status : 'present'
  let note = input.note
  if (checkIn && checkOut) {
    const result = hoursBetween(checkIn, checkOut, breakMinutes)
    hoursWorked = result.hours
    if (result.warning) note = `${note} · ${result.warning}`
  }
  const measure = measureInstants({ rules: halfLeave ? forWorkedHalf(dayRules, halfLeave.session) : dayRules, date: input.date, timezone: zone, checkIn, checkOut, hoursWorked })
  const classification = halfLeave ? withHalfDayLeave(measure.classification) : measure.classification
  if (classification && !offDay) {
    status = classification.status
    const why = halfDayReason(measure)
    if (why) note = `${note} · ${why}`
  }

  const saved = await repo.upsertDay(tx, ctx.organizationId, {
    employeeId: input.employeeId,
    date: input.date,
    checkIn,
    checkOut,
    status,
    source: 'correction',
    hoursWorked,
    expectedHours,
    shiftId,
    note,
    markedByUserId: ctx.userId,
    ...(offDay ? {} : marksOf(measure)),
  })
  await audit(ctx, {
    action: 'attendance.marked',
    entityType: 'attendance',
    entityId: saved.id,
    details: { employeeId: input.employeeId, date: input.date, status, hoursWorked, via: 'correction_request' },
  }, tx)
  // Corrected to short of a half day: absent now, and told so — with the way to apply leave for it.
  if (status === 'absent' && existing?.status !== 'absent') await tellAbsent(ctx, tx, input.employeeId, [input.date], { includeActor: true })
  return { id: saved.id, status, hoursWorked }
}

/**
 * Turns "09:30 on 2026-04-15, in Asia/Kolkata" into an instant.
 *
 * Built by finding the offset that timezone had on that date rather than by
 * assuming +05:30, so it stays correct for the UK and US employees the client
 * wants payslips for — both of which change offset twice a year.
 */
function wallClockToInstant(
  date: CalendarDate,
  minutes: number,
  zone: string,
  nextDay = false,
): Date {
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mins = String(minutes % 60).padStart(2, '0')

  const base = new Date(`${date}T${hours}:${mins}:00Z`)
  const shifted = nextDay ? new Date(base.getTime() + 86_400_000) : base

  // What that UTC instant reads as in the target zone, and therefore how far
  // out it is. Subtracting the difference lands on the intended wall clock.
  const asZoned = new Date(shifted.toLocaleString('en-US', { timeZone: zone }))
  const asUtc = new Date(shifted.toLocaleString('en-US', { timeZone: 'UTC' }))
  const offset = asZoned.getTime() - asUtc.getTime()

  return new Date(shifted.getTime() - offset)
}

/**
 * Amending one row — regularisation.
 *
 * Goes through the same path as marking, so an amendment cannot produce a shape
 * that a fresh entry could not. It also re-reads the row through the scope
 * first, so a manager cannot amend somebody outside their team by id.
 */
export async function amendAttendance(
  ctx: AppContext,
  id: string,
  input: Omit<MarkInput, 'employeeId' | 'date'>,
) {
  const existing = await repo.findById(ctx.db, ctx.scopeFor('attendance'), id)
  if (!existing) throw NotFound('Attendance record not found')

  return markAttendance(ctx, {
    ...input,
    employeeId: existing.employeeId,
    date: fromDateColumn(existing.date),
  })
}
