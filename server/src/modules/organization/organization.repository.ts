import { createHash } from 'node:crypto'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { holdsSuperAdmin } from '../../domain/org/logins'

/**
 * The company row itself.
 *
 * Organization is a GLOBAL model — it is the tenant, not a row inside one — so
 * the scoped client cannot fill its id in, and it is passed explicitly.
 */

export async function findTimezone(db: ScopedDb, organizationId: string): Promise<string | null> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  })
  return organization?.timezone ?? null
}

/**
 * The owner mark and Settings → Approvals (Day 22).
 *
 * The owner counts only while they still are one: here, and holding the Super
 * Admin panel on a live login. Somebody marked and then demoted, switched off
 * or let go is nobody's owner — their leave goes back to needing approval —
 * without anybody having to remember to clear the mark. Nor is somebody who
 * was placed under a manager while the mark did not count: the owner sits at
 * the top, and a mark that came back to life under somebody would let them
 * skip the approval of the person they report to.
 *
 * `version` is made from these settings alone, not from the company row's
 * last change: saving the company's address must not make an open Company
 * tree or Approvals screen "out of date".
 */
export async function findApprovalRules(db: TxDb, organizationId: string) {
  const row = await db.organization.findUnique({
    where: { id: organizationId },
    select: {
      ownerEmployeeId: true,
      owner: { select: { archivedAt: true, reportingManagerId: true, memberships: { select: { status: true, roleDef: { select: { locked: true } } } } } },
      leaveNoManagerApproverId: true,
      leaveBackup: true,
      leaveReversal: true,
    },
  })
  if (!row) return null
  const { owner, ...rules } = row
  // By either of their logins (Day 23): the owner's employee login is not the Super Admin one.
  const stillOwner = Boolean(owner && !owner.archivedAt && !owner.reportingManagerId && holdsSuperAdmin(owner.memberships))
  const version = createHash('sha256')
    .update(JSON.stringify([rules.ownerEmployeeId, rules.leaveNoManagerApproverId, rules.leaveBackup, rules.leaveReversal]))
    .digest('hex')
    .slice(0, 16)
  return { ...rules, ownerEmployeeId: stillOwner ? rules.ownerEmployeeId : null, version }
}

export async function updateApprovalRules(
  db: TxDb,
  organizationId: string,
  data: Partial<{
    ownerEmployeeId: string | null
    leaveNoManagerApproverId: string | null
    leaveBackup: 'super_admin' | 'next_up' | 'none'
    leaveReversal: 'manager_or_super_admin' | 'super_admin_only'
  }>,
): Promise<void> {
  await db.organization.update({ where: { id: organizationId }, data })
}

export async function findUploadLimit(db: ScopedDb, organizationId: string): Promise<number | null> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { maxUploadMb: true },
  })
  return organization?.maxUploadMb ?? null
}
