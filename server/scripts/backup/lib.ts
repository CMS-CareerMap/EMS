import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { join } from 'node:path'

/**
 * The parts of backup and restore that do not touch a database or a bucket —
 * kept apart so they can be tested on their own (lib.test.ts).
 */

// ── Where backups live ───────────────────────────────────────────────────────

/** Outside `org/`, so the orphan-file sweeper never looks here. */
export const BACKUP_PREFIX = 'backups/db/'

/** "2026-09-30T02-30-00Z" — sorts as a string, and is safe in a key. */
export function stampOf(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
}

export function dateOfStamp(stamp: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(stamp)
  if (!m) throw new Error(`Not a backup stamp: ${stamp}`)
  return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`)
}

export function dumpKey(stamp: string): string {
  return `${BACKUP_PREFIX}${stamp.slice(0, 4)}/${stamp.slice(5, 7)}/${stamp}.dump`
}

export function manifestKey(stamp: string): string {
  return dumpKey(stamp).replace(/\.dump$/, '.json')
}

/** The stamp in a stored key, or null for anything that is not one of ours. */
export function stampInKey(key: string): string | null {
  const m = /^backups\/db\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.(dump|json)$/.exec(key)
  return m?.[1] ?? null
}

// ── Which to keep ────────────────────────────────────────────────────────────

/**
 * The newest `daily` backups, and the first backup of each of the newest
 * `monthly` months — a month's first, because it is the state that month
 * began in, which is what an accountant asks for. The newest is kept whatever
 * the numbers say. Everything else is removed.
 *
 * The month is the COMPANY's: stamps are UTC, and the nightly job runs at
 * 02:30 in India, which is still the previous day in UTC. Grouped by UTC, the
 * backup taken early on 1 October would count as September's last, and the one
 * kept as "October's first" would already hold all of 1 October.
 */
export function planRetention(
  stamps: string[],
  keep: { daily: number; monthly: number; timezone: string },
): { keep: string[]; remove: string[] } {
  const newestFirst = [...new Set(stamps)].sort().reverse()
  const kept = new Set(newestFirst.slice(0, Math.max(1, keep.daily)))
  const monthIn = new Intl.DateTimeFormat('en-CA', { timeZone: keep.timezone, year: 'numeric', month: '2-digit' })

  const firstOfMonth = new Map<string, string>()
  for (const stamp of [...newestFirst].reverse()) {
    const month = monthIn.format(dateOfStamp(stamp))
    if (!firstOfMonth.has(month)) firstOfMonth.set(month, stamp)
  }
  const months = [...firstOfMonth.keys()].sort().reverse().slice(0, keep.monthly)
  for (const month of months) kept.add(firstOfMonth.get(month)!)

  return { keep: newestFirst.filter((s) => kept.has(s)), remove: newestFirst.filter((s) => !kept.has(s)) }
}

// ── Talking to Postgres's own tools ──────────────────────────────────────────

/**
 * A Prisma URL as pg_dump and psql will take it: the password moved out of the
 * command line (where `ps` would show it) into PGPASSWORD, and Prisma's own
 * parameters — schema, pgbouncer, connection_limit — dropped, because libpq
 * refuses what it does not know.
 */
const LIBPQ_PARAMS = new Set(['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'connect_timeout', 'application_name', 'target_session_attrs', 'channel_binding', 'options'])

export interface PgTarget {
  url: string
  password: string
  host: string
  port: string
  database: string
}

export function pgTarget(connection: string): PgTarget {
  const u = new URL(connection)
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') throw new Error('Not a postgresql:// URL')
  const password = decodeURIComponent(u.password)
  u.password = ''
  for (const key of [...u.searchParams.keys()]) if (!LIBPQ_PARAMS.has(key)) u.searchParams.delete(key)
  return {
    url: u.toString(),
    password,
    host: u.hostname,
    port: u.port || '5432',
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  }
}

/** The same database — whatever else differs in the two URLs. */
export function sameDatabase(a: PgTarget, b: PgTarget): boolean {
  const host = (h: string) => (h === '127.0.0.1' || h === '::1' ? 'localhost' : h.toLowerCase())
  return host(a.host) === host(b.host) && a.port === b.port && a.database === b.database
}

/** Another database on the same server — for the drill's scratch copy, and for connecting to create it. */
export function onSameServer(target: PgTarget, database: string): PgTarget {
  const u = new URL(target.url)
  u.pathname = `/${encodeURIComponent(database)}`
  return { ...target, url: u.toString(), database }
}

export function pgTool(name: 'pg_dump' | 'pg_restore' | 'psql', binDir: string | undefined): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  return binDir ? join(binDir, exe) : exe
}

/** Runs a tool with the password in its environment only. Rejects with its own words on failure. */
export function run(command: string, args: string[], password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, PGPASSWORD: password }, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
    child.on('error', (e) => reject(new Error(`${command} could not be started (${e.message}). Is PostgreSQL's client installed, or PG_BIN set?`)))
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} failed: ${err.trim() || `exit ${code}`}`))))
  })
}

/**
 * A psql kept open, so several statements share one transaction — the backup
 * counts its rows in the very snapshot pg_dump then dumps, so a sign-in at
 * 02:30 cannot make a perfect restore look short by one row.
 */
export class PsqlSession {
  private readonly child
  private output = ''
  private failure: Error | null = null
  private waiting: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null
  private static readonly END = '__EMS_STATEMENT_DONE__'

  constructor(command: string, target: PgTarget) {
    // -q: no "BEGIN"/"COMMIT" tags in the output, only rows.
    this.child = spawn(command, ['-X', '-q', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', target.url], {
      env: { ...process.env, PGPASSWORD: target.password },
      windowsHide: true,
    })
    let errors = ''
    this.child.stdout.on('data', (d: Buffer) => {
      this.output += d.toString('utf8')
      const at = this.output.indexOf(PsqlSession.END)
      if (at >= 0 && this.waiting) {
        const result = this.output.slice(0, at)
        this.output = this.output.slice(at + PsqlSession.END.length).replace(/^\r?\n/, '')
        const w = this.waiting
        this.waiting = null
        w.resolve(result)
      }
    })
    this.child.stderr.on('data', (d: Buffer) => { errors += d.toString('utf8') })
    const fail = (e: Error) => {
      this.failure = e
      if (this.waiting) {
        this.waiting.reject(e)
        this.waiting = null
      }
    }
    // Writing to a psql that never started raises on stdin; without a listener
    // that error would crash the job before it could report itself.
    this.child.stdin.on('error', (e) => fail(new Error(`psql could not be written to (${e.message})`)))
    this.child.on('error', (e) => fail(new Error(`${command} could not be started (${e.message}). Is PostgreSQL's client installed, or PG_BIN set?`)))
    this.child.on('close', (code) => fail(new Error(`psql ended: ${errors.trim() || `exit ${code}`}`)))
  }

  /** One statement; resolves with its rows as psql prints them unaligned. */
  query(sql: string): Promise<string> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject }
      this.child.stdin.write(`${sql.trim().replace(/;?$/, ';')}\n\\echo ${PsqlSession.END}\n`)
    })
  }

  async close(): Promise<void> {
    if (this.failure) return
    await new Promise<void>((resolve) => {
      this.child.once('close', () => resolve())
      this.child.stdin.end('\\q\n')
    })
  }
}

/**
 * Every table in the public schema with its exact row count, in one query —
 * what a restore is checked against. (query_to_xml runs a count per table
 * without a second round trip for each.)
 */
export const TABLE_COUNTS_SQL = `
SELECT table_name,
       (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name`

export const LATEST_MIGRATION_SQL = `
SELECT migration_name FROM _prisma_migrations
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY migration_name DESC LIMIT 1`

export function parseCounts(psqlOutput: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of psqlOutput.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [table, n] = line.split('|')
    if (table && n !== undefined) counts[table] = Number(n)
  }
  return counts
}

/** What differs between the counts a backup recorded and what a restore holds. Empty means identical. */
export function compareCounts(expected: Record<string, number>, actual: Record<string, number>): string[] {
  const problems: string[] = []
  for (const table of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    if (!(table in actual)) problems.push(`${table}: missing from the restore`)
    else if (!(table in expected)) problems.push(`${table}: in the restore but not in the backup`)
    else if (expected[table] !== actual[table]) problems.push(`${table}: ${expected[table]} rows backed up, ${actual[table]} restored`)
  }
  return problems
}

// ── Sealing a dump ───────────────────────────────────────────────────────────

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const MAGIC = Buffer.from('EMSB1')

/**
 * AES-256-GCM with a key stretched from a passphrase. A dump holds PANs and
 * bank accounts; sealed, a leaked bucket key leaks nothing readable. The
 * passphrase lives with the company, outside the server — without it the
 * backups cannot be opened, by anybody.
 */
export function seal(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body])
}

export function isSealed(bytes: Buffer): boolean {
  return bytes.subarray(0, MAGIC.length).equals(MAGIC)
}

export function unseal(sealed: Buffer, passphrase: string): Buffer {
  if (!isSealed(sealed)) throw new Error('This backup is not sealed')
  let at = MAGIC.length
  const salt = sealed.subarray(at, (at += 16))
  const iv = sealed.subarray(at, (at += 12))
  const tag = sealed.subarray(at, (at += 16))
  const key = scryptSync(passphrase, salt, 32)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(sealed.subarray(at)), decipher.final()])
  } catch {
    throw new Error('The backup could not be opened: the passphrase is wrong, or the file was altered')
  }
}

// ── The manifest stored beside each dump ─────────────────────────────────────

export interface Manifest {
  version: 1
  stamp: string
  createdAt: string
  source: { host: string; port: string; database: string }
  pgDump: string
  latestMigration: string | null
  sealed: boolean
  /** Of the dump as pg_dump wrote it, before sealing. */
  dumpSha256: string
  dumpBytes: number
  /** Of the object as stored, sealed or not — checked before anything is opened. */
  storedSha256: string
  storedBytes: number
  tables: Record<string, number>
}
