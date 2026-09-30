import type { ScopedDb } from '../../platform/db/scoped'
import { storage } from '../../platform/storage'
import { logger } from '../../platform/logger'
import * as repo from './files.repository'

/**
 * Finds files no row points at, and removes them.
 *
 * Files are written before their rows (guide §A9), so a failed save can leave
 * one behind — a payslip PDF from a mark-paid that rolled back, an upload whose
 * row was refused, a bank proof that has since been replaced. Nothing ever
 * reads those; they are only an Aadhaar scan nobody is accounting for.
 *
 * A file younger than the grace period is left alone however it looks: it may
 * belong to a save that is still in progress.
 */

export interface SweepResult {
  scanned: number
  orphans: string[]
  deleted: number
}

export async function sweepOrganization(
  target: { db: ScopedDb; organizationId: string },
  options: { apply: boolean; graceHours?: number; now?: Date },
): Promise<SweepResult> {
  const now = options.now ?? new Date()
  const cutoff = now.getTime() - (options.graceHours ?? 24) * 3_600_000

  const [objects, referenced] = await Promise.all([
    storage().list(`org/${target.organizationId}/`),
    repo.referencedKeys(target.db),
  ])

  const orphans = objects.filter((o) => !referenced.has(o.key) && o.lastModified.getTime() < cutoff).map((o) => o.key)

  let deleted = 0
  if (options.apply) {
    for (const key of orphans) {
      await storage().delete(key)
      deleted++
    }
    if (deleted > 0) logger.info('Orphaned files removed', { organizationId: target.organizationId, deleted })
  }

  return { scanned: objects.length, orphans, deleted }
}
