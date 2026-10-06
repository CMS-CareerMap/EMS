import { z } from 'zod'

/**
 * One CSV row.
 *
 * The SAME exclusions as the employee form: no role, no status, no salary, no
 * password. A CSV is not a trusted input because it arrived as a file — if
 * anything it is less trusted, because nobody read it before uploading.
 *
 * `.strict()` is deliberately NOT used here. Unknown COLUMNS are normal — a
 * roster exported from another system carries all sorts of extra fields — and
 * refusing the whole file because it has a "Blood Group" column would be
 * obstructive. Extra columns are ignored; the dangerous fields are excluded by
 * never being read, not by being rejected.
 */
export const importRowSchema = z.object({
  employeeCode: z.string().trim().min(1, 'An employee code is required').max(30).refine((c) => !c.includes('@'), 'An Employee ID cannot contain @: signing in would read it as an email'),
  fullName: z.string().trim().min(1, 'A name is required').max(120),

  email: z.email('That is not a valid email address').optional(),
  personalEmail: z.email('That is not a valid personal email address').optional(),
  phone: z.string().trim().max(20).optional(),

  dateOfJoining: z.iso.date().optional(),
  // A personal detail: checked, and refused to anybody who cannot see them, before this.
  dateOfBirth: z.iso.date().optional(),
  // Somebody already working here, confirmed on this day (the employee
  // lifecycle). Left out, the row is a new joiner: onboarding, then probation.
  confirmedOn: z.iso.date().optional(),
  employmentType: z
    .enum(['full_time', 'part_time', 'contract', 'intern'], {
      message: 'Use one of: full_time, part_time, contract, intern',
    })
    .optional(),

  departmentId: z.uuid().optional(),
  designationId: z.uuid().optional(),
  shiftId: z.uuid().optional(),

  // Professional tax is gendered in several states, so a roster without it
  // would leave every imported employee's PT undecided until edited by hand.
  gender: z
    .enum(['male', 'female', 'other'], { message: 'Use one of: male, female, other' })
    .optional(),

  pan: z
    .string()
    .trim()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'A PAN looks like ABCDE1234F')
    .optional(),
})

export type ImportRowInput = z.infer<typeof importRowSchema>

/**
 * The request itself.
 *
 * `dryRun` defaults to TRUE. Committing five hundred rows must be something
 * somebody asked for, not something that happens because a flag was forgotten.
 */
export const importRequestSchema = z.object({
  csv: z.string().min(1, 'No file contents were received'),
  dryRun: z.boolean().default(true),
})
