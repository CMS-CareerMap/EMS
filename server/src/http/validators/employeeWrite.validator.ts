import { z } from 'zod'
import { assignableRole, loginEmail, passwordForThem } from './user.validator'

/**
 * Creating and editing employees.
 *
 * THREE FIELDS ARE DELIBERATELY ABSENT, and their absence is the point of this
 * file:
 *
 *   role      lives on Membership, and is changed only through
 *             PUT /memberships/:id/role, which only super_admin can call. If it
 *             were accepted here, anyone with `employee:update` — HR, Admin —
 *             could promote themselves to super_admin by editing their own
 *             employee record. That is the privilege-escalation path the audit
 *             found, and it is closed by the field simply not existing.
 *
 *   status    is ACCOUNT status, not HR status, and belongs to
 *             PATCH /users/:id/status. Deactivating someone must also revoke
 *             their tokens, which an employee update does not do.
 *
 *   ctc       and every other salary component. §3.2 gives "Manage salary
 *             structures" to super_admin and accounts ONLY — and HR creates
 *             employees. Accepting a salary here would hand HR a permission the
 *             client explicitly withheld.
 *
 * `.strict()` on every object makes that enforceable rather than aspirational.
 * An unknown key is a 422 naming the field, not a silently ignored one — so a
 * request carrying `role` fails loudly instead of appearing to succeed.
 */

/** Optional text that should become null when cleared, not an empty string. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullish()

const statutorySchema = z
  .object({
    pan: optionalText(10),
    /// Never derived. Null until EPFO issues one.
    uan: optionalText(12),
    pfAccountNumber: optionalText(30),
    esiNumber: optionalText(20),
    ptState: optionalText(50),

    /// Whether PF applies to this person at all. Per employee, because an
    /// international worker or an excluded employee sits outside PF while
    /// their colleagues are inside it.
    pfApplicable: z.boolean().optional(),
    /// Were they a PF member at a previous employer? Decides EPS membership.
    /// Null is "nobody has asked yet", and payroll warns about it.
    hasPriorPfMembership: z.boolean().nullish(),
    /// A member of the pension scheme (EPS), as their PF record has it. Null:
    /// payroll works it out from what they joined on.
    epsMember: z.boolean().nullish(),
  })
  .strict()

/**
 * Personal details (client §42). Sent only by somebody who can see them —
 * otherwise the blanks they were shown would be saved over the real values.
 */
const personalSchema = z
  .object({
    dateOfBirth: z.iso.date().nullish(),
    nationality: optionalText(80),
    address: optionalText(500),
    emergencyContactName: optionalText(200),
    emergencyContactRelation: optionalText(80),
    emergencyContactPhone: optionalText(30),
  })
  .strict()

/**
 * Giving the new employee a login, optionally.
 *
 * How it starts is the company's choice (Settings → Passwords): where the
 * company sets employees' passwords, HR types it here (client, 6 Oct 2026) and
 * the login works at once — never a default or shared one, as nothing is
 * generated; where people set their own, there is no password field's worth
 * and a single-use link is made instead. The email is optional for an
 * employee login, which signs in with the Employee ID.
 */
const loginSchema = z
  .object({
    email: loginEmail,
    // One of the company's roles, by key; the service checks it exists and
    // that the caller may give it. Never super_admin from this form.
    role: assignableRole,
    password: passwordForThem.optional(),
  })
  .strict()

export const createEmployeeSchema = z
  .object({
    employeeCode: z.string().trim().min(1, 'An employee code is required').max(30).refine((c) => !c.includes('@'), 'An Employee ID cannot contain @: signing in would read it as an email'),
    fullName: z.string().trim().min(1, 'A name is required').max(120),

    personalEmail: z.email().nullish(),
    phone: optionalText(20),
    dateOfJoining: z.iso.date().nullish(),
    /// The last day they are paid for. Checked against the joining date by the
    /// service, which is the only place that knows the stored value on an edit.
    lastWorkingDate: z.iso.date().nullish(),

    /// Professional tax is gendered by statute in several states, and PF and
    /// ESI returns both require it. Optional, because nobody should be forced
    /// to guess it to save a record.
    gender: z.enum(['male', 'female', 'other']).nullish(),

    employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),

    departmentId: z.uuid().nullish(),
    designationId: z.uuid().nullish(),
    shiftId: z.uuid().nullish(),
    reportingManagerId: z.uuid().nullish(),

    attendanceMode: z.enum(['app', 'biometric', 'manual']).optional(),
    /// Office, hybrid (home on approved days) or remote (client §33).
    workArrangement: z.enum(['office', 'hybrid', 'remote']).optional(),
    country: z.string().trim().length(2).optional(),
    currency: z.string().trim().length(3).optional(),

    statutory: statutorySchema.optional(),
    personal: personalSchema.optional(),
    login: loginSchema.optional(),
    /// Somebody already working here, added to EMS: onboarded and confirmed
    /// on this day, so they do not start in onboarding and probation (the
    /// employee lifecycle). Left out for a new joiner.
    confirmedOn: z.iso.date().nullish(),
    /// Their own days a year of some leave types, in place of the company's
    /// (client, 9 Oct 2026) — for whoever manages leave balances. Changed
    /// later on the profile's Leave tab.
    leaveEntitlements: z
      .array(z.object({
        leaveTypeId: z.uuid('Choose a leave type'),
        days: z.number().min(0).max(365).refine((d) => Number.isInteger(d * 2), 'Use whole or half days'),
      }).strict())
      .max(30)
      .refine((list) => new Set(list.map((e) => e.leaveTypeId)).size === list.length, 'Each leave type once')
      .optional(),
  })
  .strict()

export type CreateEmployeeBody = z.infer<typeof createEmployeeSchema>

/**
 * Editing. Same shape, every field optional, and NO `login` — granting someone
 * a login after the fact is an invite, which is its own endpoint with its own
 * permission.
 */
export const updateEmployeeSchema = createEmployeeSchema
  // Confirmation is a step in the lifecycle, with its own endpoint and history;
  // days a year of leave are changed on the profile's Leave tab.
  .omit({ login: true, confirmedOn: true, leaveEntitlements: true })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Nothing to update',
  })

export type UpdateEmployeeBody = z.infer<typeof updateEmployeeSchema>
