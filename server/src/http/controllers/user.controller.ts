import type { RequestHandler } from 'express'
import { issuePasswordLink,
  listUsers,
  inviteUser,
  changeRole,
  changeStatus,
  terminateUser,
} from '../../modules/user/user.service'
import {
  inviteUserSchema,
  changeRoleSchema,
  changeStatusSchema,
  membershipIdSchema,
} from '../validators/user.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import type { MembershipRow } from '../../modules/user/user.repository'
import { isoInstant } from '../../domain/shared/dates'

/**
 * User management: the four capabilities the Supabase edge functions provided.
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
    role: row.role,
    status: row.status,
    created_at: isoInstant(row.createdAt),
  }
}

/** GET /api/users */
export const getUsers: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const rows = await listUsers(ctx)

  res.status(200).json({
    data: rows.map(serializeMembership),
    meta: { requestId: res.locals.requestId, total: rows.length },
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
    data: {
      user: serializeMembership(membership),
      invite: {
        token: inviteToken,
        expires_at: isoInstant(expiresAt),
        // There is no email sending yet. Saying so plainly beats a UI that
        // claims an email went out when nothing did.
        delivery: 'manual',
      },
    },
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
