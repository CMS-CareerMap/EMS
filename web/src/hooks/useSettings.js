import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * Company settings, served by our own API.
 *
 * Every one of these forms was previously hardcoded state: typing in them
 * changed nothing, Save showed a tick, and a reload put the old values back.
 * The geofence was worse — it lived in one administrator's localStorage, so
 * nobody else could see it and clearing the browser deleted it.
 */

const keys = {
  company: ['settings', 'company'],
  payroll: ['settings', 'payroll'],
  geofence: ['settings', 'geofence'],
  leaveTypes: ['settings', 'leave-types'],
  ptSlabs: ['settings', 'pt-slabs'],
  pfComponents: ['settings', 'pf-components'],
  // Shared with the Leave page's holiday list, so a holiday added here shows
  // there without a reload.
  holidays: ['leave', 'holidays'],
}

function useSetting(key, path) {
  return useQuery({
    queryKey: key,
    queryFn: async () => (await api.get(path)).data,
  })
}

/** Invalidates one settings key after a successful write. */
function useSettingMutation(key, fn) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  })
}

export function useCompanySettings() {
  return useSetting(keys.company, '/settings/company')
}

export function useSaveCompany() {
  return useSettingMutation(keys.company, async (body) => (await api.put('/settings/company', body)).data)
}

export function usePayrollSettings() {
  return useSetting(keys.payroll, '/settings/payroll')
}

export function useSavePayroll() {
  return useSettingMutation(keys.payroll, async (body) => (await api.put('/settings/payroll', body)).data)
}

/** The earning components, and which of them count as PF wages. */
export function usePfComponents() {
  return useSetting(keys.pfComponents, '/settings/pf-components')
}

/**
 * Counts one as PF wages, or stops. Payroll's own screens — Salary structure
 * marks each PF component — follow at once.
 */
export function useSetPfComponent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, countsForPf }) => (await api.patch(`/settings/pf-components/${id}`, { countsForPf })).data,
    onSuccess: () => Promise.all([keys.pfComponents, ['payroll'], ['salary']].map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  })
}

/**
 * Every set of rates the company has used, with the dates each applied.
 *
 * Worth surfacing rather than hiding: when somebody asks why February's payslip
 * deducted a different amount, this is the answer.
 */
export function usePayrollHistory() {
  return useSetting([...keys.payroll, 'history'], '/settings/payroll/history')
}

export function useGeofences() {
  return useSetting(keys.geofence, '/settings/geofence')
}

export function useSaveGeofence() {
  return useSettingMutation(keys.geofence, async (body) => (await api.put('/settings/geofence', body)).data)
}

export function useLeaveTypes() {
  return useSetting(keys.leaveTypes, '/settings/leave-types')
}

/**
 * Adds a leave type — or, when an archived one has that code, brings it back
 * with its history. `restored` says which, so the page can say so.
 */
export function useCreateLeaveType() {
  return useSettingMutation(keys.leaveTypes, async (body) => {
    const payload = await api.post('/settings/leave-types', body)
    return { row: payload.data, restored: Boolean(payload.meta?.restored) }
  })
}

export function useUpdateLeaveType() {
  return useSettingMutation(keys.leaveTypes, async ({ id, ...body }) =>
    (await api.patch(`/settings/leave-types/${id}`, body)).data,
  )
}

/** Archives. The row survives so existing leave balances stay explainable. */
export function useArchiveLeaveType() {
  return useSettingMutation(keys.leaveTypes, async ({ id }) => api.del(`/settings/leave-types/${id}`))
}

export function usePtSlabs(state) {
  return useQuery({
    queryKey: [...keys.ptSlabs, state ?? 'all'],
    queryFn: async () =>
      (await api.get(state ? `/settings/pt-slabs?state=${encodeURIComponent(state)}` : '/settings/pt-slabs')).data,
  })
}

/**
 * Replaces one state's PT table from a date. The server refuses a table that
 * could take more than ₹2,500 a year or leaves a salary in no slab.
 */
export function useSetPtTable() {
  return useSettingMutation(keys.ptSlabs, async (body) => (await api.put('/settings/pt-slabs', body)).data)
}

/** The holiday calendar — readable by everybody who applies for leave. */
export function useHolidays(year) {
  return useQuery({
    queryKey: [...keys.holidays, year ?? 'all'],
    queryFn: async () => (await api.get(year ? `/holidays?year=${year}` : '/holidays')).data,
  })
}

/**
 * Holiday changes. Each returns how many APPROVED leave requests cover that
 * day — leave already charged is not recalculated, and the page says so.
 */
export function useAddHoliday() {
  return useSettingMutation(keys.holidays, async (body) => {
    const payload = await api.post('/holidays', body)
    return { row: payload.data, approvedLeaveAffected: payload.meta?.approved_leave_affected ?? 0 }
  })
}

/** Moves or renames one — Eid's date is often only certain the evening before. */
export function useUpdateHoliday() {
  return useSettingMutation(keys.holidays, async ({ id, ...body }) => {
    const payload = await api.patch(`/holidays/${id}`, body)
    return { row: payload.data, approvedLeaveAffected: payload.meta?.approved_leave_affected ?? 0 }
  })
}

export function useDeleteHoliday() {
  return useSettingMutation(keys.holidays, async ({ id }) => {
    const payload = await api.del(`/holidays/${id}`)
    return { approvedLeaveAffected: payload?.meta?.approved_leave_affected ?? 0 }
  })
}
