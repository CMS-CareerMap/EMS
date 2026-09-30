import type { RequestHandler } from 'express'
import { companySummary, mySummary } from '../../modules/dashboard/dashboard.service'
import { appContext } from '../context'

/**
 * Dashboard payloads.
 *
 * Snake_case out, like the rest of v1. Nothing here has a fallback: a figure
 * that is not known comes back as null or zero, because the alternative is what
 * the old dashboard did — showing twelve days of casual leave to somebody who
 * had none, and then refusing the application.
 */

/** GET /api/dashboard/summary */
export const getCompanySummary: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const summary = await companySummary(ctx)

  res.status(200).json({
    data: {
      date: summary.date,
      total_employees: summary.totalEmployees,
      present_today: summary.presentToday,
      on_leave_today: summary.onLeaveToday,
      absent_today: summary.absentToday,
      // Separate from absent, and it must stay separate. Adding them together
      // is how the old dashboard reported the whole company absent every
      // morning until somebody started marking.
      not_marked_today: summary.notMarkedToday,
      is_weekly_off_today: summary.isWeeklyOffToday,
      weekly_off_today: summary.weeklyOffToday,

      pending_leave_count: summary.pendingLeaveCount,
      pending_leaves: summary.pendingLeaves.map((l) => ({
        id: l.id,
        employee_id: l.employeeId,
        employee_code: l.employeeCode,
        full_name: l.fullName,
        department: l.department,
        leave_type: l.leaveType,
        leave_type_name: l.leaveTypeName,
        from_date: l.fromDate,
        to_date: l.toDate,
        days: l.days,
        reason: l.reason,
        applied_on: l.appliedAt,
      })),

      by_department: summary.byDepartment.map((d) => ({
        department: d.department,
        headcount: d.headcount,
        present_today: d.presentToday,
      })),

      this_week: summary.thisWeek.map((d) => ({
        date: d.date,
        present: d.present,
        absent: d.absent,
        on_leave: d.onLeave,
      })),

      recent_joiners: summary.recentJoiners.map((e) => ({
        id: e.id,
        full_name: e.fullName,
        employee_id: e.employeeCode,
        department: e.department,
        date_of_joining: e.dateOfJoining,
      })),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** GET /api/dashboard/me */
export const getMySummary: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const summary = await mySummary(ctx)

  res.status(200).json({
    data: {
      date: summary.date,
      profile: {
        full_name: summary.employee.fullName,
        employee_id: summary.employee.employeeCode,
        department: summary.employee.department,
        designation: summary.employee.designation,
        date_of_joining: summary.employee.dateOfJoining,
        attendance_mode: summary.employee.attendanceMode,
        // For the profile drawer: the session carries identity only.
        phone: summary.employee.phone,
        reporting_manager_name: summary.employee.reportingManagerName,
        reporting_manager_designation: summary.employee.reportingManagerDesignation,
      },
      this_month: {
        present_days: summary.thisMonth.presentDays,
        half_days: summary.thisMonth.halfDays,
        absent_days: summary.thisMonth.absentDays,
        leave_days: summary.thisMonth.leaveDays,
        total_hours: summary.thisMonth.totalHours,
        weekly_off_days: summary.thisMonth.weeklyOffDays,
      },
      today: {
        status: summary.today.status,
        check_in: summary.today.checkIn,
        check_out: summary.today.checkOut,
        hours_worked: summary.today.hoursWorked,
      },
      // From the ledger, with no fallback. Somebody with no entitlement sees
      // zero — which is the truth, and stops them applying for days that were
      // never granted.
      leave_balances: summary.leaveBalances.map((b) => ({
        // The list is keyed on this. Without it React keys are undefined and
        // rows reuse each other on re-render.
        id: b.code,
        code: b.code,
        leave_type: b.code.toLowerCase(),
        name: b.name,
        total_days: b.annualQuota,
        remaining_days: b.available,
        balance: b.balance,
        pending: b.pending,
      })),
      recent_leaves: summary.recentLeaves.map((l) => ({
        id: l.id,
        leave_type: l.leaveType,
        leave_type_name: l.leaveTypeName,
        from_date: l.fromDate,
        to_date: l.toDate,
        days: l.days,
        status: l.status,
        applied_on: l.appliedAt,
      })),
    },
    meta: { requestId: res.locals.requestId },
  })
}
