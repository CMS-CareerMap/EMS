import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * The employee lifecycle (client §43): joining soon → onboarding → probation →
 * confirmed → transfers and promotions → resigned → serving notice → exit.
 *
 * HR's steps answer with the person's lifecycle as it now stands; what the
 * caller may do next comes from the server (`may`), never worked out here.
 */

const KEY = ['lifecycle']

/**
 * A step moves the person on everywhere: the employee list (their stage), the
 * company tree (a transfer), attendance and leave (their working days),
 * payroll, salaries, documents and reports (whose work goes where; their last
 * month), and the dashboards' cards. `skip` is a lifecycle the step itself
 * answered with — asked again, it could only say the same, or "not found".
 */
function invalidateAll(queryClient, skip = null) {
  const skipped = skip ? JSON.stringify(skip) : null
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: KEY, predicate: (query) => JSON.stringify(query.queryKey) !== skipped }),
    ...[['employees'], ['dashboard'], ['attendance'], ['leave'], ['company-tree'], ['users'], ['payroll'], ['salary'], ['documents'], ['reports'], ['notifications']]
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  ])
}

/** Somebody's lifecycle and history — for whoever may read their record. */
export function useLifecycleOf(employeeId, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...KEY, 'employee', employeeId],
    queryFn: async () => (await api.get(`/lifecycle/employees/${employeeId}`)).data,
    enabled: Boolean(employeeId) && enabled,
  })
}

/** The caller's own — "My employment" on the profile. */
export function useMyLifecycle({ enabled = true } = {}) {
  return useQuery({
    queryKey: [...KEY, 'me'],
    queryFn: async () => (await api.get('/lifecycle/me')).data,
    enabled,
  })
}

/** Who needs HR's attention, for the dashboard card. */
export function useLifecycleSummary({ enabled = true } = {}) {
  return useQuery({
    queryKey: [...KEY, 'summary'],
    queryFn: async () => (await api.get('/lifecycle/summary')).data,
    enabled,
  })
}

/** Resignations waiting for the caller to accept, as the person they report to. */
export function useWaitingResignations({ enabled = true } = {}) {
  return useQuery({
    queryKey: [...KEY, 'waiting'],
    queryFn: async () => (await api.get('/lifecycle/resignations/waiting')).data,
    enabled,
  })
}

export function useLifecycleSettings({ enabled = true } = {}) {
  return useQuery({
    queryKey: [...KEY, 'settings'],
    queryFn: async () => (await api.get('/lifecycle/settings')).data,
    enabled,
  })
}

export function useSaveLifecycleSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body) => (await api.put('/lifecycle/settings', body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })
}

/**
 * One of HR's steps on somebody: `onboarding`, `probation`, `confirm`,
 * `transfer`, `promote`, `resignation` (recorded for them) or `exit`.
 */
export function useLifecycleStep() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeId, step, body }) => (await api.post(`/lifecycle/employees/${employeeId}/${step}`, body ?? {}))?.data ?? null,
    // The person as they now stand — or nothing, when the step took them out
    // of the caller's sight (an exit, a transfer away): their profile page goes
    // back to the list, which says so, instead of showing "not found".
    onSuccess: (view, { employeeId }) => {
      const key = [...KEY, 'employee', employeeId]
      if (view) queryClient.setQueryData(key, view)
      // Out of sight: kept as it is while the page leaves, but never trusted again.
      else queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' })
      return invalidateAll(queryClient, key)
    },
  })
}

/** The caller's own resignation. */
export function useResign() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body) => (await api.post('/lifecycle/resignations', body)).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}

/** `withdraw` (the person's own, before acceptance), `accept` or `cancel`. */
export function useResignationAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, action, body }) => api.post(`/lifecycle/resignations/${id}/${action}`, body ?? {}),
    onSuccess: () => invalidateAll(queryClient),
  })
}
