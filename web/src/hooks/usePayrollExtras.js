import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * Salary components and loans (client §40). A change to either moves what a
 * payroll would pay, so the readiness check and the calculations are reread.
 */

function refresh(qc, key) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: key }),
    qc.invalidateQueries({ queryKey: ['payroll'] }),
    qc.invalidateQueries({ queryKey: ['dashboard', 'payroll'] }),
    qc.invalidateQueries({ queryKey: ['salary'] }),
    qc.invalidateQueries({ queryKey: ['settings', 'pf-components'] }),
  ])
}

const COMPONENTS = ['payroll-components']

/** Every component, archived ones too — for the accountant's list. */
export function useAllComponents({ enabled = true } = {}) {
  return useQuery({ queryKey: COMPONENTS, queryFn: async () => (await api.get('/payroll/components/all')).data, enabled })
}

export function useAddComponent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body) => (await api.post('/payroll/components', body)),
    onSuccess: () => refresh(qc, COMPONENTS),
  })
}

export function useChangeComponent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...body }) => (await api.patch(`/payroll/components/${id}`, body)).data,
    onSuccess: () => refresh(qc, COMPONENTS),
  })
}

export function useArchiveComponent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id }) => (await api.del(`/payroll/components/${id}`)).data,
    onSuccess: () => refresh(qc, COMPONENTS),
  })
}

const LOANS = ['payroll-loans']

export function useLoans({ enabled = true } = {}) {
  return useQuery({ queryKey: LOANS, queryFn: async () => (await api.get('/payroll/loans')).data, enabled })
}

export function useRecordLoan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body) => (await api.post('/payroll/loans', body)).data,
    onSuccess: () => refresh(qc, LOANS),
  })
}

export function useCloseLoan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, note }) => (await api.post(`/payroll/loans/${id}/close`, { note })).data,
    onSuccess: () => refresh(qc, LOANS),
  })
}

export function useDeleteLoan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id }) => api.del(`/payroll/loans/${id}`),
    onSuccess: () => refresh(qc, LOANS),
  })
}
