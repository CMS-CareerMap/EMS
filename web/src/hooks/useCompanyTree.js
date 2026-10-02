import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * Settings → Company tree and Settings → Approvals (Day 22), the Super
 * Admin's: who reports to whom, the owner, the people with nobody above, and
 * who decides when the tree has no answer.
 *
 * Moving somebody is the employee edit (PATCH /employees/:id) — one path, with
 * its loop check, from the chart or from the person's own page.
 */

const KEY = ['company-tree']

function invalidateAll(queryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: KEY }),
    queryClient.invalidateQueries({ queryKey: ['employees'] }),
    // Whose leave goes to whom moves with the tree.
    queryClient.invalidateQueries({ queryKey: ['leave'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['audit-log'] }),
    // Whom one's own work goes to is the tree too: the "goes to" on bank
    // accounts, incentives, salaries, documents and attendance.
    queryClient.invalidateQueries({ queryKey: ['payroll'] }),
    queryClient.invalidateQueries({ queryKey: ['salary'] }),
    queryClient.invalidateQueries({ queryKey: ['documents'] }),
    queryClient.invalidateQueries({ queryKey: ['attendance'] }),
  ])
}

export function useCompanyTree() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await api.get('/company-tree')).data,
    // A tree somebody else changed a minute ago is the wrong tree to move people in.
    staleTime: 0,
  })
}

/** Who `employeeId` reports to — null for nobody above. */
export function useMoveInTree() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeId, managerId }) => (await api.patch(`/employees/${employeeId}`, { reportingManagerId: managerId })).data,
    // A loop, or somebody who left, is said beside the control that asked — not twice.
    meta: { quietCodes: ['BAD_REQUEST', 'FORBIDDEN'] },
    onSuccess: () => invalidateAll(queryClient),
    // Refused (a loop, somebody who left): the chart shows the tree as it is.
    onError: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })
}

export function useMarkOwner() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeId, version }) => api.put('/company-tree/owner', { employeeId, version }),
    onSuccess: () => invalidateAll(queryClient),
    onError: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })
}

export function useApprovalSettings() {
  return useQuery({
    queryKey: [...KEY, 'approvals'],
    queryFn: async () => (await api.get('/company-tree/approvals')).data,
    staleTime: 0,
  })
}

export function useSaveApprovalSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (settings) => (await api.put('/company-tree/approvals', settings)).data,
    onSuccess: () => invalidateAll(queryClient),
    onError: () => queryClient.invalidateQueries({ queryKey: [...KEY, 'approvals'] }),
  })
}
