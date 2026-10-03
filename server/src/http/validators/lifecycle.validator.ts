import { z } from 'zod'
import { NOTICE_DAYS_MAX, PROBATION_MONTHS_MAX } from '../../domain/org/lifecycle'

/** The employee lifecycle (client §43). Dates are calendar days, YYYY-MM-DD. */

// A real calendar day: 2026-02-30 and 2026-13-01 are refused, not rolled over.
const day = z.iso.date('That is not a date')
const optionalNote = z.string().trim().max(500).nullish().transform((v) => (v ? v : null))
const requiredNote = z.string().trim().min(3, 'Say why, in a few words').max(500)

export const idParamSchema = z.object({ id: z.uuid('That is not a valid id') })

export const onboardingSchema = z.object({ note: optionalNote }).strict()

export const probationSchema = z.object({ probationEndDate: day, note: requiredNote }).strict()

export const confirmSchema = z.object({ confirmedOn: day, note: optionalNote }).strict()

export const transferSchema = z
  .object({
    departmentId: z.uuid().nullable().optional(),
    reportingManagerId: z.uuid().nullable().optional(),
    effectiveDate: day,
    note: optionalNote,
  })
  .strict()

export const promoteSchema = z.object({ designationId: z.uuid(), effectiveDate: day, note: optionalNote }).strict()

/** The person's own resignation. */
export const resignSchema = z
  .object({
    reason: z.string().trim().min(3, 'Give a reason, in a few words').max(1000),
    requestedLastDay: day.nullish().transform((v) => v ?? null),
  })
  .strict()

/** HR recording one handed in on paper or by email. */
export const recordResignationSchema = z
  .object({
    reason: z.string().trim().min(3, 'Give the reason they gave').max(1000),
    submittedOn: day,
    requestedLastDay: day.nullish().transform((v) => v ?? null),
  })
  .strict()

export const acceptSchema = z.object({ lastWorkingDay: day, note: optionalNote }).strict()

export const cancelSchema = z.object({ note: requiredNote }).strict()

export const exitSchema = z
  .object({
    reason: z.enum(['resigned', 'terminated', 'retired', 'contract_ended', 'absconded', 'other']),
    // Empty only for somebody who was to join and is not coming.
    lastWorkingDate: day.nullable(),
    note: optionalNote,
  })
  .strict()

export const settingsSchema = z
  .object({
    probationMonths: z.number().int().min(0).max(PROBATION_MONTHS_MAX),
    noticePeriodDays: z.number().int().min(0).max(NOTICE_DAYS_MAX),
  })
  .strict()
