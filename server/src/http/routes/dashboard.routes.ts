import { Router } from 'express'
import { getMySummary, getPayroll, getPeople, getToday } from '../controllers/dashboard.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/dashboard — the home page's sections, each behind the
 * permission that opens it:
 *
 *   - `/today`   attendance:read, and a reach beyond oneself (the service
 *                refuses a reach of one's own: a "company" of one is not a
 *                view of anybody's day). A manager's figures cover their team,
 *                HR's the company — decided by who asks, not by the page.
 *   - `/people`  employee:read — the staff the caller's directory shows.
 *   - `/payroll` payroll:structure:read — the company's payroll.
 *   - `/me`      dashboard:read, which everybody holds. It is about the caller
 *                and takes no id, so there is nothing to point at anybody else.
 */
export const dashboardRouter = Router()

dashboardRouter.use(authenticate)

dashboardRouter.get('/today', authorize('attendance:read'), getToday)
dashboardRouter.get('/people', authorize('employee:read'), getPeople)
dashboardRouter.get('/payroll', authorize('payroll:structure:read'), getPayroll)
dashboardRouter.get('/me', authorize('dashboard:read'), getMySummary)
