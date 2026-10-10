import { prisma, disconnect } from '../src/platform/db/prisma'
import { forOrg } from '../src/platform/db/scoped'
import { logger } from '../src/platform/logger'
import { sweepOrganization } from '../src/modules/files/sweeper.service'
import { sweepOldNotices } from '../src/modules/notifications/notification.service'
import { grantWithNobodySignedIn, remindLeaveYearEnd } from '../src/modules/leave/leaveEntitlement.service'

/**
 *   npm run maintenance              — what would be done, nothing changed
 *   npm run maintenance -- --apply   — do it
 *
 * For every company:
 *   · files in storage that no row points at, older than a day, are removed
 *   · notices older than the retention period are cleared
 *   · this leave year is granted to everybody with a joining date who has not
 *     had it (client, 9 Oct 2026): a new year — with its carry forward — is in
 *     every balance on its first morning, and anybody missed is caught. Never
 *     twice; somebody with no joining date waits for HR's Grant leave.
 *   · in the last days of the leave year (Settings → Leave Config, 30 to
 *     start), each employee is told once of the days that will lapse.
 *
 * Meant for a daily cron on the server once it is live (Day 20). Safe to run
 * any time: it never touches a file a row still points at, and grants nothing
 * twice.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const organizations = await prisma.organization.findMany({ select: { id: true, name: true } })

  for (const organization of organizations) {
    const db = forOrg(organization.id)
    const swept = await sweepOrganization({ db, organizationId: organization.id }, { apply })
    const notices = await sweepOldNotices({ db }, { apply })
    const leave = await grantWithNobodySignedIn(db, organization.id, { withoutJoiningDate: false, apply, via: 'nightly' })
    const lapsing = await remindLeaveYearEnd(db, organization.id, { apply })

    logger.info(apply ? 'Maintenance done' : 'Maintenance (dry run — add --apply to do it)', {
      organization: organization.name,
      filesScanned: swept.scanned,
      orphanedFiles: swept.orphans.length,
      filesRemoved: swept.deleted,
      oldNotifications: notices.found,
      notificationsCleared: notices.cleared,
      leaveYear: leave.label,
      leaveGrantedTo: leave.people,
      leaveDaysGranted: leave.days,
      leaveLapsingToldTo: lapsing.people,
    })
  }
}

main()
  .catch((err: unknown) => {
    logger.error('Maintenance failed', { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
  .finally(disconnect)
