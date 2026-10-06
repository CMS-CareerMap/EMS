import type { PasswordTokenPurpose } from '@prisma/client'
import { unsafeDb } from '../../platform/db/unsafe'
import { appendIn, type AuditRow } from '../audit/audit.repository'

/**
 * Account recovery from the server's own terminal.
 *
 * Runs before anybody can sign in, so on the unscoped client: it finds the
 * account by email in the global users table, the same way login does.
 */

export async function findAccount(email: string) {
  return unsafeDb.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      memberships: {
        select: {
          id: true,
          organizationId: true,
          role: true,
          status: true,
          // Whose password it is (Settings → Passwords): a link is for one that is the person's own.
          roleDef: { select: { locked: true } },
          organization: { select: { employeePasswords: true, rolePasswords: true } },
        },
      },
    },
  })
}

/**
 * Spends every link this person still holds, issues the new one, and records
 * that it was issued — in one transaction, so no link exists without its row.
 */
export async function issueLink(input: {
  userId: string
  tokenHash: string
  expiresAt: Date
  purpose: PasswordTokenPurpose
  audit: AuditRow
}): Promise<void> {
  await unsafeDb.$transaction(async (tx) => {
    await tx.passwordResetToken.updateMany({
      where: { userId: input.userId, usedAt: null },
      data: { usedAt: new Date() },
    })
    await tx.passwordResetToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        purpose: input.purpose,
        // Nobody signed in issued it — the terminal did. The audit row says so.
        createdByUserId: null,
      },
    })
    await appendIn(tx, input.audit)
  })
}
