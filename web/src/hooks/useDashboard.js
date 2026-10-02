import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

const DEPARTMENT_COLOURS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#14B8A6', '#EC4899', '#6366F1', '#84CC16', '#F97316']

/**
 * The dashboards.
 *
 * THE FABRICATION THIS REPLACES. The old employee dashboard read leave balances
 * like this:
 *
 *     remaining_days: rawBalances.casual ?? 12
 *
 * An employee whose balance row did not exist — which is every employee
 * imported from a CSV — saw twelve days of casual leave, eighteen earned,
 * twenty-four work-from-home. They applied for them, and were refused by the
 * same system that had just offered them.
 *
 * Nothing here has a fallback. A figure that is not known comes back as zero,
 * because zero is what they have.
 */

const keys = {
  company: ['dashboard', 'summary'],
  me: ['dashboard', 'me'],
}

/**
 * The company view — for HR, admins and managers.
 *
 * Scoped by the server: a manager's figures cover their team, HR's cover the
 * company. The page does not ask for one or the other; it asks for "the
 * dashboard", and gets the one that belongs to whoever is signed in.
 */
export function useDashboardStats() {
  return useQuery({
    queryKey: keys.company,
    queryFn: async () => {
      const { data } = await api.get('/dashboard/summary')

      return {
        date: data.date,
        totalEmployees: data.total_employees,
        presentToday: data.present_today,
        onLeaveToday: data.on_leave_today,
        absentToday: data.absent_today,
        // Kept apart from absent, and the UI should keep them apart too. The
        // old dashboard added them and reported the whole company absent every
        // morning until somebody started marking.
        notMarkedToday: data.not_marked_today,

        // Derived from the weekly-off policy, not counted — the system does
        // not create attendance rows for days nobody works. Reporting zero
        // would say everybody was absent on a Sunday.
        isWeeklyOffToday: data.is_weekly_off_today,
        weeklyOffToday: data.weekly_off_today,

        pendingLeaveCount: data.pending_leave_count,
        // Of those, the ones the caller decides in the company tree (Day 22).
        pendingForMe: data.pending_for_me ?? 0,
        pendingLeaves: data.pending_leaves,

        // Each department its own colour, for the chart and its legend. The
        // chart drew colourless, invisible slices without one.
        deptData: data.by_department.map((d, i) => ({
          name: d.department,
          value: d.headcount,
          present: d.present_today,
          color: DEPARTMENT_COLOURS[i % DEPARTMENT_COLOURS.length],
        })),

        // Same derivation, per department: on a weekly off the whole department
        // is off, and on any other day none of it is.
        deptWeeklyOff: data.is_weekly_off_today
          ? data.by_department.map((d) => ({ name: d.department, value: d.headcount }))
          : [],

        weekData: data.this_week.map((d) => ({
          date: d.date,
          day: new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-IN', {
            weekday: 'short',
            timeZone: 'UTC',
          }),
          present: d.present,
          absent: d.absent,
          onLeave: d.on_leave,
        })),

        recentJoiners: data.recent_joiners,
      }
    },
  })
}

/** Approving straight from the dashboard's pending list. */
export function useApproveLeaveDashboard() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, status, note }) => {
      const action = status === 'approved' ? 'approve' : 'reject'
      return (await api.post(`/leave-requests/${id}/${action}`, note ? { note } : {})).data
    },
    // Returned: the buttons stay held until the list no longer shows the request.
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['leave'] }),
      queryClient.invalidateQueries({ queryKey: ['attendance'] }),
    ]),
  })
}

/** The employee's own view. `enabled` lets the profile drawer ask only when it is open. */
export function useMyDashboardStats({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: keys.me,
    queryFn: async () => {
      const { data } = await api.get('/dashboard/me')

      return {
        profile: data.profile,

        presentDays: data.this_month.present_days,
        halfDays: data.this_month.half_days,
        absentDays: data.this_month.absent_days,
        leaveDays: data.this_month.leave_days,
        // The figure the client asked for. Summed on the server from stored
        // hours, so it matches the attendance page and the payslip.
        totalHours: data.this_month.total_hours,

        // Counted on the server from the weekly-off rule, 1st to today: nobody
        // marks a weekly off, so there are no attendance rows to count.
        weeklyOffDays: data.this_month.weekly_off_days,

        todayStatus: data.today.status,
        today: data.today,

        recentLeaves: data.recent_leaves,
        // Leave waiting for them to decide (Day 22: people report to them).
        waitingForMe: data.waiting_for_me ?? 0,

        // Straight from the ledger. No `?? 12`.
        leaveBalances: data.leave_balances,
      }
    },
  })
}
