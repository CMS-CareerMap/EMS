import { prisma, disconnect } from '../src/platform/db/prisma'
import { forOrg } from '../src/platform/db/scoped'
import { logger } from '../src/platform/logger'
import { sweepOrganization } from '../src/modules/files/sweeper.service'
import { sweepOldNotices } from '../src/modules/notifications/notification.service'
import { grantWithNobodySignedIn, remindLeaveYearEnd } from '../src/modules/leave/leaveEntitlement.service'
import { purgeOldPunchPhotos } from '../src/modules/attendance/punchPhotos.service'
import { reconcileAbsent } from '../src/modules/attendance/absentRule.service'
import { keepHolidayYear } from '../src/modules/holidays/holidayYear.service'

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
 *   · punch selfies older than the company's days for keeping them
 *     (Settings → Attendance Security, 60 to start) are deleted.
 *   · no check-in means absent (client, 25 Oct 2026), when the company has it
 *     on: every working day that has ended with no punch, no leave and
 *     nobody's mark is made Absent — and what the rule no longer says is
 *     taken back — in every month whose payroll is still open.
 *   · the next year's three fixed national holidays from October, once; in
 *     December, whoever keeps the calendar is told if the festivals are missing.
 *
 * Meant for a daily cron on the server once it is live (Day 20). Safe to run
 * any time: it never touches a file a row still points at, and grants nothing
 * twice.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const organizations = await prisma.organization.findMany({ select: { id: true, name: true } })

  for (const organization of organizations) {
    // One company's failure is logged and the run goes on to the next: the
    // job still fails at the end, so it is seen.
    try {
      const db = forOrg(organization.id)
      const swept = await sweepOrganization({ db, organizationId: organization.id }, { apply })
      const notices = await sweepOldNotices({ db }, { apply })
      const leave = await grantWithNobodySignedIn(db, organization.id, { withoutJoiningDate: false, apply, via: 'nightly' })
      const lapsing = await remindLeaveYearEnd(db, organization.id, { apply })
      const selfies = await purgeOldPunchPhotos(db, organization.id, { apply })
      const absent = await reconcileAbsent(db, organization.id, { apply, trigger: 'nightly' })
      const holidays = await keepHolidayYear(db, organization.id, { apply })

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
        oldSelfies: selfies.found,
        selfiesDeleted: selfies.deleted,
        absentMarked: absent.marked,
        absentTakenBack: absent.removed,
        absentClosedMonths: absent.closedMonths.length,
        fixedHolidaysAdded: holidays.added,
        holidayReminder: holidays.reminded,
      })
    } catch (err: unknown) {
      logger.error('Maintenance failed for a company', { organization: organization.name, error: err instanceof Error ? err.message : String(err) })
      process.exitCode = 1
    }
  }
}

main()
  .catch((err: unknown) => {
    logger.error('Maintenance failed', { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
  .finally(disconnect)
