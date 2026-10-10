import type { RequestHandler } from 'express'
import { punchIn, punchOut, myToday, myWorkplace, type PunchResult } from '../../modules/attendance/attendance.service'
import { payDaysQuerySchema, punchInSchema } from '../validators/attendance.validator'
import { myPayDays } from '../../modules/payroll/myPayDays.service'
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
    // The day's own shift's unpaid break, taken off the hours at check-out.
    break_minutes: result.breakMinutes,
    // The hours worked a full day needs, as check-out grades it — the card counts down to it (client, 9 Oct 2026).
    full_day_hours: result.fullDayHours,
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
        ? {
            name: where.shift.name,
            start_time: where.shift.startTime,
            end_time: where.shift.endTime,
            break_minutes: where.shift.breakMinutes,
            full_day_hours: where.shift.fullDayHours,
            half_day_hours: where.shift.halfDayHours,
          }
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
  res.status(200).json({
    data: {
      year: d.year,
      month: d.month,
      employed: d.employed,
      paid_days: d.paidDays,
      unpaid_days: d.unpaidDays,
      employment_days: d.employmentDays,
      not_marked_days: d.notMarkedDays,
      leave_days: d.leaveDays.map((l) => ({ date: l.date, portion: l.portion, paid: l.paid, leave_type_name: l.leaveTypeName, code: l.code })),
      absent_days: d.absentDays.map((a) => ({
        date: a.date,
        applied: a.applied,
        leave: a.leave ? { status: a.leave.status, leave_type_name: a.leave.leaveTypeName, half: a.leave.half } : null,
        can_apply: a.canApply,
        why: a.why,
      })),
    },
    meta: { requestId: res.locals.requestId },
  })
}
