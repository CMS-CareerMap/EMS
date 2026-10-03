import type { AuthIdentity } from '../../modules/auth/auth.repository'

/**
 * What a session looks like to the client.
 *
 * Built by naming every field, never by spreading the identity and deleting
 * what should not go out. AuthIdentity already carries `passwordHash`, and the
 * list will grow — a statutory id, a bank reference. An allow-list keeps every
 * one of those out by default; a deny-list leaks each new field once, and only
 * tells you afterwards.
 *
 * `permissions` is sent so the UI can hide what the user cannot do. It is a
 * convenience for the interface and NOTHING MORE — the server re-derives
 * permissions from the role on every single request and never reads this list
 * back. A client that edited it would change which buttons it draws for itself,
 * and nothing else.
 *
 * Sending the list rather than the role is the point. If the frontend had only
 * `role` it would write `role === 'hr'` in fifty components, and the day the
 * client moves one right between roles, fifty components are wrong.
 */
export function serializeSessionUser(identity: AuthIdentity) {
  return {
    id: identity.userId,
    email: identity.email,
    role: identity.role,
    // The role as people read it — a custom role has no other name the
    // interface could know (Day 21).
    roleName: identity.grant.name,
    permissions: [...identity.grant.permissions],
    // Decides somebody's leave in the company tree (Day 22): the menu shows
    // Leave and its Team tab on it, whatever the role's leave rights.
    decidesLeave: identity.decidesLeave,
    // Whose employee records the role reaches — the screen offers a roster
    // import, which adds people outside any team, only to a company-wide reach.
    employeeReach: identity.grant.scopes.employee,
    organizationId: identity.organizationId,
    organizationName: identity.organizationName,
    // The company's zone, so the browser can tell which calendar day it is
    // THERE. Taking the day from UTC shows yesterday until 05:30 in India.
    organizationTimezone: identity.organizationTimezone,
    employee: identity.employee
      ? {
          id: identity.employee.id,
          fullName: identity.employee.fullName,
          employeeCode: identity.employee.employeeCode,
          // Drives whether the app shows a Check In button at all. A biometric
          // employee punches at the machine; offering them a button they must
          // not use is worse than offering nothing.
          attendanceMode: identity.employee.attendanceMode,
        }
      : null,
  }
}

export type SessionUser = ReturnType<typeof serializeSessionUser>
