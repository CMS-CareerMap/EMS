import { z } from 'zod'
import { SUPER_ADMIN_ROLE } from '../../platform/authz/defaultRoles'

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

export const inviteUserSchema = z
  .object({
    email: z.email('That is not a valid email address'),
    role: assignableRole,
    fullName: z.string().trim().max(120).optional(),
    /** Given only when this invitation should also create an HR record. */
    employeeCode: z.string().trim().max(30).optional(),
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

export const membershipIdSchema = z.object({
  id: z.uuid('That is not a valid user id'),
})

export { assignableRole }
