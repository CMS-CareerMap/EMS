import type { AppContext } from '../../platform/context'
import type { ScopedDb } from '../../platform/db/scoped'
import { BadRequest, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { audit } from '../audit/audit.service'
import {
  isEnabled,
  isNotificationEvent,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_KEYS,
  NOTIFICATION_RETENTION_DAYS,
} from '../../domain/notifications/events'
import * as repo from './notification.repository'

/**
 * A person's own notices, and the company's switches for them.
 *
 * Everything here is confined to the caller's own rows by userId. There is no
 * way to read, mark or clear anybody else's, and no way to write one at all —
 * that is notify.service, reached only from inside the server.
 */

const PAGE = 30

export async function listMine(ctx: AppContext, cursor?: repo.NoticeCursor) {
  const [rows, unread] = await Promise.all([
    repo.listFor(ctx.db, ctx.userId, PAGE + 1, cursor),
    repo.unreadCount(ctx.db, ctx.userId),
  ])
  return { rows: rows.slice(0, PAGE), unread, more: rows.length > PAGE }
}

export async function unreadCount(ctx: AppContext) {
  return repo.unreadCount(ctx.db, ctx.userId)
}

export async function markRead(ctx: AppContext, id: string) {
  const changed = await repo.markRead(ctx.db, ctx.userId, id)
  // Already read is fine; not yours (or not there) is a 404 like everywhere.
  if (changed === 0 && !(await repo.exists(ctx.db, ctx.userId, id))) throw NotFound('Notification not found')
}

export async function markAllRead(ctx: AppContext) {
  return repo.markAllRead(ctx.db, ctx.userId)
}

export async function clearAll(ctx: AppContext) {
  return repo.clearAll(ctx.db, ctx.userId)
}

/** Every event, what it tells whom, and whether this company sends it. */
export async function settings(ctx: AppContext) {
  const [saved, email] = await Promise.all([repo.savedSettings(ctx.db), repo.savedEmailChoices(ctx.db)])
  return NOTIFICATION_EVENT_KEYS.map((event) => {
    const rule = NOTIFICATION_EVENTS[event]
    return {
      event,
      group: rule.group,
      label: rule.label,
      tells: rule.tells,
      optional: rule.optional,
      enabled: isEnabled(event, saved),
      // Also emailed, once the server has a mail account to send from (client §45).
      email: email.get(event) ?? true,
    }
  })
}

export async function saveSettings(ctx: AppContext, changes: { event: string; enabled: boolean; email?: boolean | undefined }[]) {
  for (const change of changes) {
    if (!isNotificationEvent(change.event)) throw BadRequest(`"${change.event}" is not a notification this system sends`)
    if (!NOTIFICATION_EVENTS[change.event].optional && !change.enabled) {
      throw BadRequest(`"${NOTIFICATION_EVENTS[change.event].label}" is a security notice and is always sent.`)
    }
  }

  await withTransaction(ctx.db, async (tx) => {
    for (const change of changes) {
      await repo.saveSetting(tx, ctx.organizationId, change.event, change.enabled, ctx.userId, change.email)
    }
    await audit(ctx, {
      action: 'notification_settings.saved',
      entityType: 'notification_setting',
      details: { changes },
    }, tx)
  })

  return settings(ctx)
}

/**
 * Notices older than the retention period — counted on a dry run, cleared with
 * apply. Run for each company by the maintenance script.
 */
export async function sweepOldNotices(
  target: { db: ScopedDb },
  options: { apply: boolean; now?: Date },
): Promise<{ found: number; cleared: number }> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000)
  const found = await repo.countOlderThan(target.db, cutoff)
  const cleared = options.apply && found > 0 ? await repo.purgeOlderThan(target.db, cutoff) : 0
  return { found, cleared }
}
