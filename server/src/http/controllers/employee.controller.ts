import type { RequestHandler } from 'express'
import {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
} from '../../modules/employee/employee.service'
import { employeeQuerySchema, employeeIdSchema } from '../validators/employee.validator'
import {
  createEmployeeSchema,
  updateEmployeeSchema,
} from '../validators/employeeWrite.validator'
import { parseBody } from '../validators/parse'
import { serializeEmployee, serializeEmployees } from '../serializers/employee.serializer'
import { appContext } from '../context'
import { isoInstant } from '../../domain/shared/dates'

/**
 * GET /api/employees
 *
 * Returns only the people this caller may see, with only the fields they may
 * see. Both restrictions are decided below this layer — the controller's job is
 * to parse input and shape output, not to make access decisions.
 */
export const getEmployees: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const query = parseBody(employeeQuerySchema, req.query)

  const { rows, total, access } = await listEmployees(ctx, query)

  res.status(200).json({
    data: serializeEmployees(rows, access),
    meta: {
      requestId: res.locals.requestId,
      total,
      // Stated so the client knows a missing salary means "not permitted",
      // not "not recorded". Without it a blank column is ambiguous, and the
      // UI would have to guess which — the guessing is what produces the
      // fabricated zeroes the audit found.
      fields: {
        compensation: access.includeCompensation,
        bank: access.includeBank,
        identity: access.includeIdentity,
      },
    },
  })
}

/** GET /api/employees/:id */
export const getEmployeeById: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(employeeIdSchema, req.params)

  const { row, access } = await getEmployee(ctx, id)

  res.status(200).json({
    data: serializeEmployee(row, access),
    meta: {
      requestId: res.locals.requestId,
      fields: {
        compensation: access.includeCompensation,
        bank: access.includeBank,
        identity: access.includeIdentity,
      },
    },
  })
}

/**
 * POST /api/employees
 *
 * One transaction, so a request that fails halfway leaves nothing behind.
 *
 * The body cannot carry role, status or any salary field — the validator
 * rejects unknown keys, so a request that tries is a 422 naming the field
 * rather than a silent partial success. That is what stops anyone with
 * employee:update from writing themselves a promotion.
 */
export const postEmployee: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(createEmployeeSchema, req.body)

  const { row, access, invite } = await createEmployee(ctx, input)

  res.status(201).json({
    data: serializeEmployee(row, access),
    meta: {
      requestId: res.locals.requestId,
      // Shown once. Nothing can retrieve it again, because only its hash is
      // stored — a second look means issuing a new invitation.
      ...(invite
        ? { invite: { token: invite.token, expires_at: isoInstant(invite.expiresAt) } }
        : {}),
    },
  })
}

/** PATCH /api/employees/:id */
export const patchEmployee: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(employeeIdSchema, req.params)
  const input = parseBody(updateEmployeeSchema, req.body)

  const { row, access } = await updateEmployee(ctx, id, input)

  res.status(200).json({
    data: serializeEmployee(row, access),
    meta: { requestId: res.locals.requestId },
  })
}
