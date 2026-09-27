import { z } from 'zod'
import { prisma, disconnect } from '../src/platform/db/prisma'
import { hashPassword, passwordProblem } from '../src/platform/auth/password'
import { logger } from '../src/platform/logger'
import { seedForOrganization } from '../prisma/seed/referenceData'

/**
 * Creates the organization, its first administrator and the reference data it
 * needs on day one, from nothing.
 *
 * The audit found that this system could not be started at all: every path to
 * an account required an account that already existed. There is no signup page,
 * the invite flow has no caller, and the create-employee RPC sits behind a role
 * nobody holds yet. This command is that missing first step.
 *
 * It is also the multi-tenant seam made executable. The SaaS phase calls this
 * same function from a signup route instead of a terminal — which is why the
 * work lives in bootstrapOrganization() rather than inline in the script.
 *
 *   npm run bootstrap
 *
 * Credentials come from the environment, never from a literal in this file:
 *   BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD
 *   BOOTSTRAP_ORG_NAME (optional)
 */

const inputSchema = z.object({
  BOOTSTRAP_ADMIN_EMAIL: z.email('BOOTSTRAP_ADMIN_EMAIL must be a valid email address'),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(1, 'BOOTSTRAP_ADMIN_PASSWORD is required'),
  BOOTSTRAP_ORG_NAME: z.string().min(1).default('CareerMap Solutions'),
})

export interface BootstrapResult {
  organizationId: string
  userId: string
  membershipId: string
}

export async function bootstrapOrganization(input: {
  organizationName: string
  adminEmail: string
  adminPassword: string
}): Promise<BootstrapResult> {
  const problem = passwordProblem(input.adminPassword)
  if (problem) throw new Error(problem)

  // Hashed before the transaction opens: it is deliberately slow, and nothing
  // is gained by holding a transaction open while it runs.
  const passwordHash = await hashPassword(input.adminPassword)

  // One transaction: either the company exists with a usable administrator and
  // everything it needs on day one — its rates, leave types, holidays — or
  // nothing was created. A half-bootstrapped database is worse than an empty
  // one. The reference data used to be a second command to remember.
  return prisma.$transaction(async (tx) => {
    const existing = await tx.organization.count()
    if (existing > 0) {
      throw new Error(
        'An organization already exists. Bootstrap runs once; use the application to add users.',
      )
    }

    const organization = await tx.organization.create({
      data: { name: input.organizationName },
    })

    await seedForOrganization(tx, organization)

    const user = await tx.user.create({
      data: {
        email: input.adminEmail.toLowerCase(),
        passwordHash,
      },
    })

    const membership = await tx.membership.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        role: 'super_admin',
        status: 'active',
      },
    })

    // Deliberately no Employee record. The first administrator is an operator,
    // not a member of staff — and keeping identity separate from the HR record
    // is exactly what lets someone have access without being on the payroll.

    return {
      organizationId: organization.id,
      userId: user.id,
      membershipId: membership.id,
    }
    // About forty writes; well past Prisma's five-second default on a remote
    // database that has to wake up first.
  }, { timeout: 60_000, maxWait: 10_000 })
}

async function main(): Promise<void> {
  const parsed = inputSchema.safeParse(process.env)

  if (!parsed.success) {
    console.error('\n  Cannot bootstrap — missing or invalid configuration:\n')
    for (const issue of parsed.error.issues) {
      console.error(`    ${issue.path.join('.')}: ${issue.message}`)
    }
    console.error('\n  Set these in server/.env, run the command, then remove them again.\n')
    process.exitCode = 1
    return
  }

  const env = parsed.data

  const result = await bootstrapOrganization({
    organizationName: env.BOOTSTRAP_ORG_NAME,
    adminEmail: env.BOOTSTRAP_ADMIN_EMAIL,
    adminPassword: env.BOOTSTRAP_ADMIN_PASSWORD,
  })

  logger.info('Bootstrap complete', {
    organization: env.BOOTSTRAP_ORG_NAME,
    admin: env.BOOTSTRAP_ADMIN_EMAIL,
    ...result,
  })

  console.log(
    '\n  Remove BOOTSTRAP_ADMIN_PASSWORD from .env now — it has done its job.\n',
  )
}

main()
  .catch((err: unknown) => {
    logger.error('Bootstrap failed', { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
  .finally(disconnect)
