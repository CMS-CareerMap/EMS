import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { logger } from '../../platform/logger'
import { isUniqueViolation } from '../../platform/db/errors'
import { zonedToday, toDateColumn, fromDateColumn, dayLabel, type CalendarDate } from '../../domain/shared/dates'
import { hoursBetween, classifyDay } from '../../domain/attendance/hours'
import {
  checkGeofence,
  geofenceMessage,
  type Fence,
  type GeofenceVerdict,
} from '../../domain/attendance/geofence'
import * as repo from './attendance.repository'
import { companyTimezone } from '../organization/organization.service'
import { findActiveGeofence } from '../settings/settings.repository'

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
}

export interface PunchResult {
  attendanceId: string
  date: CalendarDate
  checkIn: Date | null
  checkOut: Date | null
  hoursWorked: number | null
  status: string
  geofence: { verified: boolean | null; distanceMeters: number | null; message: string } | null
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

export async function punchIn(ctx: AppContext, input: PunchInput): Promise<PunchResult> {
  const employee = await loadSelf(ctx)
  // Never the machine clock's idea of a day. See domain/shared/dates.
  const timezone = await companyTimezone(ctx)

  const now = new Date()
  const today = zonedToday(now, timezone)

  // The employee lifecycle: a day before joining, or after the last working
  // day, is not a working day of theirs.
  const joined = fromDateColumn(employee.dateOfJoining)
  if (joined && today < joined) {
    throw Forbidden(`You join on ${dayLabel(joined)}. Checking in opens on your first day.`)
  }
  const lastDay = fromDateColumn(employee.lastWorkingDate)
  if (lastDay && today > lastDay) {
    throw Forbidden(`Your last working day was ${dayLabel(lastDay)}, so there is nothing to check in to.`)
  }

  const existing = await repo.findDay(ctx.db, employee.id, toDateColumn(today))

  // The client asked for ONE punch pair per day. A second check-in is a
  // double-tap or a confused user, not a new working day.
  if (existing?.checkIn) {
    throw Conflict('You have already checked in today.')
  }

  const location = await verifyLocation(ctx, employee.attendanceMode, input)

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
  }

  const row = existing
    ? await repo.updateDay(ctx.db, existing.id, data)
    : await repo
        .createDay(ctx.db, { organizationId: ctx.organizationId, employeeId: employee.id, date: toDateColumn(today), ...data })
        .catch((err: unknown) => {
          // Two taps at once: the other one created today's row a moment ago,
          // and the unique index refused this one. That is a 409, not a 500.
          if (isUniqueViolation(err)) throw Conflict('You have already checked in today.')
          throw err
        })

  logger.info('Punched in', { employeeId: employee.id, date: today })

  return {
    attendanceId: row.id,
    date: today,
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
  }
}

export async function punchOut(ctx: AppContext): Promise<PunchResult> {
  const employee = await loadSelf(ctx)
  // Never the machine clock's idea of a day. See domain/shared/dates.
  const timezone = await companyTimezone(ctx)

  const now = new Date()
  const today = zonedToday(now, timezone)

  const row = await repo.findDayWithShift(ctx.db, employee.id, toDateColumn(today))

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

  const expected = row.expectedHours ? Number(row.expectedHours) : 0
  const classification = expected > 0 ? classifyDay(hours, expected) : null

  const updated = await repo.updateDay(ctx.db, row.id, {
    checkOut: now,
    hoursWorked: hours,
    ...(classification ? { status: classification.status } : {}),
    ...(warning ? { note: [row.note, warning].filter(Boolean).join(' · ') } : {}),
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
  }
}

/** Today's row for the caller, so the UI knows which button to show. */
export async function myToday(ctx: AppContext): Promise<PunchResult | null> {
  const employee = await loadSelf(ctx)
  // Never the machine clock's idea of a day. See domain/shared/dates.
  const timezone = await companyTimezone(ctx)
  const today = zonedToday(new Date(), timezone)

  const row = await repo.findDay(ctx.db, employee.id, toDateColumn(today))
  if (!row) return null

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
  }
}
