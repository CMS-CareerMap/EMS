import { randomUUID } from 'node:crypto'
import { env } from '../src/config/env'
import { storage } from '../src/platform/storage'
import { logger } from '../src/platform/logger'

/**
 *   npm run storage:check
 *
 * Proves the configured storage works end to end BEFORE anybody uploads an
 * Aadhaar scan: writes a small object, reads it back byte for byte, checks it
 * exists, deletes it, and checks it is gone. Run it once the R2 keys are in
 * .env on the server — a wrong key found here costs a minute; found by the
 * first employee's upload, it costs trust.
 */
async function main(): Promise<void> {
  const key = `healthcheck/${randomUUID()}.txt`
  const body = Buffer.from(`EMS storage check ${new Date().getTime()}`)
  const store = storage()

  logger.info('Checking storage', { driver: env.STORAGE_DRIVER, bucket: env.STORAGE_DRIVER === 'r2' ? env.R2_BUCKET : env.STORAGE_PATH })

  await store.put(key, body, 'text/plain')
  const read = await store.get(key)
  if (!read.equals(body)) throw new Error('The object read back is not the one written')
  if (!(await store.exists(key))) throw new Error('The object was written but is not found')
  const listed = await store.list('healthcheck/')
  if (!listed.some((o) => o.key === key)) throw new Error('The object was written but is not listed')
  await store.delete(key)
  if (await store.exists(key)) throw new Error('The object was deleted but is still there')

  logger.info('Storage works: write, read, list and delete all succeeded')
}

main().catch((err: unknown) => {
  logger.error('Storage check FAILED', { error: err instanceof Error ? err.message : String(err) })
  process.exitCode = 1
})
