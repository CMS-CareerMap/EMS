import { z } from 'zod'

const latitude = z.number().min(-90).max(90)
const longitude = z.number().min(-180).max(180)
/// The browser's own error estimate. Rejected above 10 km, which is not a
/// location at all — it is the phone saying it has no idea.
const accuracyMeters = z.number().min(0).max(10_000)
const touchPoints = z.number().int().min(0).max(64)
/// The random key the phone's browser keeps (lib/deviceKey.js): only its hash is stored.
const deviceKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/)
/// The selfie, as the browser made it small: a JPEG, PNG or WebP data URL (~50 KB).
const photo = z.string().max(900_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'The photo could not be read. Take it again.')

/** One reading of the burst the phone took (client, 11 Oct 2026). */
const reading = z
  .object({
    latitude,
    longitude,
    accuracyMeters,
    /// The phone's clock, ms since 1970 — every reading the page takes has one.
    at: z.number().int().positive(),
  })
  .strict()

/**
 * A punch — in or out.
 *
 * The readings are optional here and REQUIRED by the service when the day
 * needs a location. That split is deliberate: whether a reading is needed
 * depends on the employee and the day, which the validator does not know.
 * Only the burst, as the page sends it — each reading with its time — so the
 * signs that are read from it (Layer 4) cannot be left out by sending less.
 */
export const punchSchema = z
  .object({
    /// From POST /attendance/punch-start.
    token: z.string().min(1).max(1024).optional(),
    readings: z.array(reading).max(10).optional(),
    /// The page's count of touch points: an iPad describes itself as a Mac.
    touchPoints: touchPoints.optional(),
    deviceKey: deviceKey.optional(),
    photo: photo.optional(),
  })
  .strict()

export type PunchBody = z.infer<typeof punchSchema>

/** A day's punches for the roster's "Evidence" (client, 11 Oct 2026). */
export const dayEvidenceQuerySchema = z.object({ employeeId: z.uuid(), date: z.iso.date() }).strict()

/** Phones for HR: the ones waiting, or all of them. */
/** Phones waiting (when not said), or all of them — one person's, on their page. */
export const devicesQuerySchema = z.object({ status: z.enum(['waiting', 'all']).default('waiting'), employee: z.uuid().optional() }).strict()

/** Suspicious punches between two days (client, 11 Oct 2026); the last week when left out. */
export const suspiciousQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .strict()

/** Pressing Check In or Check Out: which way. */
export const punchStartSchema = z.object({ action: z.enum(['in', 'out']), touchPoints: touchPoints.optional(), deviceKey: deviceKey.optional() }).strict()

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

/** One person's month page (client, 15 Oct 2026): who, from the path; which month, from the query. */
export const personMonthParamsSchema = z.object({ employeeId: z.uuid() }).strict()
export const personMonthQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
}).strict()

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

/**
 * Several people's day at once (client, 25 Oct 2026): the people ticked, one
 * status, and why — a reason is kept on every day it writes. Not "on leave":
 * leave is applied for and approved, never typed over a day in bulk.
 */
export const markManySchema = z
  .object({
    date: z.iso.date(),
    employeeIds: z.array(z.uuid()).min(1, 'Tick at least one person.').max(500, 'At most 500 people at once.'),
    status: z.enum(['present', 'half_day', 'absent', 'holiday', 'weekly_off']),
    note: z.string().trim().min(3, 'Say why, in a few words — it is kept on every day marked.').max(500),
  })
  .strict()
