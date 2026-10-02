import { z } from 'zod'

/**
 * Applying for leave.
 *
 * `days` is deliberately absent. The client does not get to say what a request
 * costs — the server counts it from the dates, the weekly-off pattern and the
 * holiday calendar. Accepting a number here would let a page send `days: 0` for
 * a fortnight off, and the balance would agree with it.
 */
const dateRange = {
  leaveTypeId: z.uuid('Choose a leave type'),
  fromDate: z.iso.date('Choose a start date'),
  toDate: z.iso.date('Choose an end date'),
  /// Which days inside the range are half. An array rather than a flag: a
  /// week's leave can be half at either end.
  halfDayDates: z.array(z.iso.date()).max(60).optional(),
  /// HR applying on somebody's behalf. An employee sending this for anybody
  /// but themselves is refused by the service.
  employeeId: z.uuid().optional(),
}

export const leavePreviewSchema = z.object(dateRange).strict()

export const leaveApplySchema = z
  .object({
    ...dateRange,
    reason: z.string().trim().min(3, 'Give a reason, even a short one').max(500),
  })
  .strict()

export const leaveQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  employeeId: z.uuid().optional(),
  leaveYear: z.coerce.number().int().min(2000).max(2100).optional(),
  leaveTypeId: z.uuid().optional(),
})

/** GET /api/leave-requests/team — the requests of the people whose leave the caller decides. */
export const teamLeaveQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
})

export const balanceQuerySchema = z.object({
  employeeId: z.uuid().optional(),
})

export const leaveIdSchema = z.object({
  id: z.uuid('That is not a valid leave request id'),
})

/**
 * Approving, rejecting or reversing.
 *
 * The note is optional for an approval and, in practice, the thing an employee
 * reads first on a rejection. Not enforced as required, because forcing a
 * sentence produces "ok" — but the UI should ask for one.
 */
export const leaveDecisionSchema = z
  .object({
    note: z.string().trim().max(500).nullish(),
  })
  .strict()
