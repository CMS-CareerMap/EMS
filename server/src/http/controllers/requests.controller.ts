import type { RequestHandler } from 'express'
import * as requests from '../../modules/requests/requests.service'
import { decisionSchema, idParamSchema, listQuerySchema, newRequestSchema, rulesSchema } from '../validators/requests.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { fromDateColumn, isoInstant } from '../../domain/shared/dates'
import { BadRequest } from '../../platform/errors/AppError'
import { singleFile, uploadedFile } from '../upload'
import { sendFile } from '../download'

/**
 * Requests (client §28–29).
 *
 * GET  /api/requests/mine                 the caller's own
 * GET  /api/requests/waiting              waiting for the caller to decide
 * GET  /api/requests/all?type=&status=    HR's view, within its reach
 * GET  /api/requests/my-details           the caller's details, for a profile change
 * GET  /api/requests/upload-limit         the largest file the company accepts
 * GET|PUT /api/requests/settings          who decides each kind; WFH and location
 * POST /api/requests                      a new request
 * GET  /api/requests/:id
 * POST /api/requests/:id/approve | reject | withdraw
 * POST /api/requests/:id/attachment       one supporting file (multipart, "file")
 * GET  /api/requests/:id/attachment
 */

const meta = (res: Parameters<RequestHandler>[1]) => ({ requestId: res.locals.requestId })

function serialize(v: requests.RequestView) {
  const r = v.row
  return {
    id: r.id,
    number: v.number,
    type: r.type,
    label: v.label,
    status: r.status,
    employee_id: r.employeeId,
    full_name: r.employee.fullName,
    employee_code: r.employee.employeeCode,
    department: r.employee.department?.name ?? null,
    from_date: fromDateColumn(r.fromDate),
    to_date: fromDateColumn(r.toDate),
    // A profile change's values only to whoever may read personal details; the rest see which details.
    details: v.showsDetails ? r.details : { fields: Object.keys(((r.details as { changes?: object }).changes) ?? {}) },
    reason: r.reason,
    submitted_at: isoInstant(r.createdAt),
    decided_by: v.decidedBy,
    decided_at: isoInstant(r.decidedAt),
    decision_note: r.decisionNote,
    /** While it waits: who decides it, in words. */
    decided_by_whom: v.decidedByWhom,
    attachment: r.attachmentKey ? { name: r.attachmentName, type: r.attachmentType, bytes: r.attachmentBytes } : null,
    may: { decide: v.may.decide, as_backup: v.may.asBackup, withdraw: v.may.withdraw, attach: v.may.attach },
  }
}

const rulesOut = (r: requests.RequestRules) => ({
  correction_approver: r.correctionApprover,
  wfh_approver: r.wfhApprover,
  overtime_approver: r.overtimeApprover,
  profile_approver: r.profileApprover,
  encashment_approver: r.encashmentApprover,
  wfh_gps_required: r.wfhGpsRequired,
})

export const getMine: RequestHandler = async (_req, res) => {
  res.status(200).json({ data: (await requests.mine(appContext(res))).map(serialize), meta: meta(res) })
}

export const getWaiting: RequestHandler = async (_req, res) => {
  res.status(200).json({ data: (await requests.waiting(appContext(res))).map(serialize), meta: meta(res) })
}

export const getAll: RequestHandler = async (req, res) => {
  const filters = parseBody(listQuerySchema, req.query)
  res.status(200).json({ data: (await requests.all(appContext(res), filters)).map(serialize), meta: meta(res) })
}

export const getMyDetails: RequestHandler = async (_req, res) => {
  res.status(200).json({ data: await requests.myDetails(appContext(res)), meta: meta(res) })
}

export const getUploadLimit: RequestHandler = async (_req, res) => {
  res.status(200).json({ data: { max_upload_mb: await requests.uploadLimit(appContext(res)) }, meta: meta(res) })
}

export const getRules: RequestHandler = async (_req, res) => {
  res.status(200).json({ data: rulesOut(await requests.getRules(appContext(res))), meta: meta(res) })
}

export const putRules: RequestHandler = async (req, res) => {
  const input = parseBody(rulesSchema, req.body)
  res.status(200).json({ data: rulesOut(await requests.updateRules(appContext(res), input)), meta: meta(res) })
}

export const postRequest: RequestHandler = async (req, res) => {
  const input = parseBody(newRequestSchema, req.body)
  res.status(201).json({ data: serialize(await requests.submit(appContext(res), input)), meta: meta(res) })
}

export const getOne: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParamSchema, req.params)
  res.status(200).json({ data: serialize(await requests.view(appContext(res), id)), meta: meta(res) })
}

export const postApprove: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParamSchema, req.params)
  const { note } = parseBody(decisionSchema, req.body ?? {})
  res.status(200).json({ data: serialize(await requests.decide(appContext(res), id, 'approved', note)), meta: meta(res) })
}

export const postReject: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParamSchema, req.params)
  const { note } = parseBody(decisionSchema, req.body ?? {})
  res.status(200).json({ data: serialize(await requests.decide(appContext(res), id, 'rejected', note)), meta: meta(res) })
}

export const postWithdraw: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParamSchema, req.params)
  res.status(200).json({ data: serialize(await requests.withdraw(appContext(res), id)), meta: meta(res) })
}

export const attachmentUpload = singleFile('file')

export const postAttachment: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParamSchema, req.params)
  const file = uploadedFile(req.file)
  if (!file) throw BadRequest('Choose a file to attach.')
  res.status(200).json({ data: serialize(await requests.attach(appContext(res), id, file)), meta: meta(res) })
}

export const getAttachment: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParamSchema, req.params)
  const file = await requests.attachment(appContext(res), id)
  sendFile(res, { filename: file.name, bytes: file.bytes, contentType: file.type })
}
