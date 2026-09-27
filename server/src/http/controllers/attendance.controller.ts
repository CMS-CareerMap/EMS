import type { RequestHandler } from 'express'
import { punchIn, punchOut, myToday, type PunchResult } from '../../modules/attendance/attendance.service'
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

  const result = await punchIn(ctx, input)

  res.status(201).json({ data: payload(result), meta: { requestId: res.locals.requestId } })
}

/** POST /api/attendance/punch-out */
export const postPunchOut: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const result = await punchOut(ctx)

  res.status(200).json({ data: payload(result), meta: { requestId: res.locals.requestId } })
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
