import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * Roles — the company's own list since Day 21 (Settings → Roles & Permissions).
 *
 * The server decides everything: which permissions exist and what they are
 * called, whether a role may be saved, and which roles a person may hand out.
 * This only asks, and shows the answers.
 */

const ROLES = ['roles']
const ASSIGNABLE = ['roles', 'assignable']

/** Every role, with the words the editor explains them in. Super Admin only. */
export function useRoles({ enabled = true } = {}) {
  return useQuery({
    queryKey: ROLES,
    queryFn: async () => (await api.get('/roles')).data,
    enabled,
    // Read fresh whenever the screen opens: how many people hold a role
    // changes on the Users tab, and a Delete dialog must not go by an old count.
    staleTime: 0,
  })
}

/**
 * The roles the signed-in person may give somebody — below their own, with
 * nothing they cannot do themselves. What every role picker offers.
 */
export function useAssignableRoles({ enabled = true } = {}) {
  return useQuery({
    queryKey: ASSIGNABLE,
    queryFn: async () => (await api.get('/roles/assignable')).data,
    enabled,
  })
}

/**
 * The roles a new login may be given — on the invite form and the Add employee
 * form: what this person may hand out, less the Super Admin's. Handing over the
 * top role is a deliberate act done through a role change, with its own
 * safeguards, not a field on a form. The server refuses it there too.
 */
export function useInvitableRoles({ enabled = true } = {}) {
  const query = useAssignableRoles({ enabled })
  const roles = (query.data ?? []).filter((r) => !r.locked)
  return { query, roles }
}

/**
 * After any change: the roles, what may be handed out, the Users list (it shows
 * role names) and the audit log. Returned, so a dialog closes only once the
 * list already shows the change.
 */
function invalidateAll(queryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ROLES }),
    queryClient.invalidateQueries({ queryKey: ['users'] }),
    // An employee's record shows their role's name too.
    queryClient.invalidateQueries({ queryKey: ['employees'] }),
    queryClient.invalidateQueries({ queryKey: ['audit-log'] }),
  ])
}

/**
 * A refused change re-reads the roles as well. Refused because somebody else
 * changed the role first, the screen must show their change and hand the next
 * try the version it now has — otherwise every retry is refused the same way.
 */
const reread = (queryClient) => () => queryClient.invalidateQueries({ queryKey: ROLES })

const bodyOf = (role) => ({
  name: role.name,
  description: role.description ?? '',
  parentKey: role.parent_key,
  permissions: role.permissions,
  scopes: role.scopes,
})

export function useCreateRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (role) => (await api.post('/roles', bodyOf(role))).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}

export function useUpdateRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (role) => (await api.put(`/roles/${role.key}`, { ...bodyOf(role), version: role.version })).data,
    onSuccess: () => invalidateAll(queryClient),
    onError: reread(queryClient),
  })
}

export function useResetRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ key, version }) => (await api.post(`/roles/${key}/reset`, { version })).data,
    onSuccess: () => invalidateAll(queryClient),
    onError: reread(queryClient),
  })
}

export function useDeleteRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ key }) => {
      await api.del(`/roles/${key}`)
    },
    onSuccess: () => invalidateAll(queryClient),
    onError: reread(queryClient),
  })
}
