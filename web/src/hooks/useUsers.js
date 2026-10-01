import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

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
    mutationFn: async ({ email, full_name, role, employee_code }) => {
      const payload = await api.post('/users/invite', {
        email,
        role,
        ...(full_name ? { fullName: full_name } : {}),
        ...(employee_code ? { employeeCode: employee_code } : {}),
      })
      return payload.data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })
}

export function useUpdateUserRole() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ user_id, role }) => {
      const payload = await api.put(`/users/${user_id}/role`, { role })
      return payload.data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })
}
