import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where a browser-test seed writes its fixture (the logins, ids and password
 * the suites read). Set by the e2e runner as E2E_WORK — e2e/.work, never
 * committed. Refuses to run without it, so a seed is never pointed at the
 * wrong place by accident.
 *
 * These seeds write test companies, so they only ever run against a LOCAL
 * database: the runner (e2e/scripts/seed.mjs) refuses any other host.
 */
export function fixturePath(name: string): string {
  const work = process.env.E2E_WORK
  if (!work) throw new Error('E2E_WORK is not set. Run the seeds through e2e/scripts/seed.mjs.')
  mkdirSync(work, { recursive: true })
  return join(work, name)
}

/** The database a seed is about to write to must be on this machine. */
export function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL
  const host = url ? new URL(url).hostname : ''
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`Refusing to seed "${host || 'no database'}": browser-test seeds run only against a local database.`)
  }
}
