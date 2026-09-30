import type { ScopedDb } from '../../platform/db/scoped'

/**
 * The company row itself.
 *
 * Organization is a GLOBAL model — it is the tenant, not a row inside one — so
 * the scoped client cannot fill its id in, and it is passed explicitly.
 */

export async function findTimezone(db: ScopedDb, organizationId: string): Promise<string | null> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  })
  return organization?.timezone ?? null
}

export async function findUploadLimit(db: ScopedDb, organizationId: string): Promise<number | null> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { maxUploadMb: true },
  })
  return organization?.maxUploadMb ?? null
}
