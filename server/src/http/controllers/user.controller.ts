import type { RequestHandler } from 'express'
import { issuePasswordLink,
  listUsers,
  inviteUser,
  changeRole,
  changeStatus,
  terminateUser,
  addLogin,
  withdrawInvitation,
  setPassword,
  getPasswordRules as readPasswordRules,
  updatePasswordRules,
} from '../../modules/user/user.service'
import {
  inviteUserSchema,
  changeRoleSchema,
  changeStatusSchema,
  membershipIdSchema,
  addLoginSchema,
  setPasswordSchema,
  passwordRulesSchema,
} from '../validators/user.validator'
import { employeeIdSchema } from '../validators/employee.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import type { MembershipRow } from '../../modules/user/user.repository'
import { isoInstant } from '../../domain/shared/dates'
import { loginKind } from '../../domain/org/passwords'
import { EMPLOYEE_ROLE } from '../../platform/authz/defaultRoles'

/**
 * User management: the four capabilities the original backend's edge functions provided.
 *
 * Snake_case out, like everywhere else in v1, because Settings → Users already
 * reads these names.
 */
function serializeMembership(row: MembershipRow) {
  return {
    id: row.id,
    user_id: row.userId,
    email: row.email,
    full_name: row.fullName,
    employee_id: row.employeeCode,
    // The person the login belongs to — two logins, one person (Day 23) — so
    // the screen can show somebody's logins together. Null for an operator.
    person_id: row.employeeId,
    // Left the company: every login of theirs is closed and stays so.
    person_left: row.personLeft,
    role: row.role,
    // A custom role (Day 21) has no name the screen could know otherwise.
    role_name: row.roleName,
    status: row.status,
    // An employee login, a role login or a Super Admin's: whose password the
    // company sets, and who may set it (Settings → Passwords).
    login_kind: loginKind(row.role, EMPLOYEE_ROLE, row.roleLocked),
    // False for a login still waiting for its first password.
    has_password: row.hasPassword,
    created_at: isoInstant(row.createdAt),
  }
}

/**
 * How a new login started — a password typed for them, a link for them to set
 * their own (returned ONCE), or neither yet — for the screen that made it.
 */
function started(membership: MembershipRow, inviteToken: string | null, expiresAt: Date | null) {
  return {
    user: serializeMembership(membership),
    login_start: inviteToken ? 'link' : membership.hasPassword ? 'password' : 'none',
    // There is no email sending yet. Saying so plainly beats a UI that
    // claims an email went out when nothing did.
    invite: inviteToken && expiresAt ? { token: inviteToken, expires_at: isoInstant(expiresAt), delivery: 'manual' } : null,
  }
}

/** GET /api/users */
export const getUsers: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const rows = await listUsers(ctx)

  res.status(200).json({
    data: rows.map(serializeMembership),
    // Whose logins the list holds — the caller's employee scope (Day 21) — so
    // the screen can say "in your department" instead of "in your organisation".
    meta: { requestId: res.locals.requestId, total: rows.length, reach: ctx.scopeFor('employee').scope },
  })
}

/**
 * POST /api/users/invite
 *
 * The response carries the invitation token ONCE. It is not stored anywhere in
 * readable form and cannot be fetched again — a second look means issuing a new
 * invitation, which is the correct behaviour for a single-use credential.
 */
export const postInvite: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(inviteUserSchema, req.body)

  const { membership, inviteToken, expiresAt } = await inviteUser(ctx, input)

  res.status(201).json({
    data: started(membership, inviteToken, expiresAt),
    meta: { requestId: res.locals.requestId },
  })
}

/**
 * POST /api/employees/:id/logins
 *
 * Another login for somebody already here (Day 23), with its own email. The
 * invitation token comes back once, as with an invitation.
 */
export const postLogin: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(employeeIdSchema, req.params)
  const input = parseBody(addLoginSchema, req.body)

  const { membership, inviteToken, expiresAt } = await addLogin(ctx, id, input)

  res.status(201).json({
    data: started(membership, inviteToken, expiresAt),
    meta: { requestId: res.locals.requestId },
  })
}

/** PUT /api/users/:id/role */
export const putRole: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(membershipIdSchema, req.params)
  const { role } = parseBody(changeRoleSchema, req.body)

  const updated = await changeRole(ctx, id, role)

  res.status(200).json({
    data: serializeMembership(updated),
    meta: { requestId: res.locals.requestId },
  })
}

/** PATCH /api/users/:id/status */
export const patchStatus: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(membershipIdSchema, req.params)
  const { status } = parseBody(changeStatusSchema, req.body)

  const updated = await changeStatus(ctx, id, status)

  res.status(200).json({
    data: serializeMembership(updated),
    meta: { requestId: res.locals.requestId },
  })
}

/**
 * DELETE /api/users/:id
 *
 * The verb says delete; the effect is termination. Nothing is removed — access
 * ends and the records stay, because payslips and statutory filings reference
 * this person and must remain readable years later. See §A9.
 */
export const deleteUser: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(membershipIdSchema, req.params)

  await terminateUser(ctx, id)

  res.status(204).end()
}

/**
 * POST /api/users/:id/withdraw
 *
 * Takes back an invitation nobody has used: the login is deleted, so the
 * right one can be added in its place.
 */
export const postWithdraw: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(membershipIdSchema, req.params)

  await withdrawInvitation(ctx, id)

  res.status(204).end()
}

/**
 * POST /api/users/:id/password-link
 *
 * A fresh link — the invitation again if they never set a password, a reset if
 * they did. Any earlier link for that person stops working.
 */
export const postPasswordLink: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(membershipIdSchema, req.params)

  const link = await issuePasswordLink(ctx, id)

  res.status(201).json({
    data: {
      user: serializeMembership(link.membership),
      invite: {
        token: link.token,
        expires_at: isoInstant(link.expiresAt),
        purpose: link.purpose,
        delivery: 'manual',
      },
    },
    meta: { requestId: res.locals.requestId },
  })
}

/**
 * POST /api/users/:id/password
 *
 * HR sets an employee login's password, the Super Admin anybody's (client,
 * 6 Oct 2026). The password is never sent back: whoever typed it tells the
 * person.
 */
export const postSetPassword: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(membershipIdSchema, req.params)
  const { password } = parseBody(setPasswordSchema, req.body)

  const updated = await setPassword(ctx, id, password)

  res.status(200).json({
    data: serializeMembership(updated),
    meta: { requestId: res.locals.requestId },
  })
}

function rulesOut(rules: Awaited<ReturnType<typeof readPasswordRules>>) {
  return {
    employee_passwords: rules.employeePasswords,
    role_passwords: rules.rolePasswords,
    password_min_length: rules.passwordMinLength,
  }
}

/** GET /api/users/password-rules — Settings → Users & Roles → Passwords. */
export const getPasswordRules: RequestHandler = async (_req, res) => {
  res.status(200).json({ data: rulesOut(await readPasswordRules(appContext(res))), meta: { requestId: res.locals.requestId } })
}

/** PUT /api/users/password-rules */
export const putPasswordRules: RequestHandler = async (req, res) => {
  const input = parseBody(passwordRulesSchema, req.body)
  res.status(200).json({ data: rulesOut(await updatePasswordRules(appContext(res), input)), meta: { requestId: res.locals.requestId } })
}
