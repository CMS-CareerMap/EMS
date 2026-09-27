import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * Salary structures, from the server.
 *
 * The client's flow is "Accounts creates salary structure → creates payroll
 * run". This is the first half. Accounts holds no access to the HR directory,
 * so the roster here is their list of people — with the salary each one has,
 * or `salary: null` for the ones a payroll run could not yet pay.
 */

const keys = {
  roster: ['salary', 'roster'],
  history: (id) => ['salary', 'history', id],
  components: ['salary', 'components'],
}

export function useSalaryRoster({ enabled = true } = {}) {
  return useQuery({
    queryKey: keys.roster,
    queryFn: async () => (await api.get('/payroll/employees')).data,
    enabled,
  })
}

export function useSalaryHistory(employeeId) {
  return useQuery({
    queryKey: keys.history(employeeId),
    queryFn: async () => (await api.get(`/payroll/employees/${employeeId}/salary`)).data,
    enabled: Boolean(employeeId),
  })
}

/** The company's components, in payslip order, saying which are entered monthly. */
export function usePayrollComponents() {
  return useQuery({
    queryKey: keys.components,
    queryFn: async () => (await api.get('/payroll/components')).data,
    staleTime: 5 * 60_000,
  })
}

/**
 * Sets a salary from a date. A later date than the current salary is a raise —
 * the old one closes the day before; the same date is a correction.
 */
export function useSetSalary() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeId, effectiveFrom, ctc, components }) =>
      (await api.put(`/payroll/employees/${employeeId}/salary`, { effectiveFrom, ctc, components })).data,
    onSuccess: (_data, { employeeId }) => {
      queryClient.invalidateQueries({ queryKey: keys.roster })
      queryClient.invalidateQueries({ queryKey: keys.history(employeeId) })
      // The directory shows CTC to those allowed to see it.
      queryClient.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}
