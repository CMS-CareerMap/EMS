import { useMemo } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { useSalaryRoster } from '../../hooks/useSalary'
import { useEmployees } from '../../hooks/useEmployees'

/**
 * The people a payroll screen can choose from, as { id, code, name }.
 *
 * Accounts holds no access to the staff directory, and HR none to salaries, so
 * each reads the list it is allowed: the salary roster for payroll staff, the
 * directory for HR entering incentives. Same people, either way.
 */
export function usePayrollPeople() {
  const can = useAuthStore((s) => s.can)
  const fromRoster = can('payroll:structure:read')
  const roster = useSalaryRoster({ enabled: fromRoster })
  const directory = useEmployees({ enabled: !fromRoster && can('employee:read') })

  const people = useMemo(() => {
    const list = fromRoster
      ? (roster.data ?? []).map((e) => ({ id: e.employee_id, code: e.employee_code, name: e.full_name }))
      : (directory.data ?? []).map((e) => ({ id: e.id, code: e.employee_id, name: e.full_name }))
    return list.sort((a, b) => a.name.localeCompare(b.name))
  }, [fromRoster, roster.data, directory.data])

  return { people, isLoading: fromRoster ? roster.isLoading : directory.isLoading }
}
