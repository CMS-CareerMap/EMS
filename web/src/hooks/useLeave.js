import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * Leave, served by our own API.
 *
 * TWO SIGNATURES CHANGED, and the guide named them in advance (§A11):
 *
 *   useLeaveRequests(userId, role)  →  useLeaveRequests()
 *   useLeaveBalances(userId, role)  →  useLeaveBalances()
 *
 * The arguments are gone because the SERVER decides whose requests you see now.
 * Passing a user id from the browser was never a filter — it was a suggestion,
 * and anybody could suggest somebody else's. The data scope does it properly:
 * the company for HR, direct reports for a manager, their own for an employee.
 *
 * Call sites that must be edited: Leave.jsx:231 and Leave.jsx:384.
 */

const keys = {
  requests: ['leave', 'requests'],
  balances: ['leave', 'balances'],
  holidays: ['leave', 'holidays'],
}

/**
 * Returned, so a mutation's onSuccess waits for it: a dialog closes only once
 * the list shows the change, and the button that made it is gone — not still
 * there for a second click that the server would refuse.
 */
function invalidateAll(queryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['leave'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    // An approval writes attendance rows, so those figures move too.
    queryClient.invalidateQueries({ queryKey: ['attendance'] }),
  ])
}

/** No arguments. Whose requests these are is the server's decision. */
export function useLeaveRequests(filters = {}, { enabled = true } = {}) {
  const query = new URLSearchParams()
  if (filters.status) query.set('status', filters.status)
  if (filters.employeeId) query.set('employeeId', filters.employeeId)

  const suffix = query.toString() ? `?${query}` : ''

  return useQuery({
    queryKey: [...keys.requests, suffix],
    queryFn: async () => (await api.get(`/leave-requests${suffix}`)).data,
    enabled,
  })
}

/**
 * Team requests (Day 22): the leave of the people whose leave the caller
 * decides in the company tree — their direct reports, and for the Super Admin
 * the people with nobody above — whatever the caller's role. `backup` is the
 * waiting requests they may decide only as the stand-in.
 */
export function useTeamLeave({ enabled = true } = {}) {
  return useQuery({
    queryKey: ['leave', 'team'],
    queryFn: async () => {
      const payload = await api.get('/leave-requests/team')
      return { requests: payload.data.requests, backup: payload.data.backup, decidesFor: payload.meta?.decides_for ?? 0 }
    },
    enabled,
  })
}

/**
 * Balances for the caller.
 *
 * Returns the array the Balance tab already renders, and adds `pending` — days
 * asked for and not yet decided. Showing only the raw balance is how somebody
 * applies for days already spoken for.
 */
export function useLeaveBalances({ enabled = true } = {}) {
  return useQuery({
    queryKey: keys.balances,
    queryFn: async () => {
      const payload = await api.get('/leave-requests/balances')
      return payload.data.balances
    },
    enabled,
  })
}

/**
 * What a request would cost, before committing to it.
 *
 * Its own call because the answer is not obvious: five calendar days can be
 * three working days once the weekend and a holiday come out, and somebody
 * about to spend three of their four remaining days should see that first.
 */
export function usePreviewLeave() {
  return useMutation({
    mutationFn: async ({ leave_type_id, from_date, to_date, half_day_dates, half_day_sessions }) =>
      (
        await api.post('/leave-requests/preview', {
          leaveTypeId: leave_type_id,
          fromDate: from_date,
          toDate: to_date,
          ...(half_day_dates?.length ? { halfDayDates: half_day_dates } : {}),
          ...(half_day_sessions && Object.keys(half_day_sessions).length ? { halfDaySessions: half_day_sessions } : {}),
        })
      ).data,
  })
}

export function useApplyLeave() {
  const queryClient = useQueryClient()

  return useMutation({
    // No `days` field. The server counts it from the dates, the weekly-off
    // pattern and the holiday calendar — a number sent from here would be a
    // claim, and the balance would believe it.
    mutationFn: async ({ leave_type_id, from_date, to_date, reason, half_day_dates, half_day_sessions, employee_id }) =>
      (
        await api.post('/leave-requests', {
          leaveTypeId: leave_type_id,
          fromDate: from_date,
          toDate: to_date,
          reason,
          ...(half_day_dates?.length ? { halfDayDates: half_day_dates } : {}),
          ...(half_day_sessions && Object.keys(half_day_sessions).length ? { halfDaySessions: half_day_sessions } : {}),
          ...(employee_id ? { employeeId: employee_id } : {}),
        })
      ).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}

/**
 * Approving or rejecting.
 *
 * Kept under the old name so the Leave page's approve and reject buttons do not
 * have to be rewritten in the same commit that moves the data.
 */
export function useUpdateLeaveStatus() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, status, note }) => {
      const action = status === 'approved' ? 'approve' : 'reject'
      return (await api.post(`/leave-requests/${id}/${action}`, note ? { note } : {})).data
    },
    onSuccess: () => invalidateAll(queryClient),
  })
}

/**
 * Undoing an approval.
 *
 * Separate from rejecting, because they are different acts: a rejection never
 * took any days, a reversal gives back days that were spent.
 */
export function useReverseLeave() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, note }) =>
      (await api.post(`/leave-requests/${id}/reverse`, note ? { note } : {})).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}

/** Withdrawing your own request, while it is still pending. */
export function useWithdrawLeave() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id }) => (await api.del(`/leave-requests/${id}`)).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}

export function useHolidays(year) {
  return useQuery({
    queryKey: [...keys.holidays, year ?? 'all'],
    queryFn: async () =>
      // /holidays, not /settings/holidays: the settings route was Super Admin
      // only, so this list was a permission error for every employee.
      (await api.get(year ? `/holidays?year=${year}` : '/holidays')).data,
  })
}

// ── Leave → Team Balances ─────────────────────────────────────────────────────

/**
 * Everybody's balances this person may see — the company for HR and the Super
 * Admin, their team for a manager — for one leave year (this one when left out).
 * `waiting` is how many people have not had the year's grant; null for anybody
 * who may not grant it.
 */
export function useTeamBalances(leaveYear, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['leave', 'team-balances', leaveYear ?? 'current'],
    queryFn: async () => (await api.get(leaveYear ? `/leave-balances?year=${leaveYear}` : '/leave-balances')).data,
    enabled,
    // Switching years keeps the table in place until the other year arrives.
    placeholderData: (previous) => previous,
  })
}

/** What "Grant leave" would do, read fresh each time the dialog opens. */
export function useGrantPreview(leaveYear, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['leave', 'grant-preview', leaveYear],
    queryFn: async () => (await api.get(`/leave-balances/grant-preview?year=${leaveYear}`)).data,
    enabled: enabled && Boolean(leaveYear),
    staleTime: 0,
  })
}

export function useGrantLeave() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ leaveYear }) => (await api.post('/leave-balances/grant', { leaveYear })).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}

/** One correction: `days` positive adds, negative takes away; `note` is shown to the employee. */
export function useAdjustBalance() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeId, leaveTypeId, leaveYear, days, note }) =>
      (await api.post('/leave-balances/adjustments', { employeeId, leaveTypeId, leaveYear, days, note })).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}
