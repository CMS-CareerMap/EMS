import type { ScopedDb } from './scoped'

/**
 * Who opens a transaction:
 *
 *   A SERVICE, through withTransaction, when one unit of work spans several
 *   repository calls — onboarding an employee, deciding a leave request.
 *
 *   A REPOSITORY, on its own client, when the whole atomic write is its own
 *   business — replacing a state's PT table, recording a salary. The service
 *   then calls one function and cannot leave the write half done.
 *
 * Either way the queries are in repositories; a service never writes one.
 *
 * Prisma's defaults are timeout 5s / maxWait 2s, which a payroll run writing a
 * hundred payslips will blow straight through. These limits are raised
 * deliberately rather than discovered in production.
 */
const DEFAULTS = {
  /** How long the transaction may run before Postgres rolls it back. */
  timeout: 120_000,
  /** How long to wait for a free connection before giving up. */
  maxWait: 10_000,
} as const

/**
 * What a transaction hands its callback: the same scoped client, without the
 * means to open another transaction. A repository function that has to work
 * inside a transaction as well as outside one takes this — `ctx.db` fits it
 * too, so the caller decides which it gets.
 */
export type TxDb = Parameters<Parameters<ScopedDb['$transaction']>[0]>[0]

/**
 * The scoping extension is applied to the client, and Prisma derives the
 * transaction handle from that same client — so `tx` stays scoped. The test in
 * scoped.test.ts proves this rather than assuming it, because if it were ever
 * untrue every transactional write would silently lose its company filter.
 *
 * The service opens the transaction; the repository functions it calls inside
 * run their queries on `tx`. No query is written in the service itself (§A5
 * rule 2), so what runs inside the transaction is a list of named steps.
 */
export async function withTransaction<T>(
  db: ScopedDb,
  fn: (tx: TxDb) => Promise<T>,
  options: { timeout?: number; maxWait?: number } = {},
): Promise<T> {
  return db.$transaction(fn as never, { ...DEFAULTS, ...options }) as Promise<T>
}
