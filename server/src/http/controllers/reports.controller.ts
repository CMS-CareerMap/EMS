import type { RequestHandler } from 'express'
import { z } from 'zod'
import { isReportId, runReport, type ReportResult } from '../../modules/reports/reports.service'
import { recordSecurityEvent } from '../../modules/audit/audit.service'
import { toCsv, type CsvCell } from '../../domain/shared/csv'
import { monthKey } from '../../domain/shared/dates'
import { NotFound } from '../../platform/errors/AppError'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { sendFile } from '../download'

/**
 * GET /api/reports/:id?year=&month=&departmentId=&employeeId=&format=
 *
 * The same report as JSON for the page, or as CSV to download — built from the
 * same rows, through the one CSV writer (BOM, CRLF, quotes, and a guard that
 * stops a cell like "=HYPERLINK(...)" running as a formula in Excel).
 */

const querySchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(1).max(12),
    departmentId: z.uuid().optional(),
    employeeId: z.uuid().optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict()

function csvOf(report: ReportResult): Buffer {
  const cell = (value: unknown, type: string): CsvCell => {
    if (value === null || value === undefined) return null
    if (type === 'money' && typeof value === 'number') return value.toFixed(2)
    return value as CsvCell
  }
  const header = report.columns.map((c) => c.label)
  const body = report.rows.map((row) => report.columns.map((c) => cell(row[c.key], c.type)))
  const totals = report.totals ? [report.columns.map((c) => cell(report.totals?.[c.key], c.type))] : []
  return Buffer.from(toCsv([header, ...body, ...totals]), 'utf8')
}

export const getReport: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const id = String(req.params.id ?? '')
  if (!isReportId(id)) throw NotFound('No such report')
  const q = parseBody(querySchema, req.query)

  const report = await runReport(ctx, id, { year: q.year, month: q.month, departmentId: q.departmentId, employeeId: q.employeeId })

  if (q.format === 'csv') {
    await recordSecurityEvent({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      requestId: ctx.requestId,
      action: 'report.exported',
      entityType: 'report',
      details: { report: id, year: q.year, month: q.month, rows: report.rows.length, departmentId: q.departmentId ?? null, employeeId: q.employeeId ?? null },
    })
    sendFile(res, { filename: `${id}-${monthKey(q.year, q.month)}.csv`, bytes: csvOf(report), contentType: 'text/csv; charset=utf-8' })
    return
  }

  res.status(200).json({
    data: {
      id: report.id,
      title: report.title,
      period: report.period,
      columns: report.columns,
      rows: report.rows,
      totals: report.totals,
      notes: report.notes,
      chart: report.chart,
    },
    meta: { requestId: res.locals.requestId },
  })
}
