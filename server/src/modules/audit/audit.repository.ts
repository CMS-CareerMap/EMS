import type { Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { unsafeDb } from '../../platform/db/unsafe'

/**
 * The audit log.
 *
 * There is an append here and a read, and no update and no delete — anywhere.
 * A log that can be edited is not a log. (A company's rows go with the company
 * if it is ever removed; that is the only way one leaves.)
 */

export interface AuditRow {
  organizationId: string
  actorUserId: string | null
  action: string
  entityType: string | null
  entityId: string | null
  details: Prisma.InputJsonValue | undefined
  requestId: string | null
}

/** Appends on whatever handle the change is being made on, so they commit together. */
export async function append(db: TxDb, row: AuditRow): Promise<void> {
  await db.auditLog.create({ data: row })
}

/** For events before a company-scoped client exists — a sign-in. */
export async function appendUnscoped(row: AuditRow): Promise<void> {
  await unsafeDb.auditLog.create({ data: row })
}

/**
 * On a transaction of the unscoped client — for a pre-sign-in change that must
 * commit together with its row, like a recovery link issued from the terminal.
 */
export async function appendIn(tx: Prisma.TransactionClient, row: AuditRow): Promise<void> {
  await tx.auditLog.create({ data: row })
}

/** Newest first. The screen that reads these comes on Day 20; tests read them now. */
export async function listFor(db: ScopedDb, filter: { entityType?: string; entityId?: string; action?: string } = {}) {
  return db.auditLog.findMany({ where: filter, orderBy: { createdAt: 'desc' } })
}
