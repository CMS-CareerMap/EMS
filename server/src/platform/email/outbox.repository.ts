import { unsafeDb } from '../db/unsafe'
import { forOrg } from '../db/scoped'

/**
 * The email queue. The sender acts for no user, so it finds the companies
 * first — the one unscoped read, resolving organizations — and then reads and
 * writes each company's queue through that company's own scoped client.
 */

export async function companiesWithMail(): Promise<string[]> {
  const rows = await unsafeDb.organization.findMany({ where: { emailOutbox: { some: { status: 'pending' } } }, select: { id: true } })
  return rows.map((r) => r.id)
}

export async function allCompanies(): Promise<string[]> {
  return (await unsafeDb.organization.findMany({ select: { id: true } })).map((r) => r.id)
}

/** The oldest waiting for a company, a batch at a time. */
export async function waiting(organizationId: string, limit: number) {
  return forOrg(organizationId).emailOutbox.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, toEmail: true, subject: true, body: true, attempts: true },
  })
}

export async function markSent(organizationId: string, id: string): Promise<void> {
  await forOrg(organizationId).emailOutbox.updateMany({ where: { id }, data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, lastError: null } })
}

export async function markFailedAttempt(organizationId: string, id: string, error: string, giveUp: boolean): Promise<void> {
  await forOrg(organizationId).emailOutbox.updateMany({
    where: { id },
    data: { attempts: { increment: 1 }, lastError: error.slice(0, 500), ...(giveUp ? { status: 'failed' } : {}) },
  })
}

/** Sent or abandoned mail past keeping — the notice itself stays in the app. */
export async function purgeDone(organizationId: string, before: Date): Promise<number> {
  return (await forOrg(organizationId).emailOutbox.deleteMany({ where: { status: { in: ['sent', 'failed'] }, createdAt: { lt: before } } })).count
}
