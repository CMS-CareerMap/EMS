import type { RequestHandler } from 'express'
import { CATEGORY_OPTIONS, exportAuditLog, listAuditLog, type AuditEntryView, type AuditQuery } from '../../modules/audit/auditLog.service'
import { toCsv } from '../../domain/shared/csv'
import { isoInstant, zonedDateTime, zonedToday } from '../../domain/shared/dates'
import { auditExportQuerySchema, auditListQuerySchema } from '../validators/audit.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { sendFile } from '../download'

/**
 * GET /api/audit-log          a page of the log, in words
 * GET /api/audit-log/export   the same filters, as a CSV
 *
 * Read-only. There is no route anywhere that changes or removes a row.
 */

function payload(e: AuditEntryView) {
  return {
    id: e.id,
    at: isoInstant(e.at),
    actor: e.actor ? { user_id: e.actor.userId, name: e.actor.name, role: e.actor.role } : null,
    action: e.action,
    action_label: e.actionLabel,
    category: e.category,
    category_label: e.categoryLabel,
    summary: e.summary,
    ip: e.ip,
    device: e.device,
    request_id: e.requestId,
  }
}

function queryOf(q: { from?: string | undefined; to?: string | undefined; category?: AuditQuery['category']; actor?: string | undefined; employee?: string | undefined }): AuditQuery {
  return { from: q.from, to: q.to, category: q.category, actorUserId: q.actor, employeeId: q.employee }
}

export const getAuditLog: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const q = parseBody(auditListQuerySchema, req.query)
  const cursor = q.before && q.beforeId ? { before: new Date(q.before), beforeId: q.beforeId } : undefined
  const result = await listAuditLog(ctx, queryOf(q), cursor)
  res.status(200).json({
    data: result.rows.map(payload),
    meta: { requestId: res.locals.requestId, more: result.more, categories: CATEGORY_OPTIONS },
  })
}

export const getAuditLogExport: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const q = parseBody(auditExportQuerySchema, req.query)
  const { rows, timezone } = await exportAuditLog(ctx, queryOf(q))

  const header = ['When', 'Who', 'Their role', 'Area', 'Action', 'What happened', 'IP address', 'Device', 'Reference']
  const body = rows.map((e) => [
    zonedDateTime(e.at, timezone),
    e.actor?.name ?? 'Nobody signed in',
    e.actor?.role ?? '',
    e.categoryLabel ?? '',
    e.actionLabel,
    e.summary,
    e.ip,
    e.device,
    e.requestId,
  ])
  sendFile(res, {
    filename: `audit-log-${zonedToday(new Date(), timezone)}.csv`,
    bytes: Buffer.from(toCsv([header, ...body]), 'utf8'),
    contentType: 'text/csv; charset=utf-8',
  })
}
