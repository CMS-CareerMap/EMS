import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'
import { useAuthStore } from '../stores/authStore'

/**
 * Users and access, now served by our own API.
 *
 * These four ran as edge functions on the old hosted backend until today. The hook NAMES and
 * ARGUMENT SHAPES are unchanged on purpose, so Settings → Users did not have to
 * be rewritten in the same commit that replaced the backend behind it. When
 * both halves change at once and a screen breaks, there is no way to tell which
 * half did it.
 *
 * ONE THING TO KNOW ABOUT IDS. The `user_id` these mutations take is the
 * MEMBERSHIP id, not the User id — it is `row.id` from the list below. That is
 * correct: access is granted per company, so what is being changed is this
 * person's membership of THIS company, not the person. The awkward name is kept
 * because the page already passes it; a rename is its own task.
 */

const KEY = ['users']

/**
 * A login added, turned on or off, given a role, or a person removed: the
 * person's page lists their logins (Day 23), the company tree who can sign
 * in, and the log what happened. Removing somebody archives them, so every
 * list with people in it follows too — and where they stand (client §43). Returned, so a dialog waiting on the
 * change closes with the lists already redrawn.
 */
function invalidateAccess(queryClient) {
  return Promise.all(
    [KEY, ['employees'], ['company-tree'], ['audit-log'], ['attendance'], ['leave'], ['dashboard'], ['payroll'], ['salary'], ['documents'], ['lifecycle']]
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  )
}

/**
 * The logins this person may see: `rows`, and `reach` — whose they are, the
 * caller's employee scope (Day 21). Somebody whose role reaches one department
 * gets that department's logins, and the screen says so.
 */
export function useUsers() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const payload = await api.get('/users')
      return { rows: payload.data, reach: payload.meta?.reach ?? 'ORGANIZATION' }
    },
  })
}

/**
 * Invites someone who has no login yet.
 *
 * Returns the invitation token. There is no email sending, so whoever invites
 * has to pass the link on themselves — which is why the token comes back rather
 * than disappearing into a "check your inbox" message that is not true.
 *
 * It can be read exactly once. Only its hash is stored, so a second look means
 * issuing a new invitation.
 */
export function useInviteUser() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ email, full_name, role, employee_code, password }) => {
      const payload = await api.post('/users/invite', {
        ...(email ? { email } : {}),
        role,
        ...(full_name ? { fullName: full_name } : {}),
        ...(employee_code ? { employeeCode: employee_code } : {}),
        // Typed for them, where the company sets this kind of login's password.
        ...(password ? { password } : {}),
      })
      return payload.data
    },
    // With an employee code it also adds somebody to the staff.
    onSuccess: () => invalidateAccess(queryClient),
  })
}

/**
 * A login for somebody already here (Day 23): their employee login — HR's to
 * give too (client, 6 Oct 2026) — or a role login beside it, the Super
 * Admin's. Returns `login_start` and, when it starts with a link, the same
 * `invite` shape as inviting, so the one panel shows it.
 */
export function useAddLogin() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ employee_id, email, role, password }) => {
      const payload = await api.post(`/employees/${employee_id}/logins`, {
        ...(email ? { email } : {}),
        role,
        ...(password ? { password } : {}),
      })
      return payload.data
    },
    onSuccess: () => invalidateAccess(queryClient),
  })
}

/**
 * Sets somebody's password for them (client, 6 Oct 2026): HR an employee
 * login's, the Super Admin anybody's. Every session signed in with the old one
 * ends; the person is told. The password is never sent back.
 */
export function useSetPassword() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ user_id, password }) => {
      const payload = await api.post(`/users/${user_id}/password`, { password })
      return payload.data
    },
    onSuccess: () => invalidateAccess(queryClient),
  })
}

const RULES_KEY = ['users', 'password-rules']

/** Settings → Users & Roles → Passwords: who sets each kind of login's password, and how long one must be. */
export function usePasswordRules({ enabled = true } = {}) {
  return useQuery({
    queryKey: RULES_KEY,
    queryFn: async () => (await api.get('/users/password-rules')).data,
    enabled,
  })
}

export function useSavePasswordRules() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ employee_passwords, role_passwords, password_min_length }) =>
      (await api.put('/users/password-rules', {
        employeePasswords: employee_passwords,
        rolePasswords: role_passwords,
        passwordMinLength: password_min_length,
      })).data,
    onSuccess: (saved) => {
      useAuthStore.getState().setPasswordRules({
        employeePasswords: saved.employee_passwords,
        rolePasswords: saved.role_passwords,
        passwordMinLength: saved.password_min_length,
      })
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: RULES_KEY }),
        queryClient.invalidateQueries({ queryKey: ['audit-log'] }),
      ])
    },
  })
}

export function useUpdateUserRole() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ user_id, role }) => {
      const payload = await api.put(`/users/${user_id}/role`, { role })
      return payload.data
    },
    onSuccess: () => invalidateAccess(queryClient),
  })
}

export function useToggleUserStatus() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ user_id, currentStatus }) => {
      // `invited` counts as not-yet-active, so the toggle activates it. The
      // server still refuses to let anyone set `invited` directly — that is a
      // state the system assigns, not one an administrator picks.
      const status = currentStatus === 'active' ? 'inactive' : 'active'
      const payload = await api.patch(`/users/${user_id}/status`, { status })
      return payload.data
    },
    onSuccess: () => invalidateAccess(queryClient),
  })
}

/**
 * Takes back an invitation nobody used — a login added with a mistyped
 * address. It is deleted, so the right one can be added in its place; a login
 * somebody has signed in with is turned off instead.
 */
export function useWithdrawInvitation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ user_id }) => {
      await api.post(`/users/${user_id}/withdraw`, {})
    },
    onSuccess: () => invalidateAccess(queryClient),
  })
}

/**
 * A fresh link for somebody — their invitation again if they never set a
 * password, or a password reset if they did. Any earlier link stops working.
 *
 * Returns the same `invite` shape as inviting does, so one panel shows both.
 */
export function useIssuePasswordLink() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ user_id }) => {
      const payload = await api.post(`/users/${user_id}/password-link`, {})
      return payload.data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })
}

/**
 * Ends someone's access.
 *
 * Named delete because the button says Delete, but nothing is deleted. The
 * server archives the employee and keeps every record attached to them —
 * payslips and statutory filings reference this person and have to stay
 * readable for years.
 */
export function useDeleteUser() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ user_id }) => {
      await api.del(`/users/${user_id}`)
    },
    onSuccess: () => invalidateAccess(queryClient),
  })
}
