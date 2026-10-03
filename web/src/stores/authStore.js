import { create } from 'zustand'

/**
 * Who is signed in, and what they are allowed to do.
 *
 * The shape is deliberately backwards-compatible. Fourteen components read
 * `user`, `profile` and `role` from this store; changing those names would mean
 * editing all fourteen in the same commit that replaces the authentication
 * system, and then not knowing which half broke. So the new session response is
 * mapped INTO the old shape here, in one place, and the pages are left alone
 * until their own module day.
 *
 * What is new is `can()`. Nothing should ever compare a role again.
 */

/**
 * Maps the server's session payload onto the shape the pages already read.
 *
 * `profile` is PARTIAL until Day 7. The session endpoint returns identity, not
 * the HR record, so department, designation and joining date are genuinely not
 * known here — and are therefore absent rather than invented. A page reading
 * `profile.department` gets undefined, which is the truth. Filling it with a
 * placeholder would be the exact habit the audit found everywhere.
 */
function toProfile(session) {
  if (!session?.employee) return null
  return {
    id: session.employee.id,
    full_name: session.employee.fullName,
    employee_id: session.employee.employeeCode,
    attendance_mode: session.employee.attendanceMode,
    email: session.email,
    role: session.role,
  }
}

export const useAuthStore = create((set, get) => ({
  user: null,
  profile: null,
  role: null,
  /** The role as people read it. Since Day 21 a role can be one the Super Admin made, with no other name. */
  roleName: null,
  permissions: [],
  /**
   * Decides somebody's leave in the company tree (Day 22) — has people under
   * them, or is the Super Admin. Leave and its Team requests tab show on it,
   * whatever the role's leave rights; the server decides each request itself.
   */
  decidesLeave: false,
  /**
   * Whose employee records the role reaches ("ORGANIZATION", "DEPARTMENT", …).
   * A roster import adds people outside any team, so it is offered only to a
   * company-wide reach — the server refuses anybody else.
   */
  employeeReach: null,
  organization: null,
  /** True until the session is either confirmed or ruled out. */
  loading: true,
  profileDrawerOpen: false,

  /** The one way in. Called after login, refresh, or a session read. */
  setSession: (session) =>
    set({
      user: session ? { id: session.id, email: session.email } : null,
      profile: toProfile(session),
      role: session?.role ?? null,
      roleName: session?.roleName ?? null,
      permissions: session?.permissions ?? [],
      decidesLeave: session?.decidesLeave ?? false,
      employeeReach: session?.employeeReach ?? null,
      organization: session
        ? { id: session.organizationId, name: session.organizationName, timezone: session.organizationTimezone }
        : null,
      loading: false,
    }),

  clearAuth: () =>
    set({
      user: null,
      profile: null,
      role: null,
      roleName: null,
      permissions: [],
      decidesLeave: false,
      employeeReach: null,
      organization: null,
      loading: false,
      profileDrawerOpen: false,
    }),

  setLoading: (loading) => set({ loading }),
  setProfileDrawerOpen: (profileDrawerOpen) => set({ profileDrawerOpen }),

  /**
   * Ask this, never `role === 'hr'`.
   *
   * The list comes from the server, and the server re-derives it on every
   * request — so this decides which buttons are DRAWN, never what is allowed.
   * Someone editing it in a console gets a button that returns 403.
   */
  can: (permission) => get().permissions.includes(permission),

  /**
   * Holds at least one of these — for a page with parts belonging to different
   * permissions. Settings is one: HR manages leave types and holidays there
   * without holding the company settings on the other tabs. An array or a
   * single permission, so every nav item can be asked the same way.
   */
  canAny: (permissions) =>
    (Array.isArray(permissions) ? permissions : [permissions]).some((p) =>
      p === DECIDES_LEAVE ? get().decidesLeave : get().permissions.includes(p),
    ),
}))

/**
 * Not a permission: "decides somebody's leave in the company tree" (Day 22).
 * A menu entry or a route may name it beside permissions — Leave does, so an
 * Accounts head with a team reaches their Team requests.
 */
export const DECIDES_LEAVE = '@decidesLeave'
