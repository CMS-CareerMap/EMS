import type { Prisma } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
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

export type AuditAction =
  // Signing in and staying in
  | 'auth.login_succeeded'
  | 'auth.login_failed'
  | 'auth.refresh_token_reused'
  | 'auth.password_changed'
  | 'auth.password_link_used'
  // Refusals
  | 'permission.denied'
  // Who has access, and as what
  | 'user.invited'
  | 'user.role_changed'
  | 'user.status_changed'
  | 'user.terminated'
  | 'user.password_link_issued'
  // People and pay
  | 'employee.created'
  | 'employee.updated'
  | 'employee.imported'
  | 'salary.set'
  // Payroll
  | 'payroll.run_created'
  | 'payroll.run_recalculated'
  | 'payroll.run_discarded'
  | 'payroll.run_approved'
  | 'payroll.run_reopened'
  | 'payroll.run_paid'
  | 'payslip.downloaded'
  | 'payroll.bank_file_downloaded'
  | 'bank_file_template.saved'
  | 'bank_account.saved'
  | 'bank_account.verified'
  | 'bank_account.rejected'
  | 'payroll.tds_directive_set'
  | 'payroll.entry_set'
  | 'payroll.entry_removed'
  // Leave and attendance
  | 'leave.applied_for'
  | 'leave.withdrawn'
  | 'leave.approved'
  | 'leave.rejected'
  | 'leave.reversed'
  | 'attendance.marked'
  | 'attendance.imported'
  // Company rules
  | 'company.updated'
  | 'policy.updated'
  | 'geofence.saved'
  | 'geofence.deleted'
  | 'leave_type.created'
  | 'leave_type.restored'
  | 'leave_type.updated'
  | 'leave_type.archived'
  | 'pt_table.set'
  | 'holiday.added'
  | 'holiday.changed'
  | 'holiday.removed'
  | 'master_data.added'
  | 'master_data.restored'
  | 'master_data.renamed'
  | 'master_data.changed'
  | 'master_data.archived'

export interface AuditEntry {
  action: AuditAction
  entityType?: string | undefined
  entityId?: string | undefined
  details?: Record<string, unknown> | undefined
}

function row(organizationId: string, actorUserId: string | null, requestId: string | undefined, entry: AuditEntry): repo.AuditRow {
  return {
    organizationId,
    actorUserId,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    details: entry.details as Prisma.InputJsonValue | undefined,
    requestId: requestId ?? null,
  }
}

/** A change, recorded on the transaction making it. Pass `tx` whenever there is one. */
export async function audit(ctx: AppContext, entry: AuditEntry, db: TxDb = ctx.db): Promise<void> {
  await repo.append(db, row(ctx.organizationId, ctx.userId, ctx.requestId, entry))
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
  requestId?: string | undefined
}

/** A security event, written now, never at the cost of the request it describes. */
export async function recordSecurityEvent(event: SecurityEvent): Promise<void> {
  try {
    await repo.appendUnscoped(row(event.organizationId, event.actorUserId, event.requestId, event))
  } catch (err) {
    logger.error('Audit row could not be written', {
      action: event.action,
      organizationId: event.organizationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
