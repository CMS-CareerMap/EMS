import { z } from 'zod'

/** Leave → Team Balances. */

const leaveYear = z.coerce.number().int().min(2000).max(2100)

export const balancesQuerySchema = z.object({ year: leaveYear.optional() }).strict()

export const grantSchema = z.object({ leaveYear: leaveYear.optional() }).strict()

export const adjustSchema = z
  .object({
    employeeId: z.uuid('Choose a person'),
    leaveTypeId: z.uuid('Choose a leave type'),
    leaveYear: leaveYear.optional(),
    days: z
      .number('Enter the number of days')
      .refine((d) => d !== 0, 'Enter the number of days to add or take away')
      .refine((d) => Number.isInteger(d * 2), 'Use whole or half days')
      .refine((d) => Math.abs(d) <= 365, 'At most 365 days at a time'),
    // A correction nobody can explain is what a ledger exists to prevent.
    note: z.string().trim().min(3, 'Say why — the employee sees this').max(300),
  })
  .strict()

export const personSchema = z.object({ id: z.uuid('That is not a valid employee id') })

/** How many days before the leave year ends people are told of days that will lapse (client, 10 Oct 2026). */
export const reminderSchema = z.object({
  days: z.number('Enter the number of days').int('Whole days').min(1, 'At least 1 day').max(90, 'At most 90 days'),
}).strict()

/** One person's statement of one type, for HR on the profile (client, 10 Oct 2026). */
export const personStatementSchema = z.object({ leaveTypeId: z.uuid('Choose a leave type'), leaveYear: leaveYear.optional() }).strict()

/** One person's own days a year of a type (client, 9 Oct 2026); null puts them back on the company's. */
export const entitlementSchema = z
  .object({
    leaveTypeId: z.uuid('Choose a leave type'),
    days: z
      .number('Enter the days a year')
      .min(0, 'Days a year cannot be below 0')
      .max(365, 'At most 365 days a year')
      .refine((d) => Number.isInteger(d * 2), 'Use whole or half days')
      .nullable(),
    note: z.string().trim().min(3, 'Say why — the employee sees this').max(300),
  })
  .strict()
