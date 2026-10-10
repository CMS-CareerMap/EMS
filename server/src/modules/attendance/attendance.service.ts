import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { logger } from '../../platform/logger'
import { isUniqueViolation } from '../../platform/db/errors'
import { zonedToday, toDateColumn, fromDateColumn, dayLabel, addCalendarDays, type CalendarDate } from '../../domain/shared/dates'
import { dayMinimums, hoursBetween } from '../../domain/attendance/hours'
import {
  arrivingForLastNight,
  forWorkedHalf,
  fullDayHoursFor,
  halfDayReason,
  isOvernight,
  measureInstants,
  nextCheckInOpens,
  overnightDayOpen,
  shiftRulesOf,
  stillAtWork,
  withHalfDayLeave,
  type ShiftRow,
} from '../../domain/attendance/shiftRules'
import {
  checkGeofence,
  geofenceMessage,
  type Fence,
  type GeofenceVerdict,
} from '../../domain/attendance/geofence'
import * as repo from './attendance.repository'
import { companyTimezone } from '../organization/organization.service'
import { withTransaction } from '../../platform/db/transaction'
import { tellAbsent } from './attendanceNotices'
import { findActiveGeofence, getCurrentPolicy } from '../settings/settings.repository'
import { awayOn, payPolicyOn, requestRules } from '../requests/requests.repository'
import type { WorkMode } from '@prisma/client'

/**
 * Punching in and out.
 *
 * The employee punches for THEMSELVES and nobody else. That is not a data
 * scope — it is identity: the row is keyed off `ctx.employeeId`, so there is no
 * employee id in the request for anyone to change. An endpoint that took one
 * would need a scope check; one that does not take one cannot be wrong.
 */

export interface PunchInput {
  /** Only sent by an `app`-mode employee. Absent for biometric and manual. */
  latitude?: number | undefined
  longitude?: number | undefined
  accuracyMeters?: number | undefined
  /** The browser's description of itself (client §31), kept short. Never trusted for anything. */
  device?: string | undefined
}

export interface PunchResult {
  attendanceId: string
  date: CalendarDate
  checkIn: Date | null
  checkOut: Date | null
  hoursWorked: number | null
  status: string
  geofence: { verified: boolean | null; distanceMeters: number | null; message: string } | null
  /** Where the day was worked from (client §33). */
  workMode: WorkMode | null
  /** Against the shift (client §34–35); null when not measured. */
  lateMinutes: number | null
  earlyLeavingMinutes: number | null
  overtimeMinutes: number | null
  /**
   * The unpaid break the day's own shift takes off its hours at check-out — the
   * shift the day was begun on, not the person's shift now. Null with none.
   */
  breakMinutes: number | null
  /**
   * The hours worked the day needs for a full day, as its check-out will grade
   * it (fullDayHoursFor) — the card counts down to it. Null with no shift.
   */
  fullDayHours: number | null
}

/** The caller's own employee record, plus the shift the day is measured against. */
async function loadSelf(ctx: AppContext) {
  if (!ctx.employeeId) {
    // An administrator with no HR record has nothing to punch. Saying so beats
    // a 500 from a null id further down.
    throw Forbidden('Your account has no employee record, so attendance does not apply to you.')
  }

  // A punch is always one's own day.
  const employee = await repo.findEmployeeWithShift(ctx.db, { scope: 'SELF', employeeId: ctx.employeeId }, ctx.employeeId)
  if (!employee) throw NotFound('Employee record not found')
  return employee
}

/**
 * Runs the geofence, or explains why it did not.
 *
 * Returns null when no check applies — a biometric employee is standing at the
 * machine, and asking their phone where they are would prove nothing.
 */
async function verifyLocation(
  ctx: AppContext,
  attendanceMode: string,
  input: PunchInput,
): Promise<{ verdict: GeofenceVerdict; fence: Fence } | null> {
  if (attendanceMode !== 'app') return null

  const location = await findActiveGeofence(ctx.db)

  // No fence configured is not a reason to refuse everybody. It is a reason to
  // record that no check was made, which `geofenceVerified: null` says exactly.
  if (!location) return null

  if (
    input.latitude === undefined ||
    input.longitude === undefined ||
    input.accuracyMeters === undefined
  ) {
    // FAIL CLOSED. A missing reading is refused, not waved through — otherwise
    // the geofence is bypassed by declining the browser permission prompt,
    // which is one click.
    throw Forbidden(
      'Location is required to check in. Allow location access in your browser and try again.',
    )
  }

  const fence: Fence = {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    radiusMeters: location.radiusMeters,
    maxAccuracyMeters: location.maxAccuracyMeters,
  }

  const reading = {
    latitude: input.latitude,
    longitude: input.longitude,
    accuracyMeters: input.accuracyMeters,
  }

  return { verdict: checkGeofence(reading, fence), fence }
}

/**
 * The day the caller is on: today's — or, while today's has not begun,
 * yesterday's (client §34):
 *   - still open: a 22:00 to 06:00 shift's morning, or a long day that ran
 *     past midnight (until three hours before the shift starts again), is
 *     checked out of on the next calendar day — never past twenty hours;
 *   - checked out of a night shift this morning, by somebody still on nights:
 *     that night stays the day shown until the next check-in opens, so a
 *     Check In pressed at 06:01 cannot take tonight's place.
 */
async function currentDay(ctx: AppContext, employee: { id: string; shift: ShiftRow | null }, today: CalendarDate, timezone: string, now: Date) {
  const row = await repo.findDayWithShift(ctx.db, employee.id, toDateColumn(today))
  if (row?.checkIn) return { row, date: today }
  const yesterday = addCalendarDays(today, -1)
  const before = await repo.findDayWithShift(ctx.db, employee.id, toDateColumn(yesterday))
  if (before?.checkIn) {
    // Today's has not begun (above), so yesterday's is the day while it is still open.
    if (stillAtWork({ date: yesterday, today, checkIn: before.checkIn, checkOut: before.checkOut, rules: shiftRulesOf(before.shift), timezone, now, checkedInToday: false })) {
      return { row: before, date: yesterday }
    }
    if (before.checkOut && isOvernight(shiftRulesOf(employee.shift)) && overnightDayOpen({ rules: shiftRulesOf(before.shift), date: yesterday, timezone, now })) {
      return { row: before, date: yesterday }
    }
  }
  return { row, date: today }
}

export async function punchIn(ctx: AppContext, input: PunchInput): Promise<PunchResult> {
  const employee = await loadSelf(ctx)
  // Never the machine clock's idea of a day. See domain/shared/dates.
  const timezone = await companyTimezone(ctx)

  // The app's check-in is for people on app attendance. Somebody on the
  // biometric machine or marked by HR has their day recorded there; an app
  // punch from them carries no location check at all, so it is refused rather
  // than taken on trust.
  if (employee.attendanceMode !== 'app') {
    throw Forbidden(employee.attendanceMode === 'biometric'
      ? 'Your attendance is recorded by the biometric machine, not checked in on the app.'
      : 'Your attendance is marked by HR, not checked in on the app.')
  }

  const now = new Date()
  const today = zonedToday(now, timezone)

  const { row: current, date: onDay } = await currentDay(ctx, employee, today, timezone, now)

  // Still on an earlier day: that one is closed by checking out, not by a new one.
  if (onDay !== today) {
    if (current?.checkOut) {
      const opens = nextCheckInOpens(shiftRulesOf(current.shift))
      throw Conflict(`Your night shift of ${dayLabel(onDay)} is checked out.${opens ? ` The next check-in opens at ${opens}.` : ''}`)
    }
    throw Conflict(`You are still checked in from ${dayLabel(onDay)}. Check out first.`)
  }

  // The client asked for ONE punch pair per day. A second check-in is a
  // double-tap or a confused user, not a new working day.
  if (current?.checkIn) {
    throw Conflict('You have already checked in today.')
  }

  // On a night shift, arriving between midnight and the shift's end is late
  // for last night's shift, not early for tonight's — filed under yesterday,
  // so tonight's check-in is still free.
  let date = today
  let existing = current
  if (arrivingForLastNight({ rules: shiftRulesOf(employee.shift), today, timezone, now })) {
    const yesterday = addCalendarDays(today, -1)
    const before = await repo.findDayWithShift(ctx.db, employee.id, toDateColumn(yesterday))
    if (!before?.checkIn) {
      date = yesterday
      existing = before
    }
  }

  // The employee lifecycle: a day before joining, or after the last working
  // day, is not a working day of theirs.
  const joined = fromDateColumn(employee.dateOfJoining)
  if (joined && date < joined) {
    throw Forbidden(`You join on ${dayLabel(joined)}. Checking in opens on your first day.`)
  }
  const lastDay = fromDateColumn(employee.lastWorkingDate)
  if (lastDay && date > lastDay) {
    throw Forbidden(`Your last working day was ${dayLabel(lastDay)}, so there is nothing to check in to.`)
  }

  // A day of approved leave is the leave. Somebody who comes in after all has
  // the leave reversed first — or the balance would be charged for a day worked.
  // A half day's leave leaves the other half to work, so that is checked in.
  const leave = await repo.approvedLeaveOn(ctx.db, employee.id, date)
  if (existing?.status === 'on_leave' && leave?.kind === 'full') {
    throw Conflict(`${date === today ? 'Today is' : `${dayLabel(date)} is`} a day of approved leave. If you are working, ask for the leave to be reversed first.`)
  }

  // Away from the office on an approved request, or remote by arrangement
  // (client §32–33): the office location is not asked for — unless the company
  // wants a location reading even when working from home.
  const away = await awayOn(ctx.db, employee.id, toDateColumn(date))
  const workMode: WorkMode = away === 'work_from_home' ? 'wfh' : away === 'on_duty' ? 'on_duty' : employee.workArrangement === 'remote' ? 'remote' : 'office'
  if (away && employee.attendanceMode === 'app' && (await requestRules(ctx.db, ctx.organizationId))?.wfhGpsRequired) {
    if (input.latitude === undefined || input.longitude === undefined) {
      throw Forbidden('Location is required to check in, even when working from home or on duty. Allow location access in your browser and try again.')
    }
  }
  const location = workMode === 'office' ? await verifyLocation(ctx, employee.attendanceMode, input) : null

  if (location) {
    const { verdict, fence } = location

    // Three outcomes, not two. "Unreliable" is refused with different words
    // from "outside", because the person can act on the difference: one means
    // go to the office, the other means move near a window.
    if (verdict.result !== 'inside') {
      logger.warn('Punch-in refused by geofence', {
        employeeId: employee.id,
        result: verdict.result,
        distanceMeters: verdict.distanceMeters,
        accuracyMeters: verdict.accuracyMeters,
      })
      throw Forbidden(geofenceMessage(verdict, fence))
    }
  }

  const verdict = location?.verdict
  const expectedHours = employee.shift ? Number(employee.shift.expectedHours) : null
  // How late, against the shift's start (client §34). The rest waits for the check-out.
  // A morning on leave starts the worked half at the middle of the shift.
  const shiftRules = shiftRulesOf(employee.shift)
  const { lateMinutes } = measureInstants({ rules: leave?.kind === 'half' ? forWorkedHalf(shiftRules, leave.session) : shiftRules, date, timezone, checkIn: now, checkOut: null, hoursWorked: null })

  const data = {
    checkIn: now,
    source: 'punch' as const,
    status: 'present' as const,
    shiftId: employee.shiftId,
    expectedHours,
    checkInLatitude: input.latitude ?? null,
    checkInLongitude: input.longitude ?? null,
    checkInDistanceMeters: verdict?.distanceMeters ?? null,
    checkInAccuracyMeters: verdict?.accuracyMeters ?? null,
    // Null, not false, when no check applied. "We did not look" and "we looked
    // and they were elsewhere" are different facts.
    geofenceVerified: verdict ? true : null,
    workMode,
    checkInDevice: input.device ? input.device.slice(0, 255) : null,
    lateMinutes,
  }

  const row = existing
    ? await repo.updateDay(ctx.db, existing.id, data)
    : await repo
        .createDay(ctx.db, { organizationId: ctx.organizationId, employeeId: employee.id, date: toDateColumn(date), ...data })
        .catch((err: unknown) => {
          // Two taps at once: the other one created today's row a moment ago,
          // and the unique index refused this one. That is a 409, not a 500.
          if (isUniqueViolation(err)) throw Conflict('You have already checked in today.')
          throw err
        })

  logger.info('Punched in', { employeeId: employee.id, date })

  return {
    attendanceId: row.id,
    date,
    checkIn: row.checkIn,
    checkOut: null,
    hoursWorked: null,
    status: row.status,
    geofence: verdict
      ? {
          verified: true,
          distanceMeters: verdict.distanceMeters,
          message: geofenceMessage(verdict, location!.fence),
        }
      : null,
    workMode,
    lateMinutes: row.lateMinutes,
    earlyLeavingMinutes: null,
    overtimeMinutes: null,
    breakMinutes: employee.shift?.breakMinutes ?? null,
    fullDayHours: fullDayHoursFor(shiftRules, expectedHours, leave?.kind === 'half' ? leave.session : null),
  }
}

export async function punchOut(ctx: AppContext): Promise<PunchResult> {
  const employee = await loadSelf(ctx)
  // Never the machine clock's idea of a day. See domain/shared/dates.
  const timezone = await companyTimezone(ctx)

  const now = new Date()
  // Today's day — or last night's, on an overnight shift that ends this morning.
  const { row, date: today } = await currentDay(ctx, employee, zonedToday(now, timezone), timezone, now)

  if (!row?.checkIn) {
    throw BadRequest('You have not checked in today, so there is nothing to check out of.')
  }

  if (row.checkOut) {
    throw Conflict('You have already checked out today.')
  }

  // NO GEOFENCE ON THE WAY OUT, deliberately. Somebody who has finished work
  // and walked to the bus stop before remembering must still be able to close
  // their day — refusing them produces a row with no check-out, which looks
  // like they never left and has to be corrected by hand.
  const breakMinutes = row.shift?.breakMinutes ?? 0
  const { hours, warning } = hoursBetween(row.checkIn, now, breakMinutes)

  // Measured against the shift the day began on, with the hours it was
  // expected to be when it began (both kept on the row); its break and rules
  // are read as the shift stands now.
  const rules = shiftRulesOf(row.shift)
  const asBegun = rules && row.expectedHours ? { ...rules, expectedHours: Number(row.expectedHours) } : null
  // Half the day on approved leave: the worked half is graded as a half.
  const leave = await repo.approvedLeaveOn(ctx.db, employee.id, today)
  const halfLeave = leave?.kind === 'half'
  const measure = measureInstants({
    rules: leave?.kind === 'half' ? forWorkedHalf(asBegun, leave.session) : asBegun,
    date: today,
    timezone,
    checkIn: row.checkIn,
    checkOut: now,
    hoursWorked: hours,
  })
  const classification = halfLeave ? withHalfDayLeave(measure.classification) : measure.classification
  const why = [warning, halfDayReason(measure)].filter(Boolean)

  const updated = await withTransaction(ctx.db, async (tx) => {
    // Closed only if still open: two taps at once close the day once, and tell once.
    const day = await repo.closeDayIf(tx, row.id, {
      checkOut: now,
      hoursWorked: hours,
      lateMinutes: measure.lateMinutes,
      earlyLeavingMinutes: measure.earlyLeavingMinutes,
      overtimeMinutes: measure.overtimeMinutes,
      ...(classification ? { status: classification.status } : {}),
      ...(why.length ? { note: [row.note, ...why].filter(Boolean).join(' · ') } : {}),
    })
    if (!day) throw Conflict('You have already checked out today.')
    // Short of a half day: the day is absent — told, with the way to apply leave for it (client, 10 Oct 2026).
    // With the check-out it came from: neither is kept without the other.
    if (day.status === 'absent' && row.status !== 'absent') await tellAbsent(ctx, tx, employee.id, [today], { includeActor: true })
    return day
  })

  logger.info('Punched out', { employeeId: employee.id, date: today, hours })

  return {
    attendanceId: updated.id,
    date: today,
    checkIn: updated.checkIn,
    checkOut: updated.checkOut,
    hoursWorked: hours,
    status: updated.status,
    geofence: null,
    workMode: updated.workMode,
    lateMinutes: updated.lateMinutes,
    earlyLeavingMinutes: updated.earlyLeavingMinutes,
    overtimeMinutes: updated.overtimeMinutes,
    breakMinutes: row.shift?.breakMinutes ?? null,
    fullDayHours: fullDayHoursFor(rules, row.expectedHours ? Number(row.expectedHours) : null, leave?.kind === 'half' ? leave.session : null),
  }
}

/** Today's row for the caller, so the UI knows which button to show. */
export async function myToday(ctx: AppContext): Promise<PunchResult | null> {
  const employee = await loadSelf(ctx)
  // Never the machine clock's idea of a day. See domain/shared/dates.
  const timezone = await companyTimezone(ctx)
  const now = new Date()
  // Last night's shift, until it is checked out of, is still the day to show.
  const { row, date: today } = await currentDay(ctx, employee, zonedToday(now, timezone), timezone, now)
  if (!row) return null
  // While the day is open, the hours a full day needs: half of them on a day half on leave.
  const leave = row.checkIn && !row.checkOut ? await repo.approvedLeaveOn(ctx.db, employee.id, today) : null
  const fullDayHours = fullDayHoursFor(shiftRulesOf(row.shift), row.expectedHours ? Number(row.expectedHours) : null, leave?.kind === 'half' ? leave.session : null)

  return {
    attendanceId: row.id,
    date: today,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    hoursWorked: row.hoursWorked ? Number(row.hoursWorked) : null,
    status: row.status,
    geofence:
      row.geofenceVerified === null
        ? null
        : {
            verified: row.geofenceVerified,
            distanceMeters: row.checkInDistanceMeters,
            message: row.geofenceVerified ? 'Location confirmed' : 'Location not confirmed',
          },
    workMode: row.workMode,
    lateMinutes: row.lateMinutes,
    earlyLeavingMinutes: row.earlyLeavingMinutes,
    overtimeMinutes: row.overtimeMinutes,
    breakMinutes: row.shift?.breakMinutes ?? null,
    fullDayHours,
  }
}

export interface Workplace {
  /** Where today is worked from, as check-in will record it (client §33). */
  workMode: WorkMode
  /** Whether check-in will ask for a location reading — the app asks the browser only then. */
  locationNeeded: boolean
  /** Whether the company pays overtime (client §35) — the app offers a claim only then. */
  overtimeEnabled: boolean
  /**
   * Their shift as it stands, for the day's timeline and the Timings card; null
   * with none set. With the hours worked a full and a half day need on it (client,
   * 8 Oct 2026: people should see the rule their day is marked by).
   */
  shift: { name: string; startTime: string; endTime: string; breakMinutes: number; fullDayHours: number; halfDayHours: number } | null
  /** The company's weekly off days, 0 = Sunday. */
  weeklyOffDays: number[]
  /** The day they joined: their attendance log starts there, not with days before it shown as missed. */
  dateOfJoining: CalendarDate | null
}

/** Today's workplace for the caller: office, or away on an approved request, or remote. */
export async function myWorkplace(ctx: AppContext): Promise<Workplace> {
  const employee = await loadSelf(ctx)
  const today = zonedToday(new Date(), await companyTimezone(ctx))
  const [away, payPolicy, policy] = await Promise.all([
    awayOn(ctx.db, employee.id, toDateColumn(today)),
    payPolicyOn(ctx.db, toDateColumn(today)),
    getCurrentPolicy(ctx.db),
  ])
  const workMode: WorkMode = away === 'work_from_home' ? 'wfh' : away === 'on_duty' ? 'on_duty' : employee.workArrangement === 'remote' ? 'remote' : 'office'
  const overtimeEnabled = Boolean(payPolicy?.overtimeEnabled)
  const s = employee.shift
  const minimums = s
    ? dayMinimums(Number(s.expectedHours), {
        full: s.minFullDayHours === null ? null : Number(s.minFullDayHours),
        half: s.minHalfDayHours === null ? null : Number(s.minHalfDayHours),
      })
    : null
  const about = {
    overtimeEnabled,
    shift: s && minimums
      ? { name: s.name, startTime: s.startTime, endTime: s.endTime, breakMinutes: s.breakMinutes, fullDayHours: minimums.full, halfDayHours: minimums.half }
      : null,
    weeklyOffDays: policy?.weeklyOffDays ?? [0],
    dateOfJoining: fromDateColumn(employee.dateOfJoining),
  }
  if (employee.attendanceMode !== 'app') return { workMode, locationNeeded: false, ...about }
  if (workMode === 'office') return { workMode, locationNeeded: Boolean(await findActiveGeofence(ctx.db)), ...about }
  const gpsWhenAway = Boolean(away && (await requestRules(ctx.db, ctx.organizationId))?.wfhGpsRequired)
  return { workMode, locationNeeded: gpsWhenAway, ...about }
}
