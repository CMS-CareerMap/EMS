import type { AttendanceStatus } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { BadRequest, NotFound } from '../../platform/errors/AppError'
import { logger } from '../../platform/logger'
import {
  zonedToday,
  parseWallClock,
  isCalendarDate,
  fromDateColumn,
  type CalendarDate,
} from '../../domain/shared/dates'
import { hoursBetweenWallClock, classifyDay } from '../../domain/attendance/hours'
import * as repo from './attendance.repository'
import { withTransaction } from '../../platform/db/transaction'
import { audit } from '../audit/audit.service'
import { companyTimezone } from '../organization/organization.service'
import { assertDaysOpen } from '../payroll/payrollLock.service'

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
      const workedDays = total.daysPresent + total.daysHalf * 0.5

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
  const day = date ?? zonedToday(new Date(), await companyTimezone(ctx))
  if (!isCalendarDate(day)) throw BadRequest(`"${day}" is not a date`)

  const employees = await repo.dayRoster(ctx.db, ctx.scopeFor('attendance'), day)
  return { date: day, employees }
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

  const expectedHours = employee.shift ? Number(employee.shift.expectedHours) : null
  const breakMinutes = employee.shift?.breakMinutes ?? 0

  let hoursWorked: number | null = null
  let status = input.status
  let note = input.note ?? null

  const start = input.checkIn ? parseWallClock(input.checkIn) : null
  const end = input.checkOut ? parseWallClock(input.checkOut) : null

  if (input.checkIn && start === null) throw BadRequest('Check-in must look like 09:30')
  if (input.checkOut && end === null) throw BadRequest('Check-out must look like 18:30')

  if (start !== null && end !== null) {
    const result = hoursBetweenWallClock(start, end, breakMinutes)
    hoursWorked = result.hours
    if (result.warning) note = [note, result.warning].filter(Boolean).join(' · ')

    // HR chose a status, and the hours may disagree with it. The hours win for
    // present/half_day, because that is arithmetic — but an explicit
    // `on_leave` or `holiday` is a decision and is left alone.
    if (expectedHours && (status === 'present' || status === 'half_day')) {
      status = classifyDay(result.hours, expectedHours).status
    }
  }

  const row = await withTransaction(ctx.db, async (tx) => {
    const saved = await repo.upsertDay(tx, ctx.organizationId, {
      employeeId: input.employeeId,
      date: input.date,
      checkIn: start !== null ? wallClockToInstant(input.date, start, zone) : null,
      checkOut: end !== null ? wallClockToInstant(input.date, end, zone, end <= (start ?? 0)) : null,
      status,
      source: 'manual',
      hoursWorked,
      expectedHours,
      shiftId: employee.shiftId,
      note,
      markedByUserId: ctx.userId,
    })
    // A day entered or corrected by hand changes somebody's pay; who did it,
    // and to what, is kept.
    await audit(ctx, {
      action: 'attendance.marked',
      entityType: 'attendance',
      entityId: saved.id,
      details: { employeeId: input.employeeId, date: input.date, status, hoursWorked },
    }, tx)
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
