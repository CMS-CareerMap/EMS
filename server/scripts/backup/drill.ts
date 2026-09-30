import { env } from '../../src/config/env'
import { logger } from '../../src/platform/logger'
import { disconnect } from '../../src/platform/db/prisma'
import { reportToEveryCompany } from './report'
import { listBackups, takeBackup } from './backup'
import { restoreBackup } from './restore'
import { onSameServer, pgTarget, pgTool, run } from './lib'

/**
 *   npm run backup:drill              take a backup now, restore it into a scratch database, check it, drop it
 *   npm run backup:drill -- --latest  use the newest stored backup instead of taking one
 *   npm run backup:drill -- --keep    leave the scratch database, to start the app against it
 *
 * A backup nobody has restored is a hope. This is the restore, done for real,
 * every month (deploy/crontab): the dump is fetched from storage, opened,
 * restored into a database of its own, and every table's row count compared
 * with what was dumped. It fails loudly if one row is missing.
 *
 * The scratch database is `<name>_restore_drill` on the same server; the
 * database user needs permission to create databases (CREATEDB).
 */

const quote = (name: string) => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unexpected database name: ${name}`)
  return `"${name}"`
}

async function main(): Promise<void> {
  const source = pgTarget(env.DIRECT_URL)
  const scratchName = `${source.database}_restore_drill`
  const admin = onSameServer(source, 'postgres')
  const scratch = onSameServer(source, scratchName)
  const psql = (sql: string) => run(pgTool('psql', env.PG_BIN), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql, admin.url], admin.password)

  const stamp = process.argv.includes('--latest') ? (await listBackups())[0] : (await takeBackup()).stamp
  if (!stamp) throw new Error('There is no stored backup to drill with')

  // Ours by its name: a drill left behind by --keep is replaced, never anything else.
  // WITH (FORCE): an app still connected to a copy kept with --keep does not block it.
  await psql(`DROP DATABASE IF EXISTS ${quote(scratchName)} WITH (FORCE)`)
  await psql(`CREATE DATABASE ${quote(scratchName)}`)

  let passed = false
  try {
    const result = await restoreBackup(stamp, scratch)
    const rows = Object.values(result.counts).reduce((a, b) => a + b, 0)
    if (result.problems.length) {
      logger.error('Restore drill FAILED — the backup did not come back whole', { backup: stamp, problems: result.problems })
      process.exitCode = 1
      await reportToEveryCompany('backup.drill_failed', { stamp, error: `${result.problems.length} difference(s): ${result.problems.slice(0, 3).join('; ')}` })
      return
    }
    passed = true
    await reportToEveryCompany('backup.drill_passed', { stamp, tables: Object.keys(result.counts).length, rows })
    logger.info('Restore drill passed: the backup came back whole', {
      backup: stamp,
      tables: Object.keys(result.counts).length,
      rows,
      latestMigration: result.manifest.latestMigration,
      sealed: result.manifest.sealed,
      restoredInto: process.argv.includes('--keep') ? scratchName : '(dropped)',
    })
  } finally {
    if (!process.argv.includes('--keep') || !passed) await psql(`DROP DATABASE IF EXISTS ${quote(scratchName)} WITH (FORCE)`)
  }
}

main()
  .catch(async (err: unknown) => {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Restore drill FAILED', { error })
    process.exitCode = 1
    await reportToEveryCompany('backup.drill_failed', { error })
  })
  .finally(disconnect)
