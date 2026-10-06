import type { PasswordTokenPurpose } from '@prisma/client'
import { Conflict, NotFound } from '../../platform/errors/AppError'
import { generateToken, hashInviteToken } from '../../platform/auth/tokenHash'
import { logger } from '../../platform/logger'
import * as repo from './recovery.repository'
import { loginKind, passwordSetBy, passwordSetterName } from '../../domain/org/passwords'
import { EMPLOYEE_ROLE } from '../../platform/authz/defaultRoles'

/**
 * The way back in when nobody can sign in to issue a link.
 *
 * The usual path is Settings → Users & Roles → a reset link. That needs
 * somebody signed in, and there is no email in v1 — so if the only Super Admin
 * forgets their password, the company is locked out of its own HR system. This
 * is the key under the mat, kept where only the owner can reach it: it runs
 * from a shell on the server, with the server's own database credentials.
 * Whoever can run it already controls the machine.
 *
 * It issues exactly what an administrator would: a single-use link, stored
 * only as its hash, which ends every session the person has when it is used.
 * Shorter-lived than one handed out in the app — an hour — because it is made
 * by someone at the keyboard who is about to use it.
 */

export const RECOVERY_LINK_MINUTES = 60

export interface RecoveryLink {
  email: string
  /** The role's key. */
  role: string
  purpose: PasswordTokenPurpose
  link: string
  expiresAt: Date
}

export async function issueRecoveryLink(
  rawEmail: string,
  options: { webOrigin: string; now?: Date },
): Promise<RecoveryLink> {
  const email = rawEmail.toLowerCase().trim()
  const now = options.now ?? new Date()

  const account = await repo.findAccount(email)
  if (!account) throw NotFound(`No account uses ${email}.`)

  // An invitation never accepted is sent again as an invitation; an account in
  // use gets a reset. A deactivated one gets neither: somebody decided it
  // should not sign in, and a key from the terminal must not quietly undo that.
  const invited = account.memberships.find((m) => m.status === 'invited')
  const active = account.memberships.find((m) => m.status === 'active')
  const membership = invited ?? active
  if (!membership) {
    throw Conflict(`${email} is deactivated. Reactivate the account first, then issue the link.`)
  }
  const purpose: PasswordTokenPurpose = invited ? 'invite' : 'reset'
  // A link is for choosing one's own password. Where the company sets this
  // login's (Settings → Passwords), the link would be refused when used — so
  // it is not made: the Super Admin sets it, and can always recover their own.
  const kind = loginKind(membership.role, EMPLOYEE_ROLE, membership.roleDef.locked)
  if (passwordSetBy(kind, membership.organization) === 'company') {
    throw Conflict(`${email}’s password is set by ${passwordSetterName(kind)} at this company, not from a link. Sign in as the Super Admin and set it from Settings → Users — or issue this for the Super Admin’s own login.`)
  }

  const token = generateToken()
  const expiresAt = new Date(now.getTime() + RECOVERY_LINK_MINUTES * 60 * 1000)

  await repo.issueLink({
    userId: account.id,
    tokenHash: hashInviteToken(token),
    expiresAt,
    purpose,
    audit: {
      organizationId: membership.organizationId,
      actorUserId: null,
      action: 'user.password_link_issued',
      entityType: 'membership',
      entityId: membership.id,
      details: { purpose, email, via: 'terminal' },
      requestId: null,
    },
  })

  logger.warn('Password link issued from the terminal', { userId: account.id, purpose })

  // The same address the app's own links use: the set-password page reads the
  // token from the fragment, which never reaches a server log.
  const link = `${new URL('/set-password', options.webOrigin).toString()}#token=${encodeURIComponent(token)}`
  return { email, role: membership.role, purpose, link, expiresAt }
}
