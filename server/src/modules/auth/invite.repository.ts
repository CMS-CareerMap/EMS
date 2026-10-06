import type { PasswordTokenPurpose } from '@prisma/client'
import { unsafeDb } from '../../platform/db/unsafe'

/**
 * Invitation and reset links, redeemed.
 *
 * `unsafeDb`, deliberately and for the same reason login uses it: whoever holds
 * a link is not signed in, so there is no organization to scope by yet. What
 * stands in for the scope is the token itself — a 256-bit secret, stored only
 * as a hash, that names exactly one user.
 */

// Whose password it is (Settings → Passwords), how long it must be, and the
// Employee ID a login with no email is named by.
const tokenLogin = {
  take: 1,
  select: {
    role: true,
    roleDef: { select: { locked: true } },
    organization: { select: { employeePasswords: true, rolePasswords: true, passwordMinLength: true } },
    employee: { select: { employeeCode: true } },
  },
} as const

/** A link that can still be used: not spent, not expired. */
export async function findLiveToken(tokenHash: string, now: Date) {
  return unsafeDb.passwordResetToken.findFirst({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    select: {
      id: true,
      userId: true,
      purpose: true,
      expiresAt: true,
      user: { select: { email: true, memberships: tokenLogin } },
    },
  })
}

/**
 * The login of a link that can no longer be used — spent or expired — so the
 * page can say why, where the company now sets that password.
 */
export async function findTokenLogin(tokenHash: string) {
  const row = await unsafeDb.passwordResetToken.findFirst({
    where: { tokenHash },
    select: { user: { select: { memberships: tokenLogin } } },
  })
  return row?.user.memberships[0] ?? null
}

/** Memberships still waiting for their first password. */
export async function countInvitedMemberships(userId: string): Promise<number> {
  return unsafeDb.membership.count({ where: { userId, status: 'invited' } })
}

export interface RedeemInput {
  tokenId: string
  userId: string
  purpose: PasswordTokenPurpose
  passwordHash: string
  now: Date
}

/**
 * Spends the link and sets the password, in one transaction.
 *
 * Returns false when the link was spent or expired between the check and now —
 * two tabs submitting the same link at once. The update that claims it is
 * conditional, so exactly one of them wins and the other changes nothing.
 */
export async function redeem(input: RedeemInput): Promise<{ activated: number } | null> {
  return unsafeDb.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: input.tokenId, usedAt: null, expiresAt: { gt: input.now } },
      data: { usedAt: input.now },
    })
    if (claimed.count !== 1) return null

    await tx.user.update({
      where: { id: input.userId },
      data: {
        passwordHash: input.passwordHash,
        // Every access token issued before this moment stops working. For a
        // reset that is the point: whoever had the old password is out.
        tokenVersion: { increment: 1 },
      },
    })

    // Refresh tokens too, or a stolen session would simply refresh itself a
    // new access token carrying the new version.
    await tx.refreshToken.updateMany({
      where: { userId: input.userId, revokedAt: null },
      data: { revokedAt: input.now },
    })

    // Any OTHER outstanding link for this person dies with this one. HR may
    // have sent two after the first seemed lost; the second must not work as a
    // back door once the person has chosen a password.
    await tx.passwordResetToken.updateMany({
      where: { userId: input.userId, usedAt: null },
      data: { usedAt: input.now },
    })

    // Only an invitation activates anything, and only memberships still
    // waiting. One an administrator has since deactivated stays deactivated:
    // accepting an old invitation must not undo that decision.
    //
    // Every invited membership, because the link names a user, not a company.
    // With one company that is the same thing; when there are many (the SaaS
    // phase) the token will need to carry the membership it was issued for.
    const activated =
      input.purpose === 'invite'
        ? await tx.membership.updateMany({
            where: { userId: input.userId, status: 'invited' },
            data: { status: 'active' },
          })
        : { count: 0 }

    return { activated: activated.count }
  })
}
