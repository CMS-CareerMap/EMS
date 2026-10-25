import { prisma, disconnect } from '../src/platform/db/prisma'
import { forOrg } from '../src/platform/db/scoped'
import { logger } from '../src/platform/logger'
import { nudgeCheckOuts } from '../src/modules/attendance/checkOutNudge.service'

/**
 *   npm run hourly              — who would be told, nothing sent
 *   npm run hourly -- --apply   — send it
 *
 * Every hour, for every company (client, 25 Oct 2026): somebody who checked
 * in on the app and has not checked out two hours after their shift ended is
 * told once — while they can still check out, or ask for a correction. The day
 * stays Present; HR sees it under "No out" on the roster.
 *
 * On the server: deploy/crontab. Safe to run any time: each day is told once.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const organizations = await prisma.organization.findMany({ select: { id: true, name: true } })

  for (const organization of organizations) {
    // One company's failure is logged and the run goes on to the next: the job still fails at the end, so it is seen.
    try {
      const reminders = await nudgeCheckOuts(forOrg(organization.id), organization.id, { apply })
      logger.info(apply ? 'Hourly done' : 'Hourly (dry run — add --apply to do it)', {
        organization: organization.name,
        noCheckOutDue: reminders.due,
        noCheckOutTold: reminders.told,
      })
    } catch (err: unknown) {
      logger.error('Hourly failed for a company', { organization: organization.name, error: err instanceof Error ? err.message : String(err) })
      process.exitCode = 1
    }
  }
}

main()
  .catch((err: unknown) => {
    logger.error('Hourly failed', { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
  .finally(disconnect)
