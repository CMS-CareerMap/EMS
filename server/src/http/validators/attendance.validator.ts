import { z } from 'zod'

/**
 * A punch-in reading.
 *
 * All three coordinates are optional here and REQUIRED by the service when the
 * employee is in `app` mode. That split is deliberate: whether a reading is
 * needed depends on the employee, which the validator does not know — and
 * making it required for everybody would break biometric staff, who have no
 * reason to send one.
 */
export const punchInSchema = z
  .object({
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    /// The browser's own error estimate. Rejected above 10 km, which is not a
    /// location at all — it is the phone saying it has no idea.
    accuracyMeters: z.number().min(0).max(10_000).optional(),
  })
  .strict()

export type PunchInBody = z.infer<typeof punchInSchema>

/** Query for the attendance list. Either a single date, or a month. */
export const attendanceQuerySchema = z.object({
  date: z.iso.date().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  employeeId: z.uuid().optional(),
  status: z.enum(['present', 'half_day', 'absent', 'on_leave', 'holiday', 'weekly_off']).optional(),
  departmentId: z.uuid().optional(),
})

export const monthQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  employeeId: z.uuid().optional(),
})

/** One's own month in pay terms (client, 10 Oct 2026) — always one's own, so no employee is named. */
export const payDaysQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
}).strict()

export const daySummaryQuerySchema = z.object({
  date: z.iso.date().optional(),
})

/**
 * HR marking or correcting a day.
 *
 * Times are WALL CLOCK in the company's timezone — "09:30" — because that is
 * what HR types and what the shift is written in. The service turns them into
 * instants using the organization's zone, so a 22:00 to 06:00 entry becomes two
 * timestamps on different days rather than a negative duration.
 */
export const markAttendanceSchema = z
  .object({
    employeeId: z.uuid(),
    date: z.iso.date(),
    status: z.enum(['present', 'half_day', 'absent', 'on_leave', 'holiday', 'weekly_off']),
    checkIn: z.string().regex(/^\d{1,2}:\d{2}$/, 'Use a time like 09:30').nullish(),
    checkOut: z.string().regex(/^\d{1,2}:\d{2}$/, 'Use a time like 18:30').nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict()

/** Amending an existing row. The employee and date come from the row itself. */
export const amendAttendanceSchema = markAttendanceSchema
  .omit({ employeeId: true, date: true })
  .strict()

export const attendanceIdSchema = z.object({
  id: z.uuid('That is not a valid attendance id'),
})

export const attendanceImportSchema = z.object({
  csv: z.string().min(1, 'No file contents were received'),
  /// Preview unless told otherwise, like the employee importer.
  dryRun: z.boolean().default(true),
})
