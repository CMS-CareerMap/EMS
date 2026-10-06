import type { AccountStatus } from '@prisma/client'
import { unsafeDb } from '../../platform/db/unsafe'
import { equalsInsensitive, sameInsensitive } from '../../platform/db/insensitive'
import { ownThingsOnly, toGrant, type RoleGrant, type RoleRowForGrant } from '../../platform/authz/grant'
import { roleForGrant } from './session.repository'
import { holdsSuperAdmin, isSelfServiceLogin } from '../../domain/org/logins'
import { loginKind, passwordSetBy, type LoginKind, type PasswordRules, type PasswordSetter } from '../../domain/org/passwords'
import { EMPLOYEE_ROLE } from '../../platform/authz/defaultRoles'

/**
 * Login is the one read that runs before an organization is known, so it is one
 * of the two places allowed to use the unscoped client. See platform/db/unsafe.
 *
 * Everything it returns is flattened into a single shape, so the service never
 * has to reach through nested relations and never accidentally serialises a
 * whole User row (which carries the password hash) into a response.
 */
export interface AuthIdentity {
  userId: string
  /** Null for an employee login with no email: it signs in with the Employee ID. */
  email: string | null
  passwordHash: string | null
  tokenVersion: number

  membershipId: string
  organizationId: string
  organizationName: string
  /** IANA zone, e.g. Asia/Kolkata. Decides which calendar day "today" is. */
  organizationTimezone: string
  /** The role's key; what it allows is `grant`, read from the role's row. */
  role: string
  grant: RoleGrant
  status: AccountStatus

  employee: { id: string; fullName: string; employeeCode: string; attendanceMode: string } | null
  /**
   * Decides somebody's leave in the company tree (Day 22): has people
   * reporting to them, holds the Super Admin panel, or is the person Settings
   * → Approvals names for those with nobody above. The screen shows Leave and
   * its Team tab on it, whatever the role's leave rights; the server decides
   * each request again on its own.
   */
  decidesLeave: boolean
  /**
   * Whose this login's password is (Settings → Passwords): `company` — set
   * for them, by HR or the Super Admin, and they cannot change it — or `self`.
   */
  loginKind: LoginKind
  passwordSetBy: PasswordSetter
  /** The fewest characters a password may have, at this company. */
  passwordMinLength: number
  /** The company's choices, for the screens that make logins and set passwords. */
  passwordRules: PasswordRules
}

const membershipInclude = {
  organization: {
    select: { id: true, name: true, timezone: true, leaveNoManagerApproverId: true, employeePasswords: true, rolePasswords: true, passwordMinLength: true },
  },
  roleDef: { select: { ...roleForGrant, locked: true } },
  employee: {
    select: {
      id: true,
      fullName: true,
      employeeCode: true,
      attendanceMode: true,
      _count: { select: { directReports: { where: { archivedAt: null } } } },
      // Their logins: the employee login of somebody with a live role login decides nothing (Day 23),
      // and a Super Admin's passwords are all their own (Settings → Passwords).
      memberships: { select: { id: true, role: true, status: true, roleDef: { select: { locked: true } } } },
    },
  },
} as const

type LoginRow = { id: string; role: string; status: AccountStatus }
type PersonLogin = LoginRow & { roleDef: { locked: boolean } }
type IncludedMembership = LoginRow & {
  organization: { leaveNoManagerApproverId: string | null; employeePasswords: PasswordSetter; rolePasswords: PasswordSetter; passwordMinLength: number }
  roleDef: RoleRowForGrant & { locked: boolean }
  employee: { id: string; fullName: string; employeeCode: string; attendanceMode: string; _count: { directReports: number }; memberships: PersonLogin[] } | null
}

/** Whose this login's password is, and how long one must be. */
function passwordOf(membership: IncludedMembership) {
  const kind = loginKind(membership.role, EMPLOYEE_ROLE, membership.roleDef.locked)
  const { employeePasswords, rolePasswords, passwordMinLength } = membership.organization
  const person = { holdsSuperAdmin: holdsSuperAdmin(membership.employee?.memberships ?? []) }
  return {
    loginKind: kind,
    passwordSetBy: passwordSetBy(kind, membership.organization, person),
    passwordMinLength,
    passwordRules: { employeePasswords, rolePasswords, passwordMinLength },
  }
}

/**
 * The login's role as it applies — its own rows only for the employee login of
 * somebody with a live role login (Day 23), whatever the Employee role reaches.
 * The same as authenticate reads it on every request (session.repository).
 */
function grantOf(membership: IncludedMembership): RoleGrant {
  const grant = toGrant(membership.roleDef)
  const e = membership.employee
  return e && isSelfServiceLogin(membership, e.memberships, EMPLOYEE_ROLE) ? ownThingsOnly(grant) : grant
}

/** The employee as the session shows it, and whether they decide anybody's leave. */
function personOf(membership: IncludedMembership, grant: RoleGrant) {
  const e = membership.employee
  const selfServiceOnly = Boolean(e && isSelfServiceLogin(membership, e.memberships, EMPLOYEE_ROLE))
  return {
    employee: e ? { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, attendanceMode: e.attendanceMode } : null,
    decidesLeave:
      grant.permissions.has('role:manage') ||
      Boolean(e && !selfServiceOnly && (e._count.directReports > 0 || membership.organization.leaveNoManagerApproverId === e.id)),
  }
}

export async function findIdentityByEmail(email: string): Promise<AuthIdentity | null> {
  const user = await unsafeDb.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { memberships: { include: membershipInclude } },
  })

  // A User with no membership exists but belongs to no company, so there is
  // nothing to log into. Treated exactly like "no such user".
  const membership = user?.memberships[0]
  if (!user || !membership) return null

  const grant = grantOf(membership)
  return {
    userId: user.id,
    email: user.email,
    passwordHash: user.passwordHash,
    tokenVersion: user.tokenVersion,
    membershipId: membership.id,
    organizationId: membership.organizationId,
    organizationName: membership.organization.name,
    organizationTimezone: membership.organization.timezone,
    role: membership.role,
    grant,
    status: membership.status,
    ...personOf(membership, grant),
    ...passwordOf(membership),
  }
}

/**
 * Employee codes are unique PER ORGANISATION, not globally — the constraint is
 * @@unique([organizationId, employeeCode]). With one company that is the same
 * thing, so this works today.
 *
 * It will not survive the SaaS phase: two companies can both have an EMP001.
 * `take: 2` is here to make that failure loud rather than silent — if a second
 * row ever appears, this returns null and the user is told to log in with their
 * email, instead of being handed somebody else's account. The real fix then is
 * an organization hint (subdomain or a picker), which is noted in the guide.
 *
 * An employee code names a PERSON, and since Day 23 a person can have two
 * logins. The code signs in to their one login that can sign in; a role
 * login still only invited, or switched off, does not take it away. For
 * somebody with two that can, it signs in to their employee login (client,
 * 6 Oct 2026): that one may have no email at all — the ID is its only way in
 * — while a role login always has its own email. With none that can, the one
 * login there is (or the one still invited, the employee login first) is read,
 * so its status gives the usual message.
 *
 * Matched whatever the letters' case (client, 6 Oct 2026): "cms007" on a phone
 * keyboard is CMS007. Codes that differ only in case are refused when an
 * employee is added or changed, so the match names one person — and if two
 * were ever there, `take: 2` signs in to neither. Matched as the text it is:
 * `_` and `%` are not wildcards (`equalsInsensitive`).
 */
export async function findIdentityByEmployeeCode(code: string): Promise<AuthIdentity | null> {
  const wanted = code.trim()
  const matches = (await unsafeDb.employee.findMany({
    where: { employeeCode: equalsInsensitive(wanted), archivedAt: null },
    include: {
      memberships: { include: { user: true, ...membershipInclude } },
    },
    take: 2,
  })).filter((e) => sameInsensitive(e.employeeCode, wanted))

  // Two rows means two organizations share this employee code. Refuse rather
  // than guess — handing over the wrong company's account is the worst
  // possible outcome here.
  const [employee, second] = matches
  if (!employee || second) return null

  // An employee record with no membership has no login yet — CSV imports on
  // Day 10 create exactly this.
  const logins = employee.memberships
  const active = logins.filter((m) => m.status === 'active')
  const invited = logins.filter((m) => m.status === 'invited')
  // One of several: the employee login, if there is exactly one among them.
  const oneOf = <T extends { role: string }>(rows: T[]) => {
    if (rows.length === 1) return rows[0]
    const own = rows.filter((m) => m.role === EMPLOYEE_ROLE)
    return own.length === 1 ? own[0] : undefined
  }
  const membership =
    active.length > 0 ? oneOf(active)
      : logins.length === 1 ? logins[0]
        : invited.length > 0 ? oneOf(invited)
          : undefined
  if (!membership) return null

  const grant = grantOf(membership)
  return {
    userId: membership.user.id,
    email: membership.user.email,
    passwordHash: membership.user.passwordHash,
    tokenVersion: membership.user.tokenVersion,
    membershipId: membership.id,
    organizationId: membership.organizationId,
    organizationName: membership.organization.name,
    organizationTimezone: membership.organization.timezone,
    role: membership.role,
    grant,
    status: membership.status,
    ...personOf(membership, grant),
    ...passwordOf(membership),
  }
}

/**
 * Re-reads an identity by user id. Used on refresh.
 *
 * The point of a fifteen-minute access token is that it is rebuilt from current
 * state, not extended. If someone's role was lowered or their account
 * deactivated two minutes ago, that has to be reflected the next time they
 * refresh — so refresh reads this rather than copying claims from the old token.
 */
export async function findIdentityByUserId(userId: string): Promise<AuthIdentity | null> {
  const user = await unsafeDb.user.findUnique({
    where: { id: userId },
    include: { memberships: { include: membershipInclude } },
  })

  const membership = user?.memberships[0]
  if (!user || !membership) return null

  const grant = grantOf(membership)
  return {
    userId: user.id,
    email: user.email,
    passwordHash: user.passwordHash,
    tokenVersion: user.tokenVersion,
    membershipId: membership.id,
    organizationId: membership.organizationId,
    organizationName: membership.organization.name,
    organizationTimezone: membership.organization.timezone,
    role: membership.role,
    grant,
    status: membership.status,
    ...personOf(membership, grant),
    ...passwordOf(membership),
  }
}
