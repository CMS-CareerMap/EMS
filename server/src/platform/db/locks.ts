import type { TxDb } from './transaction'

/**
 * Makes one kind of write for one subject happen one at a time, until the
 * transaction ends.
 *
 * For a check-then-insert that no row lock can protect, because the row it
 * would lock does not exist yet. Two leave applications from one person, sent
 * together: both read the same pending days and the same free dates, both
 * passed, both went in. Taken first inside the transaction, this makes the
 * second wait until the first commits — then it reads what the first left.
 *
 * A Postgres advisory lock scoped to the transaction: released at commit or
 * rollback, never left behind. Raw SQL, so it lives here with the client.
 */
export async function lockFor(tx: TxDb, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`
}
