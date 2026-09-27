import { z } from 'zod'

/**
 * Payroll input.
 *
 * Bounded like every other number that turns into money. A loss-of-pay figure
 * of 300 or a TDS of minus a lakh would each produce a payslip that looks like
 * a calculation, which is worse than an error.
 */

const year = z.coerce.number().int().min(2000).max(2100)
const month = z.coerce.number().int().min(1).max(12)

export const calculationSchema = z.object({
  employeeId: z.uuid('employeeId must be a valid id'),
  year,
  month,
  // Half days are real — a half-day LOP is 0.5 — so not an integer. Capped at
  // 31 here; the service checks it against the actual employment window.
  lopDays: z.coerce.number().min(0).max(31).multipleOf(0.5).optional(),
  // Entered by hand in v1. Upper bound is a typo guard, not a tax rule.
  tds: z.coerce.number().min(0).max(10_000_000).optional(),
  // This month's amounts for `monthly` components, keyed by code:
  // { "INCENTIVE": 5000 }. Which codes are allowed is the company's catalogue,
  // checked by the service; the shape is checked here.
  monthlyAmounts: z
    .record(
      z.string().regex(/^[A-Z0-9_]{1,20}$/, 'A component code, such as INCENTIVE'),
      z.number().min(0).max(10_000_000),
    )
    .optional(),
})
  // Strict, like every other body here. Without it a misspelt `lopDay` would be
  // dropped in silence and the month calculated as if nobody had been absent.
  .strict()

export const esiRedecideSchema = z
  .object({
    employeeId: z.uuid('employeeId must be a valid id'),
    year,
    month,
  })
  .strict()

/** An employee id in the path. A non-uuid is a 422, never a database round trip. */
export const payrollEmployeeParamSchema = z.object({
  id: z.uuid('That is not a valid employee id'),
})

/**
 * A salary structure: when it starts, the annual CTC, and the monthly amount of
 * each fixed component, by code.
 */
export const salaryStructureSchema = z
  .object({
    effectiveFrom: z.iso.date('Choose the date this salary starts'),
    // Typo guards, not pay policy: a crore a month is not a salary anybody here
    // is entering by hand.
    ctc: z.number().min(0).max(1_000_000_000),
    components: z
      .array(
        z
          .object({
            code: z.string().regex(/^[A-Z0-9_]{1,20}$/, 'A component code, such as BASIC'),
            amount: z.number().min(0).max(10_000_000),
          })
          .strict(),
      )
      .min(1, 'Enter at least one component')
      .max(30),
  })
  .strict()

// ── Payroll runs ────────────────────────────────────────────────────────────

/** A payroll month, in a body or a query string. */
export const payrollMonthSchema = z.object({ year, month }).strict()

export const payrollRunParamSchema = z.object({
  id: z.uuid('That is not a valid payroll run id'),
})

export const payslipParamSchema = z.object({
  id: z.uuid('That is not a valid payroll run id'),
  payslipId: z.uuid('That is not a valid payslip id'),
})

// ── What people enter before a run ──────────────────────────────────────────

/**
 * A TDS directive: from this month, deduct this much each month.
 *
 * A zero is allowed and is not the same as nothing — the service insists on a
 * reason for it, so that "no tax" is always a decision somebody wrote down.
 */
export const tdsDirectiveSchema = z
  .object({
    employeeId: z.uuid('employeeId must be a valid id'),
    year,
    month,
    // A typo guard, not a tax rule: nobody on this payroll pays a crore a month.
    monthlyAmount: z.number().min(0, 'Tax cannot be negative').max(10_000_000),
    reason: z.string().trim().max(300).nullish(),
  })
  .strict()

export const financialYearQuerySchema = z
  .object({
    financialYear: z.coerce.number().int().min(2000).max(2100),
  })
  .strict()

/**
 * This month's amount of a monthly component — Incentive, per the client.
 * Positive: removing one is a DELETE, not an entry of zero, because "no
 * incentive this month" is the absence of a row.
 */
export const monthlyEntrySchema = z
  .object({
    employeeId: z.uuid('employeeId must be a valid id'),
    componentCode: z.string().regex(/^[A-Z0-9_]{1,20}$/, 'A component code, such as INCENTIVE'),
    year,
    month,
    amount: z.number().positive('Enter an amount above zero — or remove the entry').max(10_000_000),
    note: z.string().trim().max(300).nullish(),
  })
  .strict()

export const monthlyEntryParamSchema = z.object({
  id: z.uuid('That is not a valid entry id'),
})

// ── Sign-off and payment ────────────────────────────────────────────────────

export const approveRunSchema = z
  .object({
    // Set only after reading which days were counted as paid on no record.
    confirmAssumedDays: z.boolean().optional(),
  })
  .strict()

export const markPaidSchema = z
  .object({
    paidOn: z.iso.date('The day the salaries were credited, as YYYY-MM-DD'),
  })
  .strict()

export const payslipIdParamSchema = z.object({
  id: z.uuid('That is not a valid payslip id'),
})
