import { describe, it, expect } from 'vitest'
import {
  compareCounts,
  dateOfStamp,
  dumpKey,
  manifestKey,
  onSameServer,
  parseCounts,
  pgTarget,
  planRetention,
  sameDatabase,
  seal,
  isSealed,
  stampInKey,
  stampOf,
  unseal,
} from './lib'

/**
 * Backup and restore, the parts that decide things: which backups survive,
 * what a restore is compared with, where the password goes, and that a sealed
 * dump opens only with its passphrase. The restore itself is proved end to end
 * by `npm run backup:drill`.
 */

describe('stamps and keys', () => {
  it('names a backup by its moment, sortable and safe in a key', () => {
    const stamp = stampOf(new Date('2026-09-30T02:30:05.123Z'))
    expect(stamp).toBe('2026-09-30T02-30-05Z')
    expect(dateOfStamp(stamp).toISOString()).toBe('2026-09-30T02:30:05.000Z')
    expect(dumpKey(stamp)).toBe('backups/db/2026/09/2026-09-30T02-30-05Z.dump')
    expect(manifestKey(stamp)).toBe('backups/db/2026/09/2026-09-30T02-30-05Z.json')
    expect(stampInKey(dumpKey(stamp))).toBe(stamp)
    expect(stampInKey('org/abc/payslip/x/y.pdf')).toBeNull()
  })

  it('keeps backups outside org/, where the orphan-file sweeper looks', () => {
    expect(dumpKey('2026-09-30T02-30-05Z').startsWith('org/')).toBe(false)
  })
})

describe('retention', () => {
  const daysOf = (from: string, n: number) =>
    Array.from({ length: n }, (_, i) => stampOf(new Date(Date.parse(`${from}T02:30:00Z`) + i * 86_400_000)))

  it('keeps the newest thirty days and the first backup of each of twelve months', () => {
    const stamps = daysOf('2025-01-01', 640) // Jan 2025 → Oct 2026
    const plan = planRetention(stamps, { daily: 30, monthly: 12, timezone: 'Asia/Kolkata' })
    const newest = [...stamps].sort().reverse()
    for (const s of newest.slice(0, 30)) expect(plan.keep).toContain(s)
    const firsts = plan.keep.filter((s) => s.slice(8, 10) === '01')
    expect(firsts.length).toBeGreaterThanOrEqual(12)
    // Nothing older than the twelve months kept, except nothing at all.
    const oldestKept = [...plan.keep].sort()[0]!
    expect(oldestKept >= '2025-10').toBe(true)
    expect(plan.keep.length + plan.remove.length).toBe(stamps.length)
    expect(plan.keep.length).toBeLessThanOrEqual(30 + 12)
  })

  it('keeps a month’s FIRST backup, not its last', () => {
    const plan = planRetention(['2026-08-01T02-30-00Z', '2026-08-15T02-30-00Z', '2026-08-31T02-30-00Z', '2026-09-30T02-30-00Z'], { daily: 1, monthly: 2, timezone: 'Asia/Kolkata' })
    expect(plan.keep.sort()).toEqual(['2026-08-01T02-30-00Z', '2026-09-30T02-30-00Z'])
  })

  it('counts a backup in the company’s month: 02:30 in India on 1 Oct is October’s first, though UTC still says 30 Sep', () => {
    const nightly = ['2026-09-28T21-00-00Z', '2026-09-29T21-00-00Z', '2026-09-30T21-00-00Z', '2026-10-01T21-00-00Z', '2026-10-02T21-00-00Z']
    const plan = planRetention(nightly, { daily: 1, monthly: 2, timezone: 'Asia/Kolkata' })
    // Newest, October's first (taken 1 Oct 02:30 IST) and September's first (29 Sep 02:30 IST).
    expect(plan.keep.sort()).toEqual(['2026-09-28T21-00-00Z', '2026-09-30T21-00-00Z', '2026-10-02T21-00-00Z'])
  })

  it('never removes the newest, whatever the settings', () => {
    expect(planRetention(['2026-09-30T02-30-00Z'], { daily: 0, monthly: 0, timezone: 'Asia/Kolkata' }).keep).toEqual(['2026-09-30T02-30-00Z'])
    expect(planRetention([], { daily: 30, monthly: 12, timezone: 'Asia/Kolkata' })).toEqual({ keep: [], remove: [] })
  })
})

describe('connections', () => {
  it('moves the password out of the command line and drops Prisma-only parameters', () => {
    const t = pgTarget('postgresql://ems:s3cr%40t@db.example.com:6543/ems_prod?schema=public&sslmode=require&pgbouncer=true&connection_limit=5')
    expect(t.password).toBe('s3cr@t')
    expect(t.url).toBe('postgresql://ems@db.example.com:6543/ems_prod?sslmode=require')
    expect(t.url).not.toContain('s3cr')
    expect(t).toMatchObject({ host: 'db.example.com', port: '6543', database: 'ems_prod' })
  })

  it('knows the same database when it sees it, however the URL is written', () => {
    const a = pgTarget('postgresql://a:x@localhost:5432/ems')
    expect(sameDatabase(a, pgTarget('postgresql://b:y@127.0.0.1/ems?sslmode=disable'))).toBe(true)
    expect(sameDatabase(a, pgTarget('postgresql://a:x@localhost:5432/ems_restore_drill'))).toBe(false)
    expect(sameDatabase(a, onSameServer(a, 'ems_restore_drill'))).toBe(false)
    expect(onSameServer(a, 'postgres').url).toBe('postgresql://a@localhost:5432/postgres')
  })

  it('refuses a URL that is not Postgres', () => {
    expect(() => pgTarget('mysql://x@y/z')).toThrow()
  })
})

describe('checking a restore', () => {
  it('reads psql’s unaligned rows', () => {
    expect(parseCounts('Employee|12\r\nPayslip|240\n\n')).toEqual({ Employee: 12, Payslip: 240 })
  })

  it('names every table that differs, and nothing when all match', () => {
    expect(compareCounts({ A: 1, B: 2 }, { A: 1, B: 2 })).toEqual([])
    expect(compareCounts({ A: 1, B: 2, C: 3 }, { A: 1, B: 1, D: 0 })).toEqual([
      'B: 2 rows backed up, 1 restored',
      'C: missing from the restore',
      'D: in the restore but not in the backup',
    ])
  })
})

describe('sealing', () => {
  const dump = Buffer.from('PGDMP… a pretend dump with a PAN ABCDE1234F in it')

  it('opens only with the right passphrase, and hides what is inside', () => {
    const sealed = seal(dump, 'correct horse battery staple')
    expect(isSealed(sealed)).toBe(true)
    expect(sealed.includes(Buffer.from('ABCDE1234F'))).toBe(false)
    expect(unseal(sealed, 'correct horse battery staple').equals(dump)).toBe(true)
    expect(() => unseal(sealed, 'wrong passphrase entirely')).toThrow(/passphrase is wrong/)
  })

  it('notices a single altered byte', () => {
    const sealed = seal(dump, 'correct horse battery staple')
    sealed.writeUInt8(sealed.readUInt8(sealed.length - 3) ^ 0xff, sealed.length - 3)
    expect(() => unseal(sealed, 'correct horse battery staple')).toThrow(/altered/)
  })

  it('seals the same dump differently every time', () => {
    expect(seal(dump, 'p'.repeat(16)).equals(seal(dump, 'p'.repeat(16)))).toBe(false)
  })
})
