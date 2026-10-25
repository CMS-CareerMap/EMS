import { z } from 'zod'
import { FENCE_LIMITS } from '../../domain/attendance/geofence'
import { PUNCH_METHODS } from '../../domain/attendance/punchMethod'

/**
 * Settings input.
 *
 * Every number here is BOUNDED, and that matters more than it looks. The old
 * Payroll Settings tab accepted whatever was typed: a PF rate of 500 would be
 * saved without complaint and would not be noticed until payroll ran and every
 * salary came out negative. A validator that only checks "is it a number" is
 * not checking anything useful about a rate.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullish()

export const companySchema = z
  .object({
    name: z.string().trim().min(1, 'A company name is required').max(120).optional(),
    legalName: optionalText(200),

    // Format is not validated. A GSTIN has a checksum and a PAN has a pattern,
    // but a company setting itself up before registration is complete needs to
    // be able to save the rest of the form. Length only; correctness is a
    // separate concern and belongs where the number is actually used.
    gstin: optionalText(15),
    pan: optionalText(10),

    addressLine: optionalText(300),
    city: optionalText(80),
    state: optionalText(80),
    pincode: optionalText(10),
    phone: optionalText(20),
    email: z.email().nullish(),
    website: optionalText(200),

    // A real IANA zone, checked the way it will be used. Anything else saved here
    // — a typo, or a label like "Asia/Kolkata (IST)" — makes every calculation of
    // "today" throw, and attendance, leave and the dashboard all fail at once.
    timezone: z
      .string()
      .trim()
      .max(64)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: zone })
          return true
        } catch {
          return false
        }
      }, 'Choose a time zone from the list, such as Asia/Kolkata')
      .optional(),
    // No date format: it was stored and never used — every screen, payslip and
    // file shows dates one way. (The bank file has its own, in its template.)
    // Upper-case codes, as they are compared: ISO 3166 country, ISO 4217 currency.
    country: z.string().trim().regex(/^[A-Z]{2}$/, 'A two-letter country code, such as IN').optional(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/, 'A three-letter currency code, such as INR').optional(),
    // The largest upload, in whole MB. The system's own ceiling is 10.
    maxUploadMb: z.number().int('Whole megabytes, such as 2').min(1, 'At least 1 MB').max(10, 'At most 10 MB').optional(),
  })
  .strict()

/** A percentage. Nothing statutory is above 100, and nothing is negative. */
const rate = z.number().min(0, 'A rate cannot be negative').max(100, 'A rate cannot exceed 100%')

/** Rupees. Bounded so a stray keystroke cannot set a ceiling of ten crore. */
const money = z.number().min(0).max(100_000_000)

export const policySchema = z
  .object({
    pfEmployeeRate: rate.optional(),
    pfEmployerRate: rate.optional(),
    pfRestrictToCeiling: z.boolean().optional(),
    pfWageCeiling: money.optional(),
    epsWageCeiling: money.optional(),
    // The Labour Codes' wages rule. One half unless the government notifies
    // another share; never none, never more than the whole pay.
    wagesShareEnabled: z.boolean().optional(),
    wagesSharePercent: z
      .number()
      .min(1, 'At least 1%')
      .max(100, 'At most 100%')
      // The column keeps two decimal places; a third would be rounded away unseen.
      .refine((v) => Number(v.toFixed(2)) === v, 'At most two decimal places, such as 50 or 33.33')
      .optional(),

    esiEmployeeRate: rate.optional(),
    esiEmployerRate: rate.optional(),
    esiThreshold: money.optional(),

    payDay: z.number().int().min(1).max(28, 'Choose a day that exists in every month').optional(),
    // 28 rather than 31 on purpose: a pay day of the 30th silently does not
    // exist in February, and the bug only appears once a year.
    payslipLockDay: z.number().int().min(1).max(28).nullish(),

    leaveYearStartMonth: z.number().int().min(1).max(12).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),

    /** What one day's pay is: gross ÷ calendar days, ÷ 30, or ÷ working days. */
    lopBasis: z.enum(['calendar_days', 'fixed_30', 'working_days']).optional(),
    /** Whether an off day between two days of loss of pay is unpaid too. */
    sandwichRule: z.boolean().optional(),
    /** Whether income tax (TDS) is deducted through payroll at all. */
    tdsEnabled: z.boolean().optional(),

    // Overtime and leave encashment (client §35–36).
    overtimeEnabled: z.boolean().optional(),
    overtimeRate: z.number().min(1, 'At least the ordinary rate, 1').max(5, 'At most 5 times').refine((v) => Number(v.toFixed(2)) === v, 'At most two decimal places, such as 1.5 or 2').optional(),
    overtimeBasis: z.enum(['gross', 'basic']).optional(),
    encashmentBasis: z.enum(['gross', 'basic']).optional(),
  })
  .strict()

export const geofenceSchema = z
  .object({
    name: z.string().trim().min(1, 'The location needs a name').max(80),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    /// The client's fence (11 Oct 2026): 15–20 m, not a metre more.
    radiusMeters: z
      .number()
      .int()
      .min(FENCE_LIMITS.radius.min, `The office radius is ${FENCE_LIMITS.radius.min} to ${FENCE_LIMITS.radius.max} m.`)
      .max(FENCE_LIMITS.radius.max, `The office radius is ${FENCE_LIMITS.radius.min} to ${FENCE_LIMITS.radius.max} m.`),
    /// How precise a reading must be: 10–20 m. Tighter than a phone can manage
    /// indoors locks people out; vaguer than the fence decides nothing.
    maxAccuracyMeters: z
      .number()
      .int()
      .min(FENCE_LIMITS.accuracy.min, `The accuracy needed is ${FENCE_LIMITS.accuracy.min} to ${FENCE_LIMITS.accuracy.max} m.`)
      .max(FENCE_LIMITS.accuracy.max, `The accuracy needed is ${FENCE_LIMITS.accuracy.min} to ${FENCE_LIMITS.accuracy.max} m.`)
      .optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

/** Settings → Attendance Security (client, 11 and 14 Oct 2026): the punch method and the layers the company has on. */
export const attendanceSecuritySchema = z
  .object({
    /// How a punch is proved: exactly one method, never none (client, 14 Oct 2026).
    punchMethod: z.enum(PUNCH_METHODS, 'Choose location, selfie, or location and selfie.').optional(),
    /// One phone per employee, with whichever method.
    punchOneDevice: z.boolean().optional(),
    /// The fingerprint machine's file confirms app days.
    punchMachineMatch: z.boolean().optional(),
    punchMachineMinutes: z.number().int().min(5, 'Between 5 and 240 minutes.').max(240, 'Between 5 and 240 minutes.').optional(),
    punchMachineMissing: z.enum(['flag', 'absent']).optional(),
    punchMachineFills: z.boolean().optional(),
    /// A selfie is kept 7 to 365 days.
    punchSelfieKeepDays: z.number().int().min(7, 'Between 7 and 365 days.').max(365, 'Between 7 and 365 days.').optional(),
    /// Precise location only (client, 25 Oct 2026): the vaguest reading taken, 20 to 500 m —
    /// "Approximate" (1–3 km) is refused whatever is chosen here.
    punchPreciseMeters: z.number().int().min(20, 'Between 20 and 500 metres.').max(500, 'Between 20 and 500 metres.').optional(),
  })
  .strict()

/** "Test this spot": the readings the Super Admin's phone took where they stand. */
export const geofenceTestSchema = z
  .object({
    readings: z
      .array(
        z
          .object({
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
            accuracyMeters: z.number().min(0).max(10_000),
            at: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(1, 'No location was read.')
      .max(10),
  })
  .strict()

export const leaveTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    code: z
      .string()
      .trim()
      .min(1)
      .max(6)
      .regex(/^[A-Za-z]+$/, 'A code is letters only, for example CL or SL')
      .optional(),
    annualQuota: z.number().min(0).max(365).optional(),
    isPaid: z.boolean().optional(),
    carryForward: z.boolean().optional(),
    carryForwardCap: z.number().min(0).max(365).optional(),
    // The type's rules (client §36–37).
    minNoticeDays: z.number().int().min(0).max(365).optional(),
    maxDaysPerRequest: z.number().min(0.5).max(365).multipleOf(0.5).nullable().optional(),
    eligibleAfterDays: z.number().int().min(0).max(3650).optional(),
    eligibleGender: z.enum(['male', 'female', 'other']).nullable().optional(),
    accrual: z.enum(['yearly', 'monthly']).optional(),
    halfDayAllowed: z.boolean().optional(),
    countsNonWorkingDays: z.boolean().optional(),
    encashable: z.boolean().optional(),
    encashMaxDaysPerYear: z.number().min(0.5).max(365).multipleOf(0.5).nullable().optional(),
    // Who gets how much, and from when (client, 9 Oct 2026).
    joinerGrant: z.enum(['months_left', 'months_after_joining', 'full_year']).optional(),
    usableAfterConfirmation: z.boolean().optional(),
    // With new days a year: change this year's balances too, not only the next year's.
    applyToThisYear: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) => !(body.carryForward === true && (body.carryForwardCap ?? 0) === 0),
    {
      path: ['carryForwardCap'],
      message: 'Carry forward is on, so set how many days may be carried',
    },
  )

export const settingsIdSchema = z.object({
  id: z.uuid('That is not a valid id'),
})

export const ptSlabQuerySchema = z.object({
  state: z.string().trim().max(80).optional(),
})

/**
 * A state's whole PT table, from a date. Each slab says where it starts; the
 * upper bounds are derived, so the table cannot have a gap. The legal limits —
 * the ₹2,500 annual cap above all — are checked by the domain, not here.
 */
export const ptTableSchema = z
  .object({
    state: z.string().trim().min(2, 'Name the state').max(50),
    effectiveFrom: z.iso.date('Choose the date this table starts'),
    slabs: z
      .array(
        z
          .object({
            gender: z.enum(['male', 'female', 'any']),
            from: z.number().min(0).max(100_000_000),
            // Typo guards; the real ceiling is the annual cap.
            amount: z.number().min(0).max(100_000),
            februaryAmount: z.number().min(0).max(100_000).nullish(),
          })
          .strict(),
      )
      .min(1, 'Add at least one slab')
      .max(40),
  })
  .strict()

/** Whether an earning component counts as PF wages. */
export const pfComponentSchema = z.object({ countsForPf: z.boolean() }).strict()

/**
 * PUT /api/settings/work-week (client, 25 Oct 2026): the weekly offs, and the
 * day they start — today, the 1st of next month, or the 1st of this one. The
 * service decides which days are allowed; this only checks the shape.
 *
 * [0] is a six-day week with Sunday off; [0, 6] is the five-day week. Capped
 * at six so a company cannot accidentally close every day and make leave
 * impossible to take.
 */
export const workWeekSchema = z
  .object({
    weeklyOffDays: z
      .array(z.number().int().min(0).max(6))
      .max(6, 'A company cannot be closed every day of the week'),
    from: z.iso.date('Choose the day the change starts'),
  })
  .strict()

/** DELETE /api/settings/work-week/:from — a change saved for a later day. */
export const workWeekParamsSchema = z.object({ from: z.iso.date() }).strict()

/**
 * No check-in means Absent (client, 25 Oct 2026): on or off, the day it
 * starts from, and how many days the machine's file or HR's marking is waited
 * for. The service checks the day against today; this, the shape.
 */
export const absentRuleSchema = z
  .object({
    on: z.boolean(),
    from: z.iso.date('Choose the day the rule starts from').nullable(),
    waitDays: z.number().int().min(1, 'Between 1 and 14 days.').max(14, 'Between 1 and 14 days.'),
  })
  .strict()
