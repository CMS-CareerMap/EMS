import { z } from 'zod'

/** Departments, designations and shifts — the company's own lists. */

export const masterDataIdSchema = z.object({ id: z.uuid('That is not a valid id') })

export const namedSchema = z
  .object({ name: z.string().trim().min(1, 'Give it a name').max(60) })
  .strict()

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 09:30')

const shiftFields = {
  name: z.string().trim().min(1, 'Give the shift a name').max(40),
  startTime: clock,
  endTime: clock,
  // Up to ten hours of breaks is a typo guard, not a labour-law opinion.
  breakMinutes: z.number().int().min(0).max(600),
  // What a full day is on this shift. Half-day and full-day thresholds are
  // fractions of it, so a nonsense value here misclassifies every day.
  expectedHours: z.number().min(0.5).max(24).multipleOf(0.25),
}

/** The shift's rules (client §34) — each optional, each defaulting to what applied before. */
const minutes = (max: number) => z.number().int('Whole minutes').min(0).max(max)
const hours = z.number().min(0.25).max(24).multipleOf(0.25, 'Quarter hours, such as 4.5 or 6.75')
const shiftRules = {
  graceMinutes: minutes(240).optional(),
  lateThresholdMinutes: minutes(720).nullable().optional(),
  earlyLeavingMinutes: minutes(720).nullable().optional(),
  minFullDayHours: hours.nullable().optional(),
  minHalfDayHours: hours.nullable().optional(),
  overtimeAfterMinutes: minutes(720).optional(),
}

/** A half day cannot need more hours than a full one. */
const halfWithinFull = (body: { minFullDayHours?: number | null | undefined; minHalfDayHours?: number | null | undefined }) =>
  !(body.minFullDayHours && body.minHalfDayHours && body.minHalfDayHours > body.minFullDayHours)
const halfWithinFullMessage = { path: ['minHalfDayHours'], message: 'A half day cannot need more hours than a full day' }

export const shiftSchema = z.object({ ...shiftFields, ...shiftRules }).strict().refine(halfWithinFull, halfWithinFullMessage)

export const shiftUpdateSchema = z
  .object({ ...shiftFields, ...shiftRules })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' })
  .refine(halfWithinFull, halfWithinFullMessage)
