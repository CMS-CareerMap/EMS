import type { AccountStatus } from '@prisma/client'
import { unsafeDb } from '../../platform/db/unsafe'
import { toGrant, type RoleGrant } from '../../platform/authz/grant'
import { roleForGrant } from './session.repository'

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
  email: string
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
}

const membershipInclude = {
  organization: { select: { id: true, name: true, timezone: true, leaveNoManagerApproverId: true } },
  roleDef: { select: roleForGrant },
  employee: {
    select: {
      id: true,
      fullName: true,
      employeeCode: true,
      attendanceMode: true,
      _count: { select: { directReports: { where: { archivedAt: null } } } },
    },
  },
} as const

type IncludedMembership = {
  organization: { leaveNoManagerApproverId: string | null }
  employee: { id: string; fullName: string; employeeCode: string; attendanceMode: string; _count: { directReports: number } } | null
}

/** The employee as the session shows it, and whether they decide anybody's leave. */
function personOf(membership: IncludedMembership, grant: RoleGrant) {
  const e = membership.employee
  return {
    employee: e ? { id: e.id, fullName: e.fullName, employeeCode: e.employeeCode, attendanceMode: e.attendanceMode } : null,
    decidesLeave:
      grant.permissions.has('role:manage') ||
      Boolean(e && (e._count.directReports > 0 || membership.organization.leaveNoManagerApproverId === e.id)),
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

  const grant = toGrant(membership.roleDef)
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
 */
export async function findIdentityByEmployeeCode(code: string): Promise<AuthIdentity | null> {
  const matches = await unsafeDb.employee.findMany({
    where: { employeeCode: code.trim(), archivedAt: null },
    include: {
      membership: { include: { user: true, ...membershipInclude } },
    },
    take: 2,
  })

  // Two rows means two organizations share this employee code. Refuse rather
  // than guess — handing over the wrong company's account is the worst
  // possible outcome here.
  const [employee, second] = matches
  if (!employee || second) return null

  const membership = employee.membership
  // An employee record with no membership has no login yet — CSV imports on
  // Day 10 create exactly this.
  if (!membership) return null

  const grant = toGrant(membership.roleDef)
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

  const grant = toGrant(membership.roleDef)
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
  }
}
