import { z } from 'zod'
import { SUPER_ADMIN_ROLE } from '../../platform/authz/defaultRoles'
import { PASSWORD_MIN_LENGTH_LIMITS } from '../../domain/org/passwords'

/**
 * User management input.
 *
 * A role is given by its key. Since Day 21 roles are the company's own list,
 * so the validator checks only the shape of a key; the service checks that it
 * is one of the company's roles, and that the caller may give it.
 *
 * `super_admin` is refused on the invite form on purpose. Nothing stops a
 * super_admin from promoting someone to super_admin — that is a legitimate act
 * and the policy allows it — but it must be a deliberate choice, and leaving it
 * out of the invite form means a typo or a copied payload cannot produce one.
 * Promotion happens through the role endpoint, where the invariants run.
 */
export const roleKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'That is not a role')

const assignableRole = roleKey.refine((key) => key !== SUPER_ADMIN_ROLE, {
  message: 'Make somebody a Super Admin from Users & Roles, not with an invitation',
})

/**
 * A login's email: optional where the service allows it — an employee login,
 * which signs in with the Employee ID. Left blank on a form is left out.
 */
export const loginEmail = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.email('That is not a valid email address').optional(),
)

/**
 * A password typed for somebody else. Its length is the company's rule
 * (Settings → Passwords), checked by the service; this only bounds it.
 */
export const passwordForThem = z.string().min(1, 'Enter the password').max(200, 'That is too long to be a password')

export const inviteUserSchema = z
  .object({
    email: loginEmail,
    role: assignableRole,
    fullName: z.string().trim().max(120).optional(),
    /** Given only when this invitation should also create an HR record. */
    employeeCode: z.string().trim().max(30).refine((c) => !c.includes('@'), 'An Employee ID cannot contain @: signing in would read it as an email').optional(),
    password: passwordForThem.optional(),
  })
  .strict()

/** HR, or the Super Admin, setting somebody's password for them. */
export const setPasswordSchema = z
  .object({
    password: passwordForThem,
  })
  .strict()

/** Settings → Users & Roles → Passwords. */
export const passwordRulesSchema = z
  .object({
    employeePasswords: z.enum(['company', 'self']),
    rolePasswords: z.enum(['company', 'self']),
    passwordMinLength: z.number().int().min(PASSWORD_MIN_LENGTH_LIMITS.min).max(PASSWORD_MIN_LENGTH_LIMITS.max),
  })
  .strict()

export const changeRoleSchema = z
  .object({
    // Every role here, including super_admin: a super_admin handing over to a
    // successor before leaving is exactly what this endpoint is for. The
    // invariants in user.policy are what keep it safe.
    role: roleKey,
  })
  .strict()

export const changeStatusSchema = z
  .object({
    // No `invited` here. That is a state the system sets when it creates an
    // invitation, not one an administrator can put somebody back into.
    status: z.enum(['active', 'inactive']),
  })
  .strict()

/**
 * A login for somebody already here (Day 23). Any role, the Super Admin's
 * included: the Super Admin chooses the role on purpose for a person they
 * picked; HR may give only the Employee role (client, 6 Oct 2026). The service
 * refuses a role the person already has, and an email left out on a role login.
 */
export const addLoginSchema = z
  .object({
    email: loginEmail,
    role: roleKey,
    password: passwordForThem.optional(),
  })
  .strict()

export const membershipIdSchema = z.object({
  id: z.uuid('That is not a valid user id'),
})

export { assignableRole }
