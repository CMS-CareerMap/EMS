import type { Prisma } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import type { AuditAction } from '../../domain/audit/catalogue'
import * as repo from './audit.repository'

/**
 * Writing the audit log.
 *
 * Two ways in, because two kinds of event:
 *
 *   audit(ctx, entry, tx)     a CHANGE — a salary, a role, a leave decision.
 *                             Written on the change's own transaction: if the
 *                             change rolls back, so does its row, and a change
 *                             cannot commit without one.
 *
 *   recordSecurityEvent(…)    a sign-in, a refused request. Written as it
 *                             happens and never allowed to fail the request it
 *                             describes — if the row cannot be written, the
 *                             error log carries the event instead. Nobody should
 *                             be locked out because an audit table is unwell.
 *
 * `details` holds the facts that matter for the action and nothing else: never
 * a password, a token or a bank account number.
 */

/**
 * The actions are listed, with their names and categories, in
 * domain/audit/catalogue.ts — one list for writing a row and for reading it
 * back in words, so an action cannot exist without a name.
 */
export type { AuditAction }

export interface AuditEntry {
  action: AuditAction
  entityType?: string | undefined
  entityId?: string | undefined
  details?: Record<string, unknown> | undefined
}

/**
 * `actorRole` is the role the person held AT THE TIME, kept with the facts:
 * somebody who approved leave as HR in June and was moved to Employee in
 * August must still read as HR on June's rows.
 */
function row(organizationId: string, actorUserId: string | null, requestId: string | undefined, entry: AuditEntry, actorRole?: string): repo.AuditRow {
  const details = actorRole ? { ...entry.details, actorRole } : entry.details
  return {
    organizationId,
    actorUserId,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    details: details as Prisma.InputJsonValue | undefined,
    requestId: requestId ?? null,
  }
}

/** A change, recorded on the transaction making it. Pass `tx` whenever there is one. */
export async function audit(ctx: AppContext, entry: AuditEntry, db: TxDb = ctx.db): Promise<void> {
  await repo.append(db, row(ctx.organizationId, ctx.userId, ctx.requestId, entry, ctx.role))
}

/**
 * One write and its audit row, committed together — for a change that is a
 * single statement and would otherwise need no transaction at all.
 */
export async function withAudit<T>(
  ctx: AppContext,
  write: (tx: TxDb) => Promise<T>,
  entry: (result: T) => AuditEntry,
): Promise<T> {
  return withTransaction(ctx.db, async (tx) => {
    const result = await write(tx)
    await audit(ctx, entry(result), tx)
    return result
  })
}

export interface SecurityEvent extends AuditEntry {
  organizationId: string
  /** Null when nobody is signed in — a failed sign-in. */
  actorUserId: string | null
  /** The actor's role at the time, when it is known. */
  actorRole?: string | undefined
  requestId?: string | undefined
}

/** A security event, written now, never at the cost of the request it describes. */
export async function recordSecurityEvent(event: SecurityEvent): Promise<void> {
  try {
    await repo.appendUnscoped(row(event.organizationId, event.actorUserId, event.requestId, event, event.actorRole))
  } catch (err) {
    logger.error('Audit row could not be written', {
      action: event.action,
      organizationId: event.organizationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
