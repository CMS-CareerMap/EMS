import { Router } from 'express'
import * as c from '../controllers/requests.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Requests (client §28–29). Mounted at /api/requests.
 *
 * Sending, withdrawing and deciding need no tick of their own, as with leave:
 * a request is anybody's own to send, and it is decided by whoever Settings →
 * Approvals names for its kind — the service checks that on every decision.
 * HR's view of everybody's requests follows its attendance and employee reach.
 */
export const requestsRouter = Router()

requestsRouter.use(authenticate)

requestsRouter.get('/mine', c.getMine)
requestsRouter.get('/waiting', c.getWaiting)
requestsRouter.get('/all', authorize(['attendance:read', 'employee:update', 'leave:balance:manage']), c.getAll)
requestsRouter.get('/my-details', c.getMyDetails)
requestsRouter.get('/upload-limit', c.getUploadLimit)
// Who decides each kind is the Super Admin's, beside the other approval settings.
requestsRouter.get('/settings', authorize('role:manage'), c.getRules)
requestsRouter.put('/settings', authorize('role:manage'), c.putRules)

// One's own, like leave: asked with the right to apply for leave (Day 23).
requestsRouter.post('/', authorize('leave:apply'), c.postRequest)
requestsRouter.get('/:id', c.getOne)
requestsRouter.post('/:id/approve', c.postApprove)
requestsRouter.post('/:id/reject', c.postReject)
requestsRouter.post('/:id/withdraw', c.postWithdraw)
requestsRouter.post('/:id/attachment', authorize('leave:apply'), c.attachmentUpload, c.postAttachment)
requestsRouter.get('/:id/attachment', c.getAttachment)
