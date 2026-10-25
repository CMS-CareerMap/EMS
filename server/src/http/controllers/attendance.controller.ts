import type { Request, RequestHandler } from 'express'
import { punchIn, punchOut, myToday, myWorkplace, startPunch, type PunchInput, type PunchResult } from '../../modules/attendance/attendance.service'
import { payDaysQuerySchema, punchSchema, punchStartSchema } from '../validators/attendance.validator'
import { myPayDays } from '../../modules/payroll/myPayDays.service'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { isoInstant } from '../../domain/shared/dates'
import { payDaysPayload } from '../serializers/payDays.serializer'

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
    // The day's own shift's unpaid break, taken off the hours at check-out.
    break_minutes: result.breakMinutes,
    // The hours worked a full day needs, as check-out grades it — the card counts down to it (client, 9 Oct 2026).
    full_day_hours: result.fullDayHours,
    // How the day was checked in on the app; its check-out follows it (client, 14 Oct 2026).
    punch_method: result.punchMethod,
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
  const result = await punchIn(appContext(res), punchInputOf(req))
  res.status(201).json({ data: payload(result), meta: { requestId: res.locals.requestId } })
}

/** POST /api/attendance/punch-out — a location too, on an office day when the company checks check-outs. */
export const postPunchOut: RequestHandler = async (req, res) => {
  const result = await punchOut(appContext(res), punchInputOf(req))
  res.status(200).json({ data: payload(result), meta: { requestId: res.locals.requestId } })
}

/**
 * A punch's body, as the service takes it: the start token, the burst of
 * readings, the device that punched (client §31: what the browser says it is)
 * and the address it came from.
 */
function punchInputOf(req: Request): PunchInput {
  const input = parseBody(punchSchema, req.body ?? {})
  return {
    token: input.token,
    readings: input.readings,
    ...deviceOf(req, input.touchPoints, input.deviceKey),
    ...(input.photo ? { photo: photoOf(input.photo) } : {}),
  }
}

/** What the browser says it is: its description, its mobile hint, its touch points, its key — and where it came from. */
function deviceOf(req: Request, touchPoints: number | undefined, deviceKey: string | undefined): PunchInput {
  return {
    device: req.get('user-agent') ?? undefined,
    mobileHint: req.get('sec-ch-ua-mobile') ?? undefined,
    touchPoints,
    deviceKey,
    ip: req.ip,
  }
}

/** The selfie's data URL as bytes, with the type the browser said — checked against the bytes when stored. */
function photoOf(dataUrl: string) {
  const [, declaredType = '', data = ''] = /^data:([^;]+);base64,(.*)$/.exec(dataUrl) ?? []
  return { declaredType, bytes: Buffer.from(data, 'base64') }
}

/**
 * POST /api/attendance/punch-start — pressing Check In or Check Out (client,
 * 11 Oct 2026): anything that would refuse the punch is said now; otherwise
 * the start token, and whether the location is needed and how precisely.
 */
export const postPunchStart: RequestHandler = async (req, res) => {
  const { action, touchPoints, deviceKey } = parseBody(punchStartSchema, req.body ?? {})
  const start = await startPunch(appContext(res), action, deviceOf(req, touchPoints, deviceKey))
  res.status(200).json({
    data: {
      token: start.token,
      expires_in_seconds: start.expiresInSeconds,
      location_needed: start.locationNeeded,
      radius_meters: start.radiusMeters,
      accuracy_meters: start.accuracyMeters,
      precise_meters: start.preciseMeters,
      photo_needed: start.photoNeeded,
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** GET /api/attendance/me/workplace — office, home, on duty or remote today, and whether check-in needs a location. */
export const getMyWorkplace: RequestHandler = async (_req, res) => {
  const where = await myWorkplace(appContext(res))
  res.status(200).json({
    data: {
      work_mode: where.workMode,
      punch_method: where.method,
      location_needed: where.locationNeeded,
      fence_needed: where.fenceNeeded,
      check_out_location_needed: where.checkOutLocationNeeded,
      photo_needed: where.photoNeeded,
      overtime_enabled: where.overtimeEnabled,
      shift: where.shift
        ? {
            name: where.shift.name,
            start_time: where.shift.startTime,
            end_time: where.shift.endTime,
            break_minutes: where.shift.breakMinutes,
            full_day_hours: where.shift.fullDayHours,
            half_day_hours: where.shift.halfDayHours,
          }
        : null,
      weekly_off_days: where.offDaysToday,
      next_week: where.nextWeek ? { from: where.nextWeek.from, weekly_off_days: where.nextWeek.offDays } : null,
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
    // The server's clock: "Time today" counts the time at work by it, not by a
    // phone that may be minutes out (client, 8 Oct 2026).
    data: result ? { ...payload(result), server_now: isoInstant(new Date()) } : null,
    meta: { requestId: res.locals.requestId },
  })
}

/**
 * GET /api/attendance/me/pay-days?year=&month= — one's own month in pay terms
 * (client, 10 Oct 2026): days paid and days of loss of pay so far, as payroll
 * will count them; each day of approved leave named by its type; each absent
 * day with whether leave can still be asked for it.
 */
export const getMyPayDays: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { year, month } = parseBody(payDaysQuerySchema, req.query)
  const d = await myPayDays(ctx, year, month)
  res.status(200).json({ data: payDaysPayload(d), meta: { requestId: res.locals.requestId } })
}
