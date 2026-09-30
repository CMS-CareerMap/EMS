import { prisma } from '../../src/platform/db/prisma'
import { logger } from '../../src/platform/logger'
import { recordSecurityEvent } from '../../src/modules/audit/audit.service'
import type { AuditAction } from '../../src/domain/audit/catalogue'

/**
 * A backup job's outcome, written to every company's audit log — where Super
 * Admin looks (Settings → Audit Log, "System jobs"). A backup that quietly
 * stopped working months ago, noticed only on the day it is needed, is the
 * failure this is here to prevent. The log file on the server says the same,
 * for whoever runs the machine.
 *
 * Never fails the job: if the database cannot take the row, the job's own log
 * line still stands.
 */
export async function reportToEveryCompany(action: AuditAction, details: Record<string, unknown>): Promise<void> {
  try {
    const companies = await prisma.organization.findMany({ select: { id: true } })
    for (const company of companies) {
      await recordSecurityEvent({ organizationId: company.id, actorUserId: null, action, details })
    }
  } catch (err) {
    logger.warn('The job could not be recorded in the audit log', { action, error: err instanceof Error ? err.message : String(err) })
  }
}
