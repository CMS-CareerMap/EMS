import { prisma, disconnect } from '../../src/platform/db/prisma'
import { logger } from '../../src/platform/logger'
import { seedForOrganization } from './referenceData'

/**
 *   npx prisma db seed
 *
 * Reference data for every company already in the database — wired into
 * `prisma.seed`, so `prisma migrate reset` rebuilds the schema and repopulates
 * this. A new company gets the same data from `npm run bootstrap`, in the
 * transaction that creates it; this is for the ones that exist.
 *
 * Safe to run on a company in use: see referenceData.ts for what it will and
 * will not touch.
 */
async function seedReference(): Promise<void> {
  const organizations = await prisma.organization.findMany({ select: { id: true, name: true, timezone: true } })

  if (organizations.length === 0) {
    // Not an error. A fresh database has no company until bootstrap runs, and
    // bootstrap writes this data itself.
    logger.info('No organizations yet; run npm run bootstrap')
    return
  }

  for (const organization of organizations) {
    await seedForOrganization(prisma, organization)
    logger.info('Reference data seeded', { organization: organization.name })
  }
}

seedReference()
  .catch((err: unknown) => {
    logger.error('Seeding failed', { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
  .finally(disconnect)
