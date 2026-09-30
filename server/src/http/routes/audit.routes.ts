import { Router } from 'express'
import { getAuditLog, getAuditLogExport } from '../controllers/audit.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/audit-log. Super Admin's alone: the log names every salary
 * change and every document anybody opened, which makes it the most sensitive
 * read in the system. Both routes only read.
 */
export const auditRouter = Router()

auditRouter.use(authenticate)
auditRouter.get('/', authorize('audit:read'), getAuditLog)
auditRouter.get('/export', authorize('audit:read'), getAuditLogExport)
