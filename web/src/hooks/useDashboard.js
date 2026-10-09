import { useQuery } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * The home page, one section at a time — each its own request, so one that
 * fails leaves the others standing, and each asked only by a login whose
 * permissions open it.
 *
 * THE FABRICATION THIS REPLACES. The old employee dashboard read leave balances
 * like this:
 *
 *     remaining_days: rawBalances.casual ?? 12
 *
 * An employee whose balance row did not exist — which is every employee
 * imported from a CSV — saw twelve days of casual leave. They applied for
 * them, and were refused by the same system that had just offered them.
 * Nothing here has a fallback: a figure that is not known comes back as zero,
 * because zero is what they have.
 */

const keys = {
  today: ['dashboard', 'today'],
  people: ['dashboard', 'people'],
  payroll: ['dashboard', 'payroll'],
  me: ['dashboard', 'me'],
}

/**
 * Today at work within the caller's attendance reach — a team, or the company.
 * Asked again every minute and on coming back to the tab: who has come in, and
 * the time at work a team's list runs, stay current (client, 9 Oct 2026).
 */
export function useTodayAtWork({ enabled = true } = {}) {
  return useQuery({
    queryKey: keys.today,
    queryFn: async () => (await api.get('/dashboard/today')).data,
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    // A failed refresh keeps the last answer on the card (DataState keepOnRefetchError), without a toast.
    meta: { quietRefetch: true },
  })
}

/** The staff within the caller's employee reach: headcount, departments, joiners, leavers. */
export function usePeopleSummary({ enabled = true } = {}) {
  return useQuery({ queryKey: keys.people, queryFn: async () => (await api.get('/dashboard/people')).data, enabled })
}

/** The newest payroll runs, salary accounts, amounts entered and loans. */
export function usePayrollSummary({ enabled = true } = {}) {
  return useQuery({ queryKey: keys.payroll, queryFn: async () => (await api.get('/dashboard/payroll')).data, enabled })
}

/** The signed-in person's own day, month, week and leave. `enabled` lets My Profile ask only when it needs to. */
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
        // The server's clock, for today's time at work in the week (client, 9 Oct 2026).
        serverNow: data.server_now ?? null,
        // The last seven days, today last, the company's days off named.
        recentDays: data.recent_days ?? [],

        recentLeaves: data.recent_leaves,
        // Leave waiting for them to decide (Day 22: people report to them).
        waitingForMe: data.waiting_for_me ?? 0,

        // Straight from the ledger. No `?? 12`.
        leaveBalances: data.leave_balances,
      }
    },
  })
}
