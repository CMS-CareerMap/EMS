import { Router } from 'express'
import {
  deleteAll,
  getNotifications,
  getNotificationSettings,
  getUnreadCount,
  postRead,
  postReadAll,
  putNotificationSettings,
} from '../controllers/notifications.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/notifications. Everybody reads their own; only Settings'
 * owners change which events are sent. Nothing here creates a notice.
 */
export const notificationsRouter = Router()

notificationsRouter.use(authenticate)

notificationsRouter.get('/settings', authorize('settings:read'), getNotificationSettings)
notificationsRouter.put('/settings', authorize('settings:update'), putNotificationSettings)

notificationsRouter.get('/', authorize('notification:read'), getNotifications)
notificationsRouter.get('/unread-count', authorize('notification:read'), getUnreadCount)
notificationsRouter.post('/read-all', authorize('notification:read'), postReadAll)
notificationsRouter.post('/:id/read', authorize('notification:read'), postRead)
notificationsRouter.delete('/', authorize('notification:read'), deleteAll)
