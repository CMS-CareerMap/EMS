import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../../src/config/env'
import { storage } from '../../src/platform/storage'
import { logger } from '../../src/platform/logger'
import { disconnect, prisma } from '../../src/platform/db/prisma'
import { reportToEveryCompany } from './report'
import {
  BACKUP_PREFIX,
  LATEST_MIGRATION_SQL,
  TABLE_COUNTS_SQL,
  dumpKey,
  manifestKey,
  parseCounts,
  pgTarget,
  pgTool,
  planRetention,
  run,
  seal,
  sha256,
  stampInKey,
  stampOf,
  type Manifest,
  type PgTarget,
  PsqlSession,
} from './lib'

/**
 *   npm run backup              — dump the database to storage, then prune old ones
 *   npm run backup -- --list    — what backups there are
 *
 * One file per run: pg_dump's own format (compressed, and restorable table by
 * table), sealed with BACKUP_PASSPHRASE when it is set, and stored under
 * backups/db/ in the same private storage as the documents — R2 in production,
 * which is replicated and off the server. A manifest beside it records every
 * table's row count and the latest migration, which is what a restore is
 * checked against: a restore is not "it ran", it is "every row came back".
 *
 * Files need no backup of their own: they live in R2, not on the server.
 * Meant for a nightly cron (deploy/crontab).
 */

export async function tableCounts(target: PgTarget): Promise<Record<string, number>> {
  const out = await run(pgTool('psql', env.PG_BIN), ['-X', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', TABLE_COUNTS_SQL, target.url], target.password)
  return parseCounts(out)
}

export async function latestMigration(target: PgTarget): Promise<string | null> {
  const out = await run(pgTool('psql', env.PG_BIN), ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', LATEST_MIGRATION_SQL, target.url], target.password)
  return out.trim() || null
}

/** Every backup in storage, newest first. */
export async function listBackups(): Promise<string[]> {
  const objects = await storage().list(BACKUP_PREFIX)
  const dumps = new Set<string>()
  const manifests = new Set<string>()
  for (const o of objects) {
    const stamp = stampInKey(o.key)
    if (!stamp) continue
    if (o.key.endsWith('.dump')) dumps.add(stamp)
    else manifests.add(stamp)
  }
  // A dump without its manifest cannot be checked, so it is not offered.
  return [...dumps].filter((s) => manifests.has(s)).sort().reverse()
}

export async function takeBackup(now = new Date()): Promise<Manifest> {
  const source = pgTarget(env.DIRECT_URL)
  const stamp = stampOf(now)
  const work = await mkdtemp(join(tmpdir(), 'ems-backup-'))

  try {
    const file = join(work, `${stamp}.dump`)
    const version = (await run(pgTool('pg_dump', env.PG_BIN), ['--version'], '')).trim()

    // The rows are counted, and then dumped, in ONE snapshot: a transaction
    // that exports its view of the database for pg_dump to share. Whatever is
    // written meanwhile is in neither, so the counts describe exactly the dump.
    const session = new PsqlSession(pgTool('psql', env.PG_BIN), source)
    let tables: Record<string, number>
    let migration: string | null
    try {
      await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const snapshot = (await session.query('SELECT pg_export_snapshot()')).trim()
      tables = parseCounts(await session.query(TABLE_COUNTS_SQL))
      migration = (await session.query(LATEST_MIGRATION_SQL)).trim() || null
      await run(pgTool('pg_dump', env.PG_BIN), ['--format=custom', '--no-owner', '--no-privileges', '--compress=6', `--snapshot=${snapshot}`, `--file=${file}`, `--dbname=${source.url}`], source.password)
      await session.query('COMMIT')
    } finally {
      await session.close()
    }

    const dump = await readFile(file)
    const stored = env.BACKUP_PASSPHRASE ? seal(dump, env.BACKUP_PASSPHRASE) : dump
    const manifest: Manifest = {
      version: 1,
      stamp,
      createdAt: now.toISOString(),
      source: { host: source.host, port: source.port, database: source.database },
      pgDump: version,
      latestMigration: migration,
      sealed: Boolean(env.BACKUP_PASSPHRASE),
      dumpSha256: sha256(dump),
      dumpBytes: dump.length,
      storedSha256: sha256(stored),
      storedBytes: stored.length,
      tables,
    }

    await storage().put(dumpKey(stamp), stored, 'application/octet-stream')
    await storage().put(manifestKey(stamp), Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json')
    return manifest
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** The company's clock, for which month a backup belongs to. One company for now. */
async function companyTimezone(): Promise<string> {
  const company = await prisma.organization.findFirst({ select: { timezone: true }, orderBy: { createdAt: 'asc' } })
  return company?.timezone ?? 'Asia/Kolkata'
}

async function prune(): Promise<{ kept: number; removed: string[] }> {
  const plan = planRetention(await listBackups(), { daily: env.BACKUP_KEEP_DAILY, monthly: env.BACKUP_KEEP_MONTHLY, timezone: await companyTimezone() })
  for (const stamp of plan.remove) {
    await storage().delete(dumpKey(stamp))
    await storage().delete(manifestKey(stamp))
  }
  return { kept: plan.keep.length, removed: plan.remove }
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    const stamps = await listBackups()
    if (stamps.length === 0) logger.info('No backups yet')
    for (const stamp of stamps) {
      const manifest = JSON.parse((await storage().get(manifestKey(stamp))).toString('utf8')) as Manifest
      const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0)
      console.log(`${stamp}  ${(manifest.storedBytes / 1024).toFixed(0).padStart(7)} KB  ${String(rows).padStart(8)} rows  ${manifest.sealed ? 'sealed' : 'NOT sealed'}  ${manifest.latestMigration ?? ''}`)
    }
    return
  }

  if (!env.BACKUP_PASSPHRASE) {
    logger.warn('BACKUP_PASSPHRASE is not set: this backup is stored unsealed. Anyone with the storage key could read it.')
  }
  const manifest = await takeBackup()
  const pruned = await prune()
  await reportToEveryCompany('backup.taken', {
    stamp: manifest.stamp,
    tables: Object.keys(manifest.tables).length,
    rows: Object.values(manifest.tables).reduce((a, b) => a + b, 0),
    kilobytes: Math.round(manifest.storedBytes / 1024),
    sealed: manifest.sealed,
    backupsKept: pruned.kept,
  })
  logger.info('Backup stored', {
    key: dumpKey(manifest.stamp),
    tables: Object.keys(manifest.tables).length,
    rows: Object.values(manifest.tables).reduce((a, b) => a + b, 0),
    kilobytes: Math.round(manifest.storedBytes / 1024),
    sealed: manifest.sealed,
    latestMigration: manifest.latestMigration,
    backupsKept: pruned.kept,
    backupsRemoved: pruned.removed.length,
  })
}

// Run directly (npm run backup), not when the drill imports these functions.
if (process.argv[1] && /backup[\\/]backup\.ts$/.test(process.argv[1])) {
  main()
    .catch(async (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err)
      logger.error('Backup FAILED', { error })
      process.exitCode = 1
      if (!process.argv.includes('--list')) await reportToEveryCompany('backup.failed', { error })
    })
    .finally(disconnect)
}
