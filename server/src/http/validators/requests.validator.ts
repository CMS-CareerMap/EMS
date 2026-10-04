import { z } from 'zod'
import { REQUEST_TYPES } from '../../domain/requests/requests'

/** Requests (client §28–29). Dates are calendar days, YYYY-MM-DD; times are a wall clock, HH:MM. */

const day = z.iso.date('That is not a date')
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time looks like 09:30')
  .nullish()
  .transform((v) => v ?? null)
const reason = z.string().trim().min(3, 'Give a reason, in a few words').max(1000)
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

export const idParamSchema = z.object({ id: z.uuid('That is not a valid id') })

export const newRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attendance_correction'), date: day, checkIn: time, checkOut: time, reason }).strict(),
  z.object({ type: z.literal('work_from_home'), fromDate: day, toDate: day, reason }).strict(),
  z.object({ type: z.literal('on_duty'), fromDate: day, toDate: day, reason }).strict(),
  // Overtime on a day already worked (client §35): all of what was recorded, or less.
  z.object({ type: z.literal('overtime'), date: day, minutes: z.number().int().min(1).max(1440).nullish().transform((v) => v ?? null), reason }).strict(),
  // Unused leave turned into pay (client §36), in half days.
  z.object({ type: z.literal('leave_encashment'), leaveTypeId: z.uuid('Choose a leave type'), days: z.number().min(0.5).max(365).multipleOf(0.5, 'Whole or half days'), reason }).strict(),
  z
    .object({
      type: z.literal('profile_change'),
      changes: z
        .object({
          fullName: text(250),
          phone: text(30),
          personalEmail: z
            .email('That is not an email address')
            .max(254)
            .nullish()
            .or(z.literal(''))
            .transform((v) => (v ? v : null)),
          dateOfBirth: day.nullish().transform((v) => v ?? null),
          nationality: text(80),
          address: text(500),
          emergencyContactName: text(250),
          emergencyContactRelation: text(80),
          emergencyContactPhone: text(30),
        })
        .partial()
        .strict(),
      reason,
    })
    .strict(),
])

export const decisionSchema = z
  .object({
    note: z
      .string()
      .trim()
      .max(500)
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .strict()

export const listQuerySchema = z.object({
  // Every kind there is — one list, the domain's, so a new kind is never left out.
  type: z.enum(REQUEST_TYPES).optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
})

export const rulesSchema = z
  .object({
    correctionApprover: z.enum(['manager', 'hr']),
    wfhApprover: z.enum(['manager', 'hr']),
    overtimeApprover: z.enum(['manager', 'hr']),
    profileApprover: z.enum(['manager', 'hr']),
    encashmentApprover: z.enum(['manager', 'hr']),
    wfhGpsRequired: z.boolean(),
  })
  .strict()
