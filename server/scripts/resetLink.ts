import { z } from 'zod'
import { env } from '../src/config/env'
import { disconnect } from '../src/platform/db/prisma'
import { logger } from '../src/platform/logger'
import { issueRecoveryLink, RECOVERY_LINK_MINUTES } from '../src/modules/user/recovery.service'

/**
 *   npm run reset-link -- someone@company.in
 *
 * A one-hour, single-use password link for any account, printed here. For the
 * day nobody can sign in to issue one — the only Super Admin forgot their
 * password. See recovery.service.ts for what it will and will not do.
 *
 * The link opens the web app at CORS_ORIGIN, which is where the app is served.
 */

async function main(): Promise<void> {
  const parsed = z.email().safeParse(process.argv[2] ?? '')
  if (!parsed.success) {
    console.error('\n  Usage: npm run reset-link -- someone@company.in\n')
    process.exitCode = 1
    return
  }

  const result = await issueRecoveryLink(parsed.data, { webOrigin: env.CORS_ORIGIN })

  console.log(`
  ${result.purpose === 'invite' ? 'Invitation' : 'Password reset'} link for ${result.email} (${result.role})

    ${result.link}

  Works once, for ${RECOVERY_LINK_MINUTES} minutes. Open it in a browser and choose a
  new password; every session this account has ends when it is used. Any
  earlier link for this account has stopped working. The audit log records
  that this link was issued from the terminal.
`)
}

main()
  .catch((err: unknown) => {
    logger.error('Could not issue the link', { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
  .finally(disconnect)
