import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * Requests (client §28–29): attendance corrections, working from home or on
 * duty, overtime and profile changes. What the caller may do with each comes
 * from the server (`may`), never worked out here.
 */

const KEY = ['requests']

/**
 * A request moves things elsewhere too: a correction writes attendance, a
 * profile change the employee record, an approved away day today's check-in,
 * and the dashboards count what waits.
 */
function invalidateAll(queryClient) {
  return Promise.all(
    // An approved encashment moves a leave balance; overtime and encashment, a payroll.
    [KEY, ['attendance'], ['employees'], ['dashboard'], ['notifications'], ['leave'], ['payroll']].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  )
}

export function useMyRequests({ enabled = true } = {}) {
  return useQuery({ queryKey: [...KEY, 'mine'], queryFn: async () => (await api.get('/requests/mine')).data, enabled })
}

/** Waiting for the caller to decide. */
export function useWaitingRequests({ enabled = true } = {}) {
  return useQuery({ queryKey: [...KEY, 'waiting'], queryFn: async () => (await api.get('/requests/waiting')).data, enabled })
}

/** HR's view, within its reach. */
export function useAllRequests(filters, { enabled = true } = {}) {
  const params = new URLSearchParams()
  if (filters.type) params.set('type', filters.type)
  if (filters.status) params.set('status', filters.status)
  return useQuery({
    queryKey: [...KEY, 'all', filters.type ?? '', filters.status ?? ''],
    queryFn: async () => (await api.get(`/requests/all${params.toString() ? `?${params}` : ''}`)).data,
    enabled,
  })
}

/** The caller's own details, for a profile change to start from. */
export function useMyDetails({ enabled = true } = {}) {
  return useQuery({ queryKey: [...KEY, 'my-details'], queryFn: async () => (await api.get('/requests/my-details')).data, enabled })
}

/**
 * Sends a request, then its file if one was chosen — the file only once the
 * request exists. A file that fails to go does not unsend the request: it
 * comes back with `fileProblem`, and the file can be added from the list.
 * A request recorded at once (the owner's) takes no file, and says so.
 */
export function useSubmitRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ body, file }) => {
      const created = (await api.post('/requests', body)).data
      if (!file) return created
      if (created.status !== 'pending') return { ...created, fileProblem: 'It was recorded at once, so the file was not added.' }
      const form = new FormData()
      form.append('file', file)
      try {
        return (await api.upload(`/requests/${created.id}/attachment`, form)).data
      } catch (err) {
        return { ...created, fileProblem: `The file was not added: ${err.message}. Add it from My requests.` }
      }
    },
    onSettled: () => invalidateAll(queryClient),
  })
}

/** A file for a request that waits, added afterwards. */
export function useAttachToRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, file }) => {
      const form = new FormData()
      form.append('file', file)
      return (await api.upload(`/requests/${id}/attachment`, form)).data
    },
    onSettled: () => invalidateAll(queryClient),
  })
}

/** `approve`, `reject` (with a note) or `withdraw`. */
export function useRequestAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, action, note }) => (await api.post(`/requests/${id}/${action}`, action === 'withdraw' ? {} : { note: note || null })).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}

/** Who decides each kind, and whether working from home still needs a location — the Super Admin's. */
export function useRequestRules({ enabled = true } = {}) {
  return useQuery({ queryKey: [...KEY, 'settings'], queryFn: async () => (await api.get('/requests/settings')).data, enabled })
}

export function useSaveRequestRules() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body) => (await api.put('/requests/settings', body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })
}
