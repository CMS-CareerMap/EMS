import type { MyPayDays } from '../../modules/payroll/myPayDays.service'

/**
 * A month in pay terms, as the Attendance pages read it — one's own
 * (/attendance/me/pay-days) and somebody's month page (client, 15 Oct 2026).
 * One shape for both, so the two pages read the same figures the same way.
 */
export function payDaysPayload(d: MyPayDays) {
  return {
    year: d.year,
    month: d.month,
    employed: d.employed,
    paid_days: d.paidDays,
    unpaid_days: d.unpaidDays,
    employment_days: d.employmentDays,
    not_marked_days: d.notMarkedDays,
    leave_days: d.leaveDays.map((l) => ({ date: l.date, portion: l.portion, paid: l.paid, leave_type_name: l.leaveTypeName, code: l.code })),
    absent_days: d.absentDays.map((a) => ({
      date: a.date,
      applied: a.applied,
      leave: a.leave ? { status: a.leave.status, leave_type_name: a.leave.leaveTypeName, half: a.leave.half } : null,
      can_apply: a.canApply,
      why: a.why,
    })),
  }
}
