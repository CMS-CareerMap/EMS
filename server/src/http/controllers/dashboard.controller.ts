import type { RequestHandler } from 'express'
import { mySummary, payrollSummary, peopleSummary, todaySummary } from '../../modules/dashboard/dashboard.service'
import { appContext } from '../context'

/**
 * The home page's sections.
 *
 * Snake_case out, like the rest of v1. Nothing here has a fallback: a figure
 * that is not known comes back as null or zero, because the alternative is what
 * the old dashboard did — showing twelve days of casual leave to somebody who
 * had none, and then refusing the application.
 */

/** GET /api/dashboard/today — today at work, within the caller's attendance reach. */
export const getToday: RequestHandler = async (_req, res) => {
  const s = await todaySummary(appContext(res))
  res.status(200).json({
    data: {
      date: s.date,
      reach: s.reach,
      day_off: s.dayOff,
      holiday: s.holiday,
      headcount: s.headcount,
      counts: {
        present: s.counts.present,
        half_day: s.counts.halfDay,
        absent: s.counts.absent,
        on_leave: s.counts.onLeave,
        late: s.counts.late,
        away: s.counts.away,
        // Separate from absent, and it must stay separate. Adding them together
        // is how the old dashboard reported the whole company absent every
        // morning until somebody started marking.
        not_marked: s.counts.notMarked,
      },
      week: s.week.map((d) => ({
        date: d.date,
        present: d.present,
        half_day: d.halfDay,
        absent: d.absent,
        on_leave: d.onLeave,
        day_off: d.dayOff,
        holiday: d.holiday,
      })),
      people: s.people.map((p) => ({
        id: p.id,
        full_name: p.fullName,
        employee_id: p.employeeCode,
        designation: p.designation,
        department: p.department,
        status: p.status,
        check_in: p.checkIn,
        check_out: p.checkOut,
        late_minutes: p.lateMinutes,
        work_mode: p.workMode,
        is_self: p.isSelf,
      })),
      away: s.away.map((a) => ({
        employee_id: a.employeeId,
        full_name: a.fullName,
        kind: a.kind,
        label: a.label,
        from_date: a.from,
        to_date: a.to,
        status: a.status,
      })),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** GET /api/dashboard/people — the staff within the caller's employee reach. */
export const getPeople: RequestHandler = async (_req, res) => {
  const s = await peopleSummary(appContext(res))
  res.status(200).json({
    data: {
      date: s.date,
      total: s.total,
      active: s.active,
      inactive: s.inactive,
      by_department: s.byDepartment.map((d) => ({ department: d.department, headcount: d.headcount })),
      joiners: s.joiners.map((e) => ({
        id: e.id,
        full_name: e.fullName,
        employee_id: e.employeeCode,
        department: e.department,
        designation: e.designation,
        date_of_joining: e.dateOfJoining,
      })),
      leaving: s.leaving.map((e) => ({ id: e.id, full_name: e.fullName, department: e.department, last_working_date: e.lastWorkingDate })),
      recently_left: s.recentlyLeft.map((e) => ({ id: e.id, full_name: e.fullName, department: e.department, last_working_date: e.lastWorkingDate })),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** GET /api/dashboard/payroll — the newest runs, salary accounts, entries and loans. */
export const getPayroll: RequestHandler = async (_req, res) => {
  const s = await payrollSummary(appContext(res))
  const run = (r: typeof s.latest) => (r
    ? {
        id: r.id,
        year: r.year,
        month: r.month,
        status: r.status,
        employees: r.employees,
        gross: r.gross,
        deductions: r.deductions,
        net: r.net,
        employer_pf: r.employerPf,
        employer_esi: r.employerEsi,
        calculated_at: r.calculatedAt,
        approved_at: r.approvedAt,
        paid_on: r.paidOn,
      }
    : null)
  const people = (list: { employeeId: string; fullName: string; employeeCode: string }[]) =>
    list.map((p) => ({ employee_id: p.employeeId, full_name: p.fullName, employee_code: p.employeeCode }))
  res.status(200).json({
    data: {
      date: s.date,
      latest: run(s.latest),
      previous: run(s.previous),
      next: s.next,
      bank: s.bank
        ? {
            verified: s.bank.verified,
            waiting: s.bank.waiting,
            rejected: s.bank.rejected,
            unchecked: s.bank.unchecked,
            none: s.bank.none,
            to_check: people(s.bank.toCheck),
            without: people(s.bank.without),
          }
        : null,
      entries: s.entries,
      loans: s.loans,
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
        // For My Profile: the session carries identity only.
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
        late_minutes: summary.today.lateMinutes,
      },
      recent_days: summary.recentDays.map((d) => ({
        date: d.date,
        status: d.status,
        check_in: d.checkIn,
        check_out: d.checkOut,
        hours_worked: d.hoursWorked,
        late_minutes: d.lateMinutes,
        day_off: d.dayOff,
        holiday: d.holiday,
      })),
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
      // Leave waiting for them to decide (Day 22: people report to them).
      waiting_for_me: summary.waitingForMe,
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
