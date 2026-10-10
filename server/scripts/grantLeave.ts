import { prisma, disconnect } from '../src/platform/db/prisma'
import { forOrg } from '../src/platform/db/scoped'
import { logger } from '../src/platform/logger'
import { grantWithNobodySignedIn } from '../src/modules/leave/leaveEntitlement.service'

/**
 * Grants the year's leave to everybody who has not had it yet.
 *
 *   npm run grant-leave              this leave year
 *   npm run grant-leave -- 2025      a specific one
 *
 * HR does this from the app (Leave → Team Balances → Grant leave), and since
 * 9 Oct 2026 the nightly job grants each new year by itself; this is the same
 * grant from the terminal, for a server with nobody signed in. All of them use
 * one plan (leaveEntitlement.service, over domain/leave/grant.ts), so they
 * cannot grant by different rules: each person's own days a year or the
 * type's, what the type gives a joiner, nothing for anybody who has already
 * left, and last year's unused days carried in up to each type's cap. Like
 * the button, it grants somebody with no joining date the full year.
 *
 * IDEMPOTENT, and that matters more here than anywhere else. Running it twice
 * would otherwise grant the year twice, and the error would show up as
 * everybody mysteriously having double their entitlement — which nobody
 * reports, because who complains about extra leave? The grant takes the same
 * lock as the button, so the two cannot overlap either.
 */
async function main(): Promise<void> {
  const requested = process.argv[2] ? Number(process.argv[2]) : undefined

  if (requested !== undefined && (Number.isNaN(requested) || requested < 2000 || requested > 2100)) {
    console.error('\n  Usage: npm run grant-leave -- [year]\n')
    process.exitCode = 1
    return
  }

  const organizations = await prisma.organization.findMany({ select: { id: true, name: true } })

  if (organizations.length === 0) {
    logger.info('No organizations yet; run npm run bootstrap first')
    return
  }

  for (const organization of organizations) {
    const summary = await grantWithNobodySignedIn(forOrg(organization.id), organization.id, {
      leaveYear: requested,
      withoutJoiningDate: true,
      apply: true,
      via: 'terminal',
    })

    console.log('')
    console.log(`  ${organization.name} — leave year ${summary.label}`)
    console.log(`    employees            ${summary.considered}`)
    console.log(`    granted to           ${summary.people} (${summary.days} days, ${summary.proRated} pro-rated)`)
    console.log(`    carried forward      ${summary.carried}`)
  }

  console.log('')
  console.log('  Safe to run again — nobody is granted twice.')
  console.log('')
}

main()
  .catch((err: unknown) => {
    logger.error('Leave grant failed', { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
  .finally(disconnect)
