import { z } from 'zod'
import { AUDIT_CATEGORIES, type AuditCategory } from '../../domain/audit/catalogue'

/** The audit log's filters. Every one is optional; with none, it is the whole log, newest first. */

const day = (message: string) =>
  z.iso.date(message).refine((d) => d >= '2000-01-01' && d <= '2100-12-31', 'Choose a date between 2000 and 2100')

const filters = {
  from: day('Choose a start date').optional(),
  to: day('Choose an end date').optional(),
  category: z.enum(Object.keys(AUDIT_CATEGORIES) as [AuditCategory, ...AuditCategory[]]).optional(),
  actor: z.uuid('That is not a valid user').optional(),
  employee: z.uuid('That is not a valid employee').optional(),
}

export const auditListQuerySchema = z
  .object({ ...filters, before: z.iso.datetime().optional(), beforeId: z.uuid().optional() })
  .strict()
  .refine((q) => Boolean(q.before) === Boolean(q.beforeId), { message: 'before and beforeId go together', path: ['beforeId'] })

export const auditExportQuerySchema = z.object(filters).strict()
