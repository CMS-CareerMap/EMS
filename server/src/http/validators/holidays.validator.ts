import { z } from 'zod'

/** The holiday calendar. */

export const holidayQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
})

export const holidayIdSchema = z.object({ id: z.uuid('That is not a valid holiday id') })

const fields = {
  date: z.iso
    .date('Choose the date')
    .refine((d) => d >= '2000-01-01' && d <= '2100-12-31', 'Choose a date between 2000 and 2100'),
  name: z.string().trim().min(1, 'Give the holiday a name').max(80),
  // weekly_off exists in the table for historical rows; new weekly offs are the
  // Working Days setting, not holidays, so it is not offered here.
  type: z.enum(['public', 'optional']),
}

export const holidaySchema = z
  .object({ ...fields, type: fields.type.default('public') })
  .strict()

export const holidayUpdateSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' })
