import { PrismaClient } from '@prisma/client'
import { env } from '../../config/env'

/**
 * The raw, UNSCOPED Prisma client.
 *
 * Only two files may import this: scoped.ts and unsafe.ts. Everything else gets
 * a company-scoped handle, so a query that crosses companies is not merely
 * discouraged — it has no way to be written.
 *
 * A lint rule enforces the import restriction. If you find yourself wanting the
 * raw client somewhere else, that is the signal to add a repository instead.
 */
export const prisma = new PrismaClient({
  datasourceUrl: withPoolSize(env.DATABASE_URL),
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})

/**
 * The connection pool, sized on purpose unless the address sets its own
 * `connection_limit`. Prisma's default is two per CPU plus one — three on a
 * one-CPU server. Approving a month's payroll holds one connection for its
 * transaction and reads on up to eight more at once while it plans the month,
 * and every pay input saved for that month meanwhile waits on the month's
 * lock holding one of its own. Too few, and the approval waits for a
 * connection the waiting saves will not give back until it is done: it times
 * out and fails. Twenty leaves room for several saves at that moment, and is
 * far below what Postgres allows.
 */
function withPoolSize(url: string): string {
  if (/[?&]connection_limit=/.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=20`
}

/** Called on shutdown so the process can exit cleanly. */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
}
