import { unsafeDb } from './unsafe'

/**
 * Whether the database answers — what /health reports beyond "the process is
 * up". Docker's health check and the deploy script (deploy/deploy.sh) wait on
 * /health, so a new version that cannot reach its database, or whose query
 * engine did not load, is never reported as running.
 */
export async function databaseAnswers(): Promise<boolean> {
  try {
    await unsafeDb.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}
