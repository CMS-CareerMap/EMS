import type { RequestHandler } from 'express'
import * as types from '../../modules/documents/documentTypes.service'
import * as documents from '../../modules/documents/employeeDocuments.service'
import * as company from '../../modules/documents/companyDocuments.service'
import type { CompanyDocumentRow, DocumentRow, DocumentTypeRow } from '../../modules/documents/documents.repository'
import { uploadLimitMb } from '../../modules/organization/organization.service'
import { FILE_KINDS } from '../../domain/files/fileRules'
import { BadRequest } from '../../platform/errors/AppError'
import { isoInstant } from '../../domain/shared/dates'
import {
  companyDocumentSchema,
  documentDecisionSchema,
  documentTypeCreateSchema,
  documentTypeQuerySchema,
  documentTypeUpdateSchema,
  employeeDocumentsQuerySchema,
  idParamSchema,
  uploadDocumentSchema,
} from '../validators/documents.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { sendFile } from '../download'
import { uploadedFile } from '../upload'

/**
 * Documents. Snake_case out, as everywhere in v1. Files go out through
 * sendFile — attachment, allow-listed type, nosniff — and never by URL.
 */

const reply = (res: Parameters<RequestHandler>[1], status: number, data: unknown, meta: Record<string, unknown> = {}) =>
  res.status(status).json({ data, meta: { requestId: res.locals.requestId, ...meta } })

function typePayload(t: DocumentTypeRow) {
  return {
    id: t.id,
    code: t.code,
    label: t.label,
    required: t.required,
    display_order: t.displayOrder,
    archived: t.archivedAt !== null,
  }
}

function documentPayload(d: DocumentRow, names: ReadonlyMap<string, string>) {
  return {
    id: d.id,
    employee_id: d.employeeId,
    employee_code: d.employee.employeeCode,
    full_name: d.employee.fullName,
    type: { id: d.documentTypeId, code: d.documentType.code, label: d.documentType.label, required: d.documentType.required },
    file_name: d.fileName,
    content_type: d.contentType,
    bytes: d.bytes,
    status: d.status,
    remarks: d.remarks,
    uploaded_at: isoInstant(d.uploadedAt),
    uploaded_by: d.uploadedByUserId ? (names.get(d.uploadedByUserId) ?? null) : null,
    decided_at: isoInstant(d.decidedAt),
    decided_by: d.decidedByUserId ? (names.get(d.decidedByUserId) ?? null) : null,
    replaced_at: isoInstant(d.supersededAt),
  }
}

function companyPayload(d: CompanyDocumentRow, names: ReadonlyMap<string, string>) {
  return {
    id: d.id,
    title: d.title,
    category: d.category,
    description: d.description,
    file_name: d.fileName,
    content_type: d.contentType,
    bytes: d.bytes,
    uploaded_at: isoInstant(d.uploadedAt),
    uploaded_by: d.uploadedByUserId ? (names.get(d.uploadedByUserId) ?? null) : null,
  }
}

const ACCEPTED = Object.values(FILE_KINDS)

// ── The checklist of types ──────────────────────────────────────────────────

/** GET /api/document-types — with what an upload may be, for the page to check first. */
export const getDocumentTypes: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { includeArchived } = parseBody(documentTypeQuerySchema, req.query)
  const [rows, maxMb] = await Promise.all([types.listTypes(ctx, includeArchived), uploadLimitMb(ctx)])
  reply(res, 200, rows.map(typePayload), {
    max_upload_mb: maxMb,
    accepted: ACCEPTED.map((k) => k.label),
    accept: ACCEPTED.flatMap((k) => k.extensions.map((e) => `.${e}`)).join(','),
  })
}

/** POST /api/document-types */
export const postDocumentType: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(documentTypeCreateSchema, req.body)
  reply(res, 201, typePayload(await types.createType(ctx, input)))
}

/** PATCH /api/document-types/:id — rename, mark required, reorder, archive or restore. */
export const patchDocumentType: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(idParamSchema, req.params)
  const { archived, label, required, displayOrder } = parseBody(documentTypeUpdateSchema, req.body)

  const changesDetails = label !== undefined || required !== undefined || displayOrder !== undefined
  if (!changesDetails && archived === undefined) throw BadRequest('Nothing to change')

  let row = changesDetails ? await types.updateType(ctx, id, { label, required, displayOrder }) : null
  if (archived !== undefined) row = await types.setArchived(ctx, id, archived)
  reply(res, 200, typePayload(row!))
}

// ── Employees' documents ────────────────────────────────────────────────────

/** GET /api/employee-documents?employeeId= — one person's checklist; the caller's own when left out. */
export const getEmployeeDocuments: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { employeeId } = parseBody(employeeDocumentsQuerySchema, req.query)
  const result = await documents.checklist(ctx, employeeId)
  reply(res, 200, {
    employee: {
      id: result.employee.id,
      employee_code: result.employee.employeeCode,
      full_name: result.employee.fullName,
      department: result.employee.department?.name ?? null,
      designation: result.employee.designation?.name ?? null,
      status: result.employee.status,
    },
    own: result.own,
    // Whether the caller may check these documents, and if not, whom to ask (Day 22).
    may_check: result.mayCheck,
    check_goes_to: result.checkGoesTo,
    items: result.items.map((item) => ({
      type: typePayload(item.type),
      current: item.current ? documentPayload(item.current, result.names) : null,
      earlier: item.earlier.map((d) => documentPayload(d, result.names)),
    })),
    other: result.other.map((d) => documentPayload(d, result.names)),
  })
}

/** GET /api/employee-documents/compliance — everybody's standing, and what waits to be checked. */
export const getCompliance: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const result = await documents.compliance(ctx)
  const noNames = new Map<string, string>()
  reply(res, 200, {
    required_types: result.requiredTypes.map(typePayload),
    employees: result.employees.map((e) => ({
      employee_id: e.employee.id,
      employee_code: e.employee.employeeCode,
      full_name: e.employee.fullName,
      department: e.employee.department?.name ?? null,
      required: e.required,
      verified: e.verified,
      pending: e.pending,
      rejected: e.rejected,
      missing: e.missing,
      waiting_count: e.waiting,
    })),
    waiting: result.waiting.map((d) => documentPayload(d, noNames)),
  })
}

/** POST /api/employee-documents — multipart: file, documentTypeId, employeeId?, markVerified? */
export const postEmployeeDocument: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(uploadDocumentSchema, req.body ?? {})
  const row = await documents.upload(ctx, input, uploadedFile(req.file))
  reply(res, 201, documentPayload(row, new Map()))
}

/** GET /api/employee-documents/:id/file */
export const getEmployeeDocumentFile: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(idParamSchema, req.params)
  sendFile(res, await documents.download(ctx, id))
}

/** POST /api/employee-documents/:id/decision  { decision, remarks? } */
export const postDocumentDecision: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(idParamSchema, req.params)
  const input = parseBody(documentDecisionSchema, req.body)
  reply(res, 200, documentPayload(await documents.decide(ctx, id, input), new Map()))
}

/** DELETE /api/employee-documents/:id */
export const deleteEmployeeDocument: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(idParamSchema, req.params)
  await documents.remove(ctx, id)
  reply(res, 200, null)
}

// ── The company's documents ─────────────────────────────────────────────────

/** GET /api/company-documents */
export const getCompanyDocuments: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const { rows, names } = await company.list(ctx)
  reply(res, 200, rows.map((r) => companyPayload(r, names)))
}

/** POST /api/company-documents — multipart: file, title, category, description? */
export const postCompanyDocument: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(companyDocumentSchema, req.body ?? {})
  const row = await company.publish(ctx, input, uploadedFile(req.file))
  reply(res, 201, companyPayload(row, new Map()))
}

/** GET /api/company-documents/:id/file */
export const getCompanyDocumentFile: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(idParamSchema, req.params)
  sendFile(res, await company.download(ctx, id))
}

/** DELETE /api/company-documents/:id */
export const deleteCompanyDocument: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(idParamSchema, req.params)
  await company.remove(ctx, id)
  reply(res, 200, null)
}
