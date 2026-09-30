import { prisma, disconnect } from '../src/platform/db/prisma'
import { forOrg } from '../src/platform/db/scoped'
import { logger } from '../src/platform/logger'
import { sweepOrganization } from '../src/modules/files/sweeper.service'
import { sweepOldNotices } from '../src/modules/notifications/notification.service'

/**
 *   npm run maintenance              — what would be done, nothing changed
 *   npm run maintenance -- --apply   — do it
 *
 * For every company:
 *   · files in storage that no row points at, older than a day, are removed
 *   · notices older than the retention period are cleared
 *
 * Meant for a daily cron on the server once it is live (Day 20). Safe to run
 * any time: it never touches a file a row still points at.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const organizations = await prisma.organization.findMany({ select: { id: true, name: true } })

  for (const organization of organizations) {
    const db = forOrg(organization.id)
    const swept = await sweepOrganization({ db, organizationId: organization.id }, { apply })
    const notices = await sweepOldNotices({ db }, { apply })

    logger.info(apply ? 'Maintenance done' : 'Maintenance (dry run — add --apply to do it)', {
      organization: organization.name,
      filesScanned: swept.scanned,
      orphanedFiles: swept.orphans.length,
      filesRemoved: swept.deleted,
      oldNotifications: notices.found,
      notificationsCleared: notices.cleared,
    })
  }
}

main()
  .catch((err: unknown) => {
    logger.error('Maintenance failed', { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
  .finally(disconnect)
