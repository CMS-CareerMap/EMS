import type { RequestHandler } from 'express'
import { punchIn, punchOut, myToday, myWorkplace, type PunchResult } from '../../modules/attendance/attendance.service'
import { punchInSchema } from '../validators/attendance.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { isoInstant } from '../../domain/shared/dates'

function payload(result: PunchResult) {
  return {
    id: result.attendanceId,
    date: result.date,
    check_in: isoInstant(result.checkIn),
    check_out: isoInstant(result.checkOut),
    hours_worked: result.hoursWorked,
    status: result.status,
    work_mode: result.workMode,
    late_minutes: result.lateMinutes,
    early_leaving_minutes: result.earlyLeavingMinutes,
    overtime_minutes: result.overtimeMinutes,
    geofence: result.geofence
      ? {
          verified: result.geofence.verified,
          distance_meters: result.geofence.distanceMeters,
          message: result.geofence.message,
        }
      : null,
  }
}

/**
 * POST /api/attendance/punch-in
 *
 * No employee id in the body. The row is keyed off the authenticated caller, so
 * there is nothing for anyone to change — an endpoint that cannot be pointed at
 * somebody else cannot be pointed at the wrong person.
 */
export const postPunchIn: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(punchInSchema, req.body ?? {})

  // The device that checked in (client §31): what the browser says it is.
  const result = await punchIn(ctx, {
    latitude: input.latitude,
    longitude: input.longitude,
    accuracyMeters: input.accuracyMeters,
    device: req.get('user-agent') ?? undefined,
  })

  res.status(201).json({ data: payload(result), meta: { requestId: res.locals.requestId } })
}

/** POST /api/attendance/punch-out */
export const postPunchOut: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const result = await punchOut(ctx)

  res.status(200).json({ data: payload(result), meta: { requestId: res.locals.requestId } })
}

/** GET /api/attendance/me/workplace — office, home, on duty or remote today, and whether check-in needs a location. */
export const getMyWorkplace: RequestHandler = async (_req, res) => {
  const where = await myWorkplace(appContext(res))
  res.status(200).json({
    data: {
      work_mode: where.workMode,
      location_needed: where.locationNeeded,
      overtime_enabled: where.overtimeEnabled,
      shift: where.shift
        ? { name: where.shift.name, start_time: where.shift.startTime, end_time: where.shift.endTime, break_minutes: where.shift.breakMinutes }
        : null,
      weekly_off_days: where.weeklyOffDays,
      date_of_joining: where.dateOfJoining,
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** GET /api/attendance/me/today — which button the app should show. */
export const getMyToday: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const result = await myToday(ctx)

  res.status(200).json({
    data: result ? payload(result) : null,
    meta: { requestId: res.locals.requestId },
  })
}
