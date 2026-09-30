import { z } from 'zod'

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
    dateFormat: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']).optional(),
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

    esiEmployeeRate: rate.optional(),
    esiEmployerRate: rate.optional(),
    esiThreshold: money.optional(),

    payDay: z.number().int().min(1).max(28, 'Choose a day that exists in every month').optional(),
    // 28 rather than 31 on purpose: a pay day of the 30th silently does not
    // exist in February, and the bug only appears once a year.
    payslipLockDay: z.number().int().min(1).max(28).nullish(),

    /**
     * Which weekdays the company does not work, as Sunday=0.
     *
     * [0] is a six-day week with Sunday off; [0, 6] is the five-day week.
     * Capped at six so a company cannot accidentally close every day and
     * make leave impossible to take.
     */
    weeklyOffDays: z
      .array(z.number().int().min(0).max(6))
      .max(6, 'A company cannot be closed every day of the week')
      .optional(),

    leaveYearStartMonth: z.number().int().min(1).max(12).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),

    /** What one day's pay is: gross ÷ calendar days, ÷ 30, or ÷ working days. */
    lopBasis: z.enum(['calendar_days', 'fixed_30', 'working_days']).optional(),
    /** Whether an off day between two days of loss of pay is unpaid too. */
    sandwichRule: z.boolean().optional(),
    /** Whether income tax (TDS) is deducted through payroll at all. */
    tdsEnabled: z.boolean().optional(),
  })
  .strict()

export const geofenceSchema = z
  .object({
    name: z.string().trim().min(1, 'The location needs a name').max(80),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    /// 10 m floor because the client wants 15–30 m, and a floor of 50 would
    /// have refused their actual requirement. 50 km ceiling so a typo in the
    /// kilometres box cannot cover the state.
    radiusMeters: z.number().int().min(10).max(50_000),
    /// Below 20 m no consumer phone can confirm anything, so the gate would
    /// reject every reading and nobody could punch in at all.
    maxAccuracyMeters: z.number().int().min(20).max(500).optional(),
    isActive: z.boolean().optional(),
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
