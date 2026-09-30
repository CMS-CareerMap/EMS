import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../../src/config/env'
import { storage } from '../../src/platform/storage'
import { logger } from '../../src/platform/logger'
import { latestMigration, listBackups, tableCounts } from './backup'
import {
  compareCounts,
  dumpKey,
  manifestKey,
  onSameServer,
  pgTarget,
  pgTool,
  run,
  sameDatabase,
  sha256,
  unseal,
  type Manifest,
  type PgTarget,
} from './lib'

/**
 *   npm run restore -- --target-db ems_restored                 newest backup, into a new database on this server
 *   npm run restore -- --from 2026-09-30T02-30-00Z --target-db ems_restored
 *   RESTORE_TARGET_URL=postgresql://… npm run restore           into a database elsewhere
 *
 * A restore goes into an EMPTY database — never over the one the app is
 * running on, and never over one that already holds tables. Replacing live
 * data is done by restoring beside it, checking, and then pointing the app at
 * the restored database (deploy/DEPLOY.md, "Restoring"). A restore that could
 * overwrite by mistake is a second disaster, not a recovery.
 *
 * Afterwards every table's row count is compared with the count taken when the
 * backup was made, and the latest migration with the one recorded. Anything
 * different fails the restore, loudly.
 */

export interface RestoreResult {
  manifest: Manifest
  counts: Record<string, number>
  problems: string[]
}

async function tablesIn(target: PgTarget): Promise<number> {
  const out = await run(pgTool('psql', env.PG_BIN), ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'", target.url], target.password)
  return Number(out.trim())
}

export async function restoreBackup(stamp: string, target: PgTarget): Promise<RestoreResult> {
  for (const live of [pgTarget(env.DATABASE_URL), pgTarget(env.DIRECT_URL)]) {
    if (sameDatabase(live, target)) {
      throw new Error(`Refusing to restore into ${target.database}: it is the database this server runs on. Restore into a new database, check it, then switch (see deploy/DEPLOY.md).`)
    }
  }
  const existing = await tablesIn(target)
  if (existing > 0) {
    throw new Error(`Refusing to restore into ${target.database}: it already holds ${existing} tables. Restore needs an empty database — create one first.`)
  }

  const manifest = JSON.parse((await storage().get(manifestKey(stamp))).toString('utf8')) as Manifest
  const stored = await storage().get(dumpKey(stamp))
  if (sha256(stored) !== manifest.storedSha256) {
    throw new Error(`Backup ${stamp} does not match its manifest: the stored file is damaged or was altered. Try an earlier one.`)
  }
  let dump = stored
  if (manifest.sealed) {
    if (!env.BACKUP_PASSPHRASE) throw new Error(`Backup ${stamp} is sealed; set BACKUP_PASSPHRASE to the company's backup passphrase.`)
    dump = unseal(stored, env.BACKUP_PASSPHRASE)
  }
  if (sha256(dump) !== manifest.dumpSha256) throw new Error(`Backup ${stamp} opened, but its contents do not match what was dumped.`)

  const work = await mkdtemp(join(tmpdir(), 'ems-restore-'))
  try {
    const file = join(work, `${stamp}.dump`)
    await writeFile(file, dump)
    // One transaction: a restore that fails half way leaves nothing behind.
    await run(pgTool('pg_restore', env.PG_BIN), ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--dbname=${target.url}`, file], target.password)
  } finally {
    await rm(work, { recursive: true, force: true })
  }

  const [counts, migration] = await Promise.all([tableCounts(target), latestMigration(target)])
  const problems = compareCounts(manifest.tables, counts)
  if (migration !== manifest.latestMigration) problems.push(`latest migration: ${manifest.latestMigration ?? 'none'} backed up, ${migration ?? 'none'} restored`)
  return { manifest, counts, problems }
}

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

async function main(): Promise<void> {
  const fromArg = argument('--from') ?? 'latest'
  const targetDb = argument('--target-db')
  const targetUrl = process.env.RESTORE_TARGET_URL
  if (!targetDb && !targetUrl) throw new Error('Say where to restore: --target-db <new database on this server>, or RESTORE_TARGET_URL')

  const target = targetUrl ? pgTarget(targetUrl) : onSameServer(pgTarget(env.DIRECT_URL), targetDb!)
  const stamps = await listBackups()
  const stamp = fromArg === 'latest' ? stamps[0] : stamps.find((s) => s === fromArg)
  if (!stamp) throw new Error(fromArg === 'latest' ? 'There are no backups to restore' : `No backup ${fromArg} — see npm run backup -- --list`)

  logger.info('Restoring', { backup: stamp, into: `${target.host}:${target.port}/${target.database}` })
  const result = await restoreBackup(stamp, target)
  const rows = Object.values(result.counts).reduce((a, b) => a + b, 0)
  if (result.problems.length) {
    logger.error('Restore FINISHED WITH DIFFERENCES — do not use this copy', { backup: stamp, problems: result.problems })
    process.exitCode = 1
    return
  }
  logger.info('Restore checked: every table matches the backup', {
    backup: stamp,
    database: target.database,
    tables: Object.keys(result.counts).length,
    rows,
    latestMigration: result.manifest.latestMigration,
  })
}

if (process.argv[1] && /backup[\\/]restore\.ts$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    logger.error('Restore FAILED', { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
}
