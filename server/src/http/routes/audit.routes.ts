import { Router } from 'express'
import { getAuditLog, getAuditLogExport, getAuditLogPeople } from '../controllers/audit.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/audit-log. Super Admin's by default (Day 21: the Super Admin
 * can give `audit:read` to a role, after a warning): the log names every salary
 * change and every document anybody opened, which makes it the most sensitive
 * read in the system. Every route only reads.
 */
export const auditRouter = Router()

auditRouter.use(authenticate)
auditRouter.get('/', authorize('audit:read'), getAuditLog)
auditRouter.get('/export', authorize('audit:read'), getAuditLogExport)
auditRouter.get('/people', authorize('audit:read'), getAuditLogPeople)
