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
