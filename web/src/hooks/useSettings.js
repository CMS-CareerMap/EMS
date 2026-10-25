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
  workWeek: ['settings', 'work-week'],
  absentRule: ['settings', 'absent-rule'],
  geofence: ['settings', 'geofence'],
  attendanceSecurity: ['settings', 'attendance-security'],
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

/** Invalidates one settings key after a successful write — and any others that show the same thing. */
function useSettingMutation(key, fn, also = []) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all([key, ...also].map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  })
}

/**
 * The days off — the working week and the holidays — show on the attendance
 * calendar, the Timings card and the home page too.
 */
const DAYS_OFF_SHOWN = [['attendance', 'calendar'], ['attendance', 'me'], ['dashboard']]

export function useCompanySettings() {
  return useSetting(keys.company, '/settings/company')
}

export function useSaveCompany() {
  return useSettingMutation(keys.company, async (body) => (await api.put('/settings/company', body)).data)
}

export function usePayrollSettings() {
  return useSetting(keys.payroll, '/settings/payroll')
}

/**
 * The working week, dated (client, 25 Oct 2026): the weekly offs in force
 * today, changes saved for later, and the days a change may start on.
 */
export function useWorkWeek() {
  return useSetting(keys.workWeek, '/settings/work-week')
}

/**
 * Everything a weekly off shows on: every attendance page, the home page,
 * leave counts and balances, pay days and payroll, the reports.
 */
const WEEK_SHOWN = [['attendance'], ['dashboard'], ['leave'], ['payroll'], ['reports']]

/** Saves the weekly offs from a day: `{ weeklyOffDays, from }`. */
export function useSaveWorkWeek() {
  return useSettingMutation(keys.workWeek, async (body) => (await api.put('/settings/work-week', body)).data, WEEK_SHOWN)
}

/**
 * No check-in means Absent (client, 25 Oct 2026): on or off, from which day,
 * and how long the machine's file or HR's marking is waited for.
 */
export function useAbsentRule() {
  return useSetting(keys.absentRule, '/settings/absent-rule')
}

/**
 * What saving these values would do — days marked, days given back — asked
 * again as they change; nothing is written. Only while they differ from the
 * rule saved, and make sense (on, with a day).
 */
export function useAbsentRulePreview(values, { enabled }) {
  return useQuery({
    queryKey: ['settings', 'absent-rule-preview', values.on, values.from, values.waitDays],
    queryFn: async () => (await api.post('/settings/absent-rule/preview', values)).data,
    enabled,
  })
}

/** Saves the rule; the days are put right by it at once, so everything that shows a day is asked again. */
export function useSaveAbsentRule() {
  return useSettingMutation(keys.absentRule, async (body) => (await api.put('/settings/absent-rule', body)).data, WEEK_SHOWN)
}

/** Cancels a change saved for a later day. */
export function useCancelWorkWeek() {
  return useSettingMutation(keys.workWeek, async (from) => (await api.del(`/settings/work-week/${from}`)).data, WEEK_SHOWN)
}

export function useSavePayroll() {
  return useSettingMutation(keys.payroll, async (body) => (await api.put('/settings/payroll', body)).data, DAYS_OFF_SHOWN)
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
    onSuccess: () => Promise.all([keys.pfComponents, ['payroll'], ['salary'], ['payroll-components']].map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
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
  // Whether an office is saved is part of Attendance Security (the setup banner, the methods it allows).
  return useSettingMutation(keys.geofence, async (body) => (await api.put('/settings/geofence', body)).data, [keys.attendanceSecurity])
}

/** "Test this spot": the readings taken where the Super Admin stands, judged as a punch would be. Writes nothing. */
export function useTestGeofenceSpot() {
  return useMutation({
    mutationFn: async (readings) => (await api.post('/settings/geofence/test', { readings })).data,
    // Said beside the button, where the Super Admin is looking — not twice.
    meta: { quietCodes: ['VALIDATION_FAILED', 'BAD_REQUEST', 'NOT_FOUND', 'FORBIDDEN'] },
  })
}

/** Settings → Attendance Security (client, 11 and 14 Oct 2026): the punch method and the layers the company has on. */
export function useAttendanceSecurity({ enabled = true } = {}) {
  return useQuery({
    queryKey: keys.attendanceSecurity,
    queryFn: async () => (await api.get('/settings/attendance-security')).data,
    enabled,
  })
}

export function useSaveAttendanceSecurity() {
  // The employee's own card reads what a punch needs, from their workplace.
  return useSettingMutation(keys.attendanceSecurity, async (body) => (await api.put('/settings/attendance-security', body)).data, [['attendance', 'me']])
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

/**
 * Changes a leave type. `balances` says what a change of days a year did to
 * balances already granted — this year's when asked (`applyToThisYear`), next
 * year's when granted in advance; null when the days did not change. Balances
 * and the home page are read again, as they may have moved.
 */
export function useUpdateLeaveType() {
  return useSettingMutation(keys.leaveTypes, async ({ id, ...body }) => {
    const payload = await api.patch(`/settings/leave-types/${id}`, body)
    return { row: payload.data, balances: payload.meta?.balances ?? null }
  }, [['leave'], ['dashboard']])
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
  }, WEEK_SHOWN)
}

/** Moves or renames one — Eid's date is often only certain the evening before. */
export function useUpdateHoliday() {
  return useSettingMutation(keys.holidays, async ({ id, ...body }) => {
    const payload = await api.patch(`/holidays/${id}`, body)
    return { row: payload.data, approvedLeaveAffected: payload.meta?.approved_leave_affected ?? 0 }
  }, WEEK_SHOWN)
}

export function useDeleteHoliday() {
  return useSettingMutation(keys.holidays, async ({ id }) => {
    const payload = await api.del(`/holidays/${id}`)
    return { approvedLeaveAffected: payload?.meta?.approved_leave_affected ?? 0 }
  }, WEEK_SHOWN)
}
