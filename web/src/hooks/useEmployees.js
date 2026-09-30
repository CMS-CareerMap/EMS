import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * Employees, from the server.
 *
 * This file used to talk to a hosted backend — and, with none configured, to a
 * mock kept in the browser's localStorage. So the Employees page showed people
 * who did not exist anywhere the rest of the system could see: the attendance
 * roster, leave and payroll all read the real server and matched none of them.
 *
 * What the old create did that this does not, deliberately:
 *   · take a password — a new person gets an invitation link instead, so
 *     nobody types a colleague's first password into a form;
 *   · save salary — that is Accounts' to set, under Payroll, and the employee
 *     endpoints refuse a salary field outright;
 *   · save bank details — those go through their own verification flow;
 *   · notify hardcoded "demo-hr-admin-id" users who never existed.
 *
 * Bodies are sent in the server's shape (camelCase). Responses come back in
 * the snake_case the pages already read.
 */

const KEY = ['employees']

function invalidateAll(queryClient) {
  queryClient.invalidateQueries({ queryKey: KEY })
  // The attendance roster lists employees too; a new hire belongs on it today.
  queryClient.invalidateQueries({ queryKey: ['attendance'] })
  queryClient.invalidateQueries({ queryKey: ['users'] })
}

export function useEmployees({ enabled = true } = {}) {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await api.get('/employees')).data,
    enabled,
  })
}

/**
 * The company's departments, designations and shifts — the choices an employee
 * form offers, as ids. They change rarely, so they are kept for a while.
 */
export function useMasterData() {
  return useQuery({
    queryKey: ['master-data'],
    queryFn: async () => (await api.get('/master-data')).data,
    staleTime: 5 * 60_000,
  })
}

/**
 * Creates an employee, with a login if one was asked for.
 *
 * Returns the invitation alongside the employee: the link is issued once and
 * the server keeps only its hash, so this response is the only place it is
 * ever seen.
 */
export function useCreateEmployee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body) => {
      const payload = await api.post('/employees', body)
      return { employee: payload.data, invite: payload.meta?.invite ?? null }
    },
    onSuccess: () => invalidateAll(queryClient),
  })
}

/** Edits an employee. No role, status or salary — the server refuses all three. */
export function useUpdateEmployee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...body }) => (await api.patch(`/employees/${id}`, body)).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}

/**
 * The roster import: a dry run first, which saves nothing and says what is
 * wrong with each line, then the real import — all or nothing. The real one
 * returns each new person's invitation link, once.
 */
export function useImportEmployees() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ csv, dryRun }) => (await api.post('/employees/import', { csv, dryRun })).data,
    onSuccess: (_data, { dryRun }) => {
      if (!dryRun) invalidateAll(queryClient)
    },
  })
}
