import type { RequestHandler } from 'express'
import * as notifications from '../../modules/notifications/notification.service'
import type { NotificationRow } from '../../modules/notifications/notification.repository'
import { isoInstant } from '../../domain/shared/dates'
import { idParamSchema, notificationListQuerySchema, notificationSettingsSchema } from '../validators/documents.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'

/**
 * The bell. A person's own notices only — there is no route that writes one;
 * they are created by the server inside the change they describe.
 */

function payload(n: NotificationRow) {
  return {
    id: n.id,
    event: n.event,
    type: n.kind,
    title: n.title,
    message: n.message,
    link: n.link,
    entity_type: n.entityType,
    entity_id: n.entityId,
    read: n.readAt !== null,
    read_at: isoInstant(n.readAt),
    created_at: isoInstant(n.createdAt),
  }
}

/** GET /api/notifications?before=&beforeId= — newest first, 30 at a time, with the unread count. */
export const getNotifications: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { before, beforeId } = parseBody(notificationListQuerySchema, req.query)
  const result = await notifications.listMine(ctx, before ? { before: new Date(before), beforeId } : undefined)
  res.status(200).json({
    data: result.rows.map(payload),
    meta: { requestId: res.locals.requestId, unread: result.unread, more: result.more },
  })
}

/** GET /api/notifications/unread-count — what the bell polls. */
export const getUnreadCount: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  res.status(200).json({ data: { unread: await notifications.unreadCount(ctx) }, meta: { requestId: res.locals.requestId } })
}

/** POST /api/notifications/:id/read */
export const postRead: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(idParamSchema, req.params)
  await notifications.markRead(ctx, id)
  res.status(200).json({ data: null, meta: { requestId: res.locals.requestId } })
}

/** POST /api/notifications/read-all */
export const postReadAll: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const count = await notifications.markAllRead(ctx)
  res.status(200).json({ data: { marked: count }, meta: { requestId: res.locals.requestId } })
}

/** DELETE /api/notifications — clears the caller's own. */
export const deleteAll: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const count = await notifications.clearAll(ctx)
  res.status(200).json({ data: { cleared: count }, meta: { requestId: res.locals.requestId } })
}

/** GET /api/notifications/settings — every event, whom it tells, and whether it is on. */
export const getNotificationSettings: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  res.status(200).json({ data: await notifications.settings(ctx), meta: { requestId: res.locals.requestId } })
}

/** PUT /api/notifications/settings  { changes: [{ event, enabled }] } */
export const putNotificationSettings: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { changes } = parseBody(notificationSettingsSchema, req.body)
  res.status(200).json({ data: await notifications.saveSettings(ctx, changes), meta: { requestId: res.locals.requestId } })
}
