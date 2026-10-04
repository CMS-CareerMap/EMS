import { z } from 'zod'

/**
 * Documents, company documents and notifications.
 *
 * Uploads are multipart forms, so their fields arrive as TEXT — "true", not
 * true. formBoolean reads both, and nothing else.
 */

const formBoolean = z.union([
  z.boolean(),
  z.enum(['true', 'false', 'on', '1', '0']).transform((v) => v === 'true' || v === 'on' || v === '1'),
])

export const idParamSchema = z.object({ id: z.uuid('That is not a valid id') })

export const documentTypeCreateSchema = z
  .object({
    label: z.string().trim().min(2, 'Name the document').max(60),
    required: z.boolean().default(false),
  })
  .strict()

export const documentTypeUpdateSchema = z
  .object({
    label: z.string().trim().min(2, 'Name the document').max(60).optional(),
    required: z.boolean().optional(),
    displayOrder: z.number().int().min(0).max(1000).optional(),
    archived: z.boolean().optional(),
  })
  .strict()

export const documentTypeQuerySchema = z
  .object({ includeArchived: z.enum(['true', 'false']).optional().transform((v) => v === 'true') })
  .strict()

export const employeeDocumentsQuerySchema = z.object({ employeeId: z.uuid().optional() }).strict()

export const uploadDocumentSchema = z
  .object({
    employeeId: z.uuid('Choose an employee').optional(),
    documentTypeId: z.uuid('Choose a document type'),
    markVerified: formBoolean.optional(),
  })
  .strict()

export const documentDecisionSchema = z
  .object({
    decision: z.enum(['verified', 'rejected']),
    remarks: z.string().trim().max(300).nullish(),
  })
  .strict()

export const companyDocumentSchema = z
  .object({
    title: z.string().trim().min(2, 'Give the document a title').max(120),
    category: z.enum(['policy', 'handbook', 'template', 'announcement', 'other']).default('policy'),
    description: z.string().trim().max(300).nullish(),
  })
  .strict()

/**
 * The page after the last notice seen: its time and its id. The id matters —
 * notices written in one transaction share a timestamp, and a cursor of the
 * time alone would skip the rest of them at a page boundary.
 */
export const notificationListQuerySchema = z
  .object({ before: z.iso.datetime().optional(), beforeId: z.uuid().optional() })
  .strict()
  .refine((q) => !q.beforeId || q.before, { message: 'beforeId needs before', path: ['beforeId'] })

export const notificationSettingsSchema = z
  .object({
    changes: z.array(z.object({ event: z.string().min(1).max(60), enabled: z.boolean(), email: z.boolean().optional() }).strict()).min(1).max(60),
  })
  .strict()
