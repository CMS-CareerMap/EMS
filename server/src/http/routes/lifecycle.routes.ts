import { Router } from 'express'
import * as c from '../controllers/lifecycle.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * The employee lifecycle (client §43). Mounted at /api/lifecycle.
 *
 * HR's steps need `employee:lifecycle:manage`; the service also confines them
 * to the caller's employee reach and sends their own up the tree. A
 * resignation is anybody's own to hand in and withdraw, and is accepted by the
 * person they report to — so those need no permission, as with leave.
 */
export const lifecycleRouter = Router()

lifecycleRouter.use(authenticate)

lifecycleRouter.get('/me', c.getMine)
lifecycleRouter.get('/summary', authorize('employee:lifecycle:manage'), c.getSummary)
lifecycleRouter.get('/settings', authorize(['settings:read', 'employee:lifecycle:manage']), c.getSettings)
lifecycleRouter.put('/settings', authorize('settings:update'), c.putSettings)

lifecycleRouter.get('/employees/:id', authorize('employee:read'), c.getOf)
lifecycleRouter.post('/employees/:id/onboarding', authorize('employee:lifecycle:manage'), c.postOnboarding)
lifecycleRouter.post('/employees/:id/probation', authorize('employee:lifecycle:manage'), c.postProbation)
lifecycleRouter.post('/employees/:id/confirm', authorize('employee:lifecycle:manage'), c.postConfirm)
lifecycleRouter.post('/employees/:id/transfer', authorize('employee:lifecycle:manage'), c.postTransfer)
lifecycleRouter.post('/employees/:id/promote', authorize('employee:lifecycle:manage'), c.postPromote)
lifecycleRouter.post('/employees/:id/resignation', authorize('employee:lifecycle:manage'), c.postRecordResignation)
lifecycleRouter.post('/employees/:id/exit', authorize('employee:lifecycle:manage'), c.postExit)

lifecycleRouter.post('/resignations', c.postResign)
lifecycleRouter.get('/resignations/waiting', c.getWaiting)
lifecycleRouter.post('/resignations/:id/accept', c.postAccept)
lifecycleRouter.post('/resignations/:id/withdraw', c.postWithdraw)
lifecycleRouter.post('/resignations/:id/cancel', c.postCancel)
