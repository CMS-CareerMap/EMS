# Requirements traceability

How each section of the client's requirements document ("CMS HRMS Functional Requirements",
69 sections) maps to the code and to the tests that prove it, for the single-company build
for CareerMap Solutions. Checked on 6 Oct 2026, branch `fix/holiday-card`.

Status:
- **Built**: in the code, with a test.
- **Built, differs**: built to a decision taken with the client that differs from the text.
- **Partly**: the core is built; the noted part is not.
- **Not built**: in scope, not built. See "Open" at the end.
- **Out of scope**: SaaS / more than one company / branches.

Paths: `S` = `server/src`, `W` = `web/src`, `E2E` = `e2e/suites`.

## Out of scope

| § | What | Note |
|---|---|---|
| 1, 2, 6, 7, 10–18, 52, 54–56, 61 (SaaS entities), 67 (Phase 1 SaaS, Phase 8) | Platform admin, company onboarding, licences, subscriptions, billing, module licensing | One company. Every row is company-scoped already (`S/platform/db/scoped.ts`), so a later SaaS phase starts from there. |
| 9 | Branches | CareerMap has one office. |
| 39, 60 (parts) | More than one country, currency or language | India payroll only; country and currency are settings for display. |

## Sign-in, roles, permissions, security

| § | Requirement | Status | Where | Proved by |
|---|---|---|---|---|
| 3, 19, 49 | System roles; the Super Admin edits permissions | Built, differs: seven roles, and the Super Admin may also add roles (client decision, Day 21) | `S/platform/authz/defaultRoles.ts`, `S/modules/roles`, `W/features/settings/RolesSettings.jsx` | `authz.test.ts`, `roles.test.ts`; E2E `day21` |
| 4 | Sign in with Employee ID or email + password, no OTP | Built (the ID in any letters; an employee login may have no email; for somebody with two logins the ID opens the employee login — 6 Oct) | `S/modules/auth` | `auth.test.ts`, `passwords.test.ts`, `twoLogins.test.ts`; E2E `day20`, `day23`, `passwords`, `demo-tour` |
| 4, 63 | HR creates the Employee ID and password by hand; the employee cannot change it, HR can; a role login's password is the Super Admin's (client, 6 Oct 2026) | Built, as a setting with those defaults (Settings → Users & Roles → Passwords: either kind can be handed back to the person, with links; shortest password 10, from 8 to 64). Nothing generated; a roster import's logins wait for HR | `S/domain/org/passwords.ts`, `S/modules/user` (`setPassword`, `loginStartFor`), `W/features/settings/PasswordRules.jsx`, `W/features/settings/SetPasswordDialog.jsx` | `passwords.test.ts`, `recovery.test.ts`; E2E `passwords`, `golden` |
| 4 | Statuses Active / Inactive / Suspended / Expired / Locked | Partly: active, inactive and invited; "locked" is the sign-in rate limit (10 tries / 15 min) | `S/http/middleware/rateLimit.ts` | `auth.test.ts`, `rateLimit.test.ts` |
| 5, 58 | Works on phone, tablet, desktop | Built | whole web app | E2E `sweep23` (every page × role × 390 px), `demo-tour` |
| 20 | View / Add / Edit / Approve / Upload / Download / Export per module | Partly: permissions are per module; downloads and exports ride on the read permission; approvals follow the company tree | `S/platform/authz/catalogue.ts` | `authz.test.ts` |
| 21–26 | What each role may do | Built (HR sees salaries except seniors' — client decision, Day 22) | `defaultRoles.ts` | `authz.test.ts`, `employee.test.ts`; E2E `day20`, `demo-tour` |
| 50 | Role + module + action + data scope | Built | `S/platform/authz/scope*.ts` | `roles.test.ts`; E2E `day22` |
| 51, 53 | Company id on every row and request | Built | `S/platform/db/scoped.ts` | `scoped.test.ts`, `tenant.test.ts` |
| 59 | Checked on the server, not just hidden buttons | Built | `S/http/middleware/authorize.ts`, allow-list serializers | `employee.test.ts`; E2E `day20` "Refusals" |

## Company, settings, data

| § | Requirement | Status | Where | Proved by |
|---|---|---|---|---|
| 8 | Company profile | Partly: no logo, registration number, industry or company type | `W/features/settings/CompanySettings.jsx` | `settings.test.ts`; E2E `golden` |
| 48 | Departments, designations, shifts, GPS radius, leave, payroll and statutory rules, permissions, notification switches | Built (payroll is monthly only) | `W/pages/Settings.jsx` tabs | `masterData.test.ts`, `settings.test.ts`, `v1Extras.test.ts` |
| 60 | Company time zone, UTC storage, holidays, weekly offs | Built (holidays and weekly offs also show on each person's attendance calendar) | `Organization.timezone`, `W/lib/dates.js`, `GET /attendance/calendar` | `attendance.test.ts`, `holidays.test.ts`, `attendanceCalendar.test.ts`; E2E `newlook` |
| 60 | Date format | Built, differs: one format everywhere, "4 Oct 2026"; there is no date format setting (client decision) | `W/lib/dates.js` | `settings.test.ts` |

## Employees and lifecycle

| § | Requirement | Status | Where | Proved by |
|---|---|---|---|---|
| 42 | Personal, employment, salary, bank, tax, login details | Built (no separate Team Leader field: the reporting manager is it) | `S/modules/employee`, `W/features/employees` | `employee.test.ts`, `requests.test.ts` |
| 63 | Add → ID → department → designation → manager → role → login → active; bulk import | Built (employee code typed, not generated; the login's password typed by HR, so it is active at once — 6 Oct; 4 Oct: the import takes a `shift` column, so imported people's days are measured) | Add Employee, Import Employees | `userManagement.test.ts`, `import.test.ts`; E2E `golden` |
| 43 | Joining → onboarding → probation → confirmed → transfer / promotion → resignation → notice → exit → inactive | Built | `S/modules/lifecycle`, `W/features/employees/EmploymentSection.jsx` | `lifecycle.test.ts`; E2E `lifecycle` |
| 43 | Leave after the last working day | Built (4 Oct): waiting leave after it is cancelled, approved leave given back, leave across it cannot be approved | `S/modules/leave/leaveApproval.service.ts` `settleLeaveAfter` | `lifecycle.test.ts` "settles the leave after the last working day" |
| 64 | Leaving closes every login and keeps the history | Built (no retention setting) | lifecycle exit, Settings → Users | `lifecycle.test.ts`, `userManagement.test.ts`; E2E `day23` |
| 44 | Documents by type and role | Partly: access is by role and scope, not per document | `S/modules/documents` | `documents.test.ts`; E2E `day19` |
| 27 | Changing one's details goes to HR; one's own record is never edited directly | Built (4 Oct: direct edits of one's own record, a fellow HR person's or a senior's go up the tree) | `S/modules/requests`, `S/modules/organization/workRules.service.ts` | `requests.test.ts`, `lifecycle.test.ts`; E2E `v1gaps` |

## Requests and leave

| § | Requirement | Status | Where | Proved by |
|---|---|---|---|---|
| 28 | One level of approval, set in Settings; Super Admin on top | Built | `S/domain/leave/approval.ts`, Settings → Approvals | `leaveApproval.test.ts`, `approval.test.ts`; E2E `day22` |
| 29 | Leave, half day, correction, overtime, WFH, on duty, profile change, encashment | Built | `RequestType`, leave engine | `requests.test.ts`, `v1Extras.test.ts`; E2E `v1gaps` |
| 29 | Expense, reimbursement, other request types | Not built (Expense is "Phase 8 — Future" in §67) | — | — |
| 36 | Leave types and their rules | Built (4 Oct: a request may not cross the start of the leave year) | `S/domain/leave`, `W/features/settings/LeaveTypeRulesDialog.jsx` | `rules.test.ts`, `grant.test.ts`, `leave.test.ts`; E2E `v1gaps2` |
| 37 | Full day, first half, second half | Built | `ApplyLeaveModal.jsx` | `leave.test.ts`, `v1Extras.test.ts` |
| — | Who gets how much leave, and from when (client, 9 Oct 2026): days a year per type, what a new joiner gets (months left / months after joining / full year), usable after N days or after confirmation — settings, for everybody | Built (10 Oct) | `LeaveType.joinerGrant`, `usableAfterConfirmation`; `S/domain/leave/grant.ts`, `rules.ts`; `W/features/settings/LeaveTypeRulesDialog.jsx` | `policy.test.ts`, `leavePolicy.test.ts`; E2E `leavepolicy` |
| — | One person's own days a year, on the profile and when adding them; a change applies to this year's balance at once, days taken never taken back | Built (10 Oct) | `EmployeeLeaveEntitlement`, `S/modules/leave/leaveEntitlement.service.ts`, `W/features/employees/EmployeeLeave.jsx`, `JoinerLeaveDays.jsx` | `leavePolicy.test.ts`; E2E `leavepolicy` |
| — | Leave given automatically: a joiner's share when added or imported, a new year by the nightly job; a corrected joining date re-works it | Built (10 Oct; the nightly job runs once deployed) | `leaveEntitlement.service.ts`, `scripts/maintenance.ts` | `leavePolicy.test.ts`; E2E `leavepolicy` |
| — | Attendance shows each day's leave by type and the month's unpaid days (loss of pay), as payroll counts them (25 Oct: "Paid days 31 of 31" removed, it confused) | Built (10 Oct) | `S/modules/payroll/myPayDays.service.ts` (`lossOfPayOf` shared with the run), `W/features/attendance/SelfAttendance.jsx`, `MonthCalendar.jsx` | `leaveExtras.test.ts`; E2E `leaveextras` |
| — | One person's month (client, 15 Oct): a name on Attendance — the roster, the month's hours, Suspicious, the profile's Attendance tab — opens that person's calendar, days and month so far counted to today (live while they are in), with the unpaid days (loss of pay); by the attendance scope (a manager their team, HR everybody), anybody else told "not yours to see"; one count for that page, one's own page and Home's "My month" | Built (15 Oct) | `S/domain/attendance/monthSoFar.ts`, `S/modules/attendance/personMonth.service.ts`, `GET /api/attendance/people/:id/month`, `W/pages/PersonAttendance.jsx`, `W/features/attendance/PersonMonth.jsx`, `MonthFigures.jsx`, `DayLog.jsx` | `monthSoFar.test.ts`, `attendanceAdmin.test.ts` ("one person's month"); E2E `personmonth` |
| — | An absent day: the employee is told and offered "Apply leave"; approved leave turns an unpunched absent day into leave, a reversal puts it back | Built (10 Oct) | `S/modules/attendance/attendanceNotices.ts`, `attendance.repository.ts` `takeOverAbsentDay`/`releaseLeaveDays` | `leaveExtras.test.ts`; E2E `leaveextras` |
| — | A leave statement per type (a passbook), for the employee and for HR | Built (10 Oct) | `leave.service.ts` `statementFor`, `W/features/leave/StatementDialog.jsx` | `leaveExtras.test.ts`; E2E `leaveextras` |
| — | A reminder before the leave year ends of paid leave days that will lapse, once a person a year, lead days a setting | Built (10 Oct; sent by the nightly job once deployed) | `leaveEntitlement.service.ts` `remindLeaveYearEnd`, `LeaveYearEndNotice`, Leave Config | `leaveExtras.test.ts`; E2E `leaveextras` |
| — | Who else of the team is away, beside a request being decided | Built (10 Oct) | `domain/leave/applications.ts` `awayDuring`, `W/features/leave/TeamAway.jsx` | `policy.test.ts`, `leaveExtras.test.ts`; E2E `leaveextras` |
| — | Loss of Pay: unpaid with no limit; the rest of a short application as Loss of Pay, one application decided as one; Work From Home off the leave list | Built (10 Oct) | `S/domain/leave/leaveDays.ts` `splitAtBalance`, `applications.ts`, `leave.service.ts`, `leaveApproval.service.ts`, migration `20261010051204_leave_policy_loss_of_pay` | `policy.test.ts`, `leavePolicy.test.ts`; E2E `leavepolicy`, `day20` |

## Attendance

| § | Requirement | Status | Where | Proved by |
|---|---|---|---|---|
| 30 | Check-in inside the office radius | Built (11 Oct, the client: 15–20 m, never a metre more — the point itself must be inside, no allowance for a vague reading; one office; a burst of readings, the best kept; a signed start token of 2 minutes; a refused attempt kept as evidence) | `S/domain/attendance/geofence.ts`, `attendance.service.ts` `startPunch`/`punchIn`, `punchToken.ts`, migration `20261010192108_checkin_security_location` | `attendance.domain.test.ts`, `attendance.test.ts`, `settings.test.ts`; E2E `checkinsecurity` (20 m in, 21 m out), `golden` |
| 31, 33 | Location, time, device, work mode | Built (11 Oct: check-out inside the office too, a setting, on by default; refused → "Ask HR to record your check-out") | `Attendance`, `PunchEvidence` models | `attendance.test.ts`; E2E `checkinsecurity` |
| — | Attendance Security settings: every layer on/off by the Super Admin, every change audited | Built (11 Oct) | `S/modules/settings/settings.service.ts`, `W/features/settings/AttendanceSecurity.jsx` | `settings.test.ts`; E2E `checkinsecurity` |
| — | Phones only; signs a location may be faked, flagged for HR (never blocking); Suspicious punches list with each punch's evidence | Built (11 Oct) | `S/domain/attendance/punchSignals.ts`, `suspicious.service.ts`, `W/features/attendance/SuspiciousPunches.jsx`, `PunchEvidence.jsx`, migrations `20261010201217_checkin_security_signals`, `20261011051452_checkin_security_more_flags` | `punchSignals.test.ts`, `attendance.test.ts`; E2E `checkinsecurity` |
| — | Selfie at check-in/out (a setting, off by default; kept 60 days, a setting) and one phone per employee (a setting, off by default; a new phone waits for HR) | Built (11 Oct) | `punchPhotos.service.ts`, `punchDevices.service.ts`, `W/features/attendance/SelfieDialog.jsx`, migration `20261010202302_checkin_security_selfie_device` | `attendance.test.ts`; E2E `checkinsecurity` (fake camera, second phone) |
| — | The punch method (client, 14 Oct): exactly one of Location / Selfie / Location + Selfie, never none; Location + Selfie for several sites (warehouses): the current location wherever they stand, first (no location, no camera), kept with the photo, never fenced, no office needed — a reading vaguer than 100 m flagged (`location_vague`), and the place on a map (Open map) in Evidence and Suspicious; check-out proved as its day was checked in; phones only for any punch that reads the location; Location needs a saved office, and the office cannot go while Location uses it; one phone works with any method — first phone registers itself, another refused ("Contact HR"), Replace (new on, old off, one step) and Reset (next new phone registers itself) by whoever holds `user:device:manage` (Super Admin, HR, Admin to start; never one's own or a senior's); setup-not-finished banner | Built (14 Oct) | `S/domain/attendance/punchMethod.ts`, `attendance.service.ts`, `punchDevices.service.ts`, `settings.service.ts`, `W/features/settings/AttendanceSecurity.jsx`, `W/features/employees/PunchPhones.jsx`, `W/features/home/AttendanceSetupBanner.jsx`, migrations `20261014125758_punch_method`, `20261014173144_punch_location_vague` | `attendance.test.ts` ("the punch method"), `settings.test.ts`, `punchMethod.test.ts`, `punchSignals.test.ts`, `catalogue.test.ts`; E2E `punchmethod`, `checkinsecurity` |
| — | Precise location only (client, 25 Oct): where a punch reads the location without the office fence (Location + Selfie, check-in and check-out; a day away that asks for it), a reading vaguer than the Super Admin's metres (100 m to start, 20–500) is refused — no camera, no punch — the try kept for HR, and the card says how to turn precise location on (a phone's "Approximate" is 1–3 km); the check-in chip says "on time" only when lateness was measured as 0, "outside your shift hours" when it was not | Built (25 Oct) | `attendance.service.ts` (`refuseImprecise`), `PunchCard.jsx`, `usePunch.js`, `AttendanceSecurity.jsx`; migration `20261025181827_punch_precise_location` | `attendance.test.ts`; E2E `punchmethod`, `livetime` |
| 32 | WFH on an approved request | Built | requests `work_from_home` | `requests.test.ts`; E2E `v1gaps` |
| 34 | Shifts with grace, late, early, minimum hours, overtime | Built (4 Oct: night shifts checked out of the next morning; a check-in after midnight counts for last night. 8 Oct, the client's day: full from 8 h worked, half from 4.5 h, under that absent, no break taken off — on a new company's shifts and in the Shifts table; the Timings card says it) | `S/domain/attendance/shiftRules.ts`, `hours.ts`, `attendance.service.ts`, `W/features/settings/OrganisationSettings.jsx` | `shiftRules.test.ts`, `attendance.domain.test.ts`, `attendance.test.ts`, `attendanceCalendar.test.ts`, E2E `dayrules` |
| 35 | Overtime: recorded, claimed, approved, paid | Built (off until the company turns it on) | requests `overtime`, `payroll.service.ts` | `v1Extras.test.ts`; E2E `v1gaps` |
| — | Biometric machine import | Built (4 Oct: the screen — the import itself was there since Day 12. 11 Oct: any machine's file — one line a day or one line a scan, first scan in, last out; matched by Machine ID or employee code; an app day is confirmed by the machine, never overwritten — confirmed / time differs (30 min, a setting) / not on the machine (flag, or absent, a setting); a day with no app punch filled from the machine; payroll warns) | `S/domain/attendance/machineFile.ts`, `attendanceImport.service.ts`, `W/features/attendance/ImportAttendanceModal.jsx`, migration `20261010194830_checkin_security_machine` | `machineFile.test.ts`, `attendanceAdmin.test.ts`, `payrollRun.test.ts`; E2E `checkinsecurity`, `golden` |
| — | Hours worked, daily and for the month | Built (4 Oct: the month's hours per person on Attendance → Monthly, with a month picker for HR and managers too, and on the dashboard) | `W/pages/Attendance.jsx` | `attendanceAdmin.test.ts` "monthly hours"; E2E `golden` |
| — | A half day of leave, the other half worked | Built (4 Oct: the worked half is graded as a half) | `forWorkedHalf` | `attendance.test.ts`, `attendanceAdmin.test.ts` |
| — | No check-in means Absent (client, 25 Oct): a working day that ends with no punch, no leave and nobody's mark is Absent — "no check-in" — for everybody, from a day the Super Admin chooses (previewed before saving); a day is judged when the shift ends (a night shift the next morning), machine-file and HR-marked people after the days of waiting; weekly offs and holidays never; a half-day leave with no punch is half absent; punch, leave, correction, HR's mark and the machine's file replace it, switched off it gives back every day it wrote; closed payroll months never change; the person told; nightly and at once after a change of the rule, the week or a holiday | Built (25 Oct) | `S/domain/attendance/noCheckIn.ts`, `absentRule.service.ts`, `scripts/maintenance.ts`, `W/features/settings/AbsentRuleSection.jsx`, migration `20261025082915_absent_rule_and_work_week` | `noCheckIn.test.ts`, `absentRule.test.ts` (one answer for every role); E2E `absentrule` |
| — | Forgot to check out (client, 25 Oct): the day stays present; the person told once two hours after the shift; "No Out" on the roster | Built (25 Oct) | `checkOutNudge.service.ts`, `scripts/hourly.ts`, `deploy/crontab`, `W/lib/attendance.js` `noCheckOutOf` | `absentRule.test.ts`; E2E `absentrule` |
| — | Mark the people ticked (client, 25 Oct): only those ticked, one status, a reason kept on each day; a day with a check-in left out | Built (25 Oct) | `attendanceAdmin.service.ts` `markMany`, `W/features/attendance/MarkManyDialog.jsx`, `TeamDay.jsx` | `absentRule.test.ts`; E2E `absentrule` |
| — | The working week by day (client, 25 Oct): a change from today, the 1st of next month or (setting up) the 1st of this month; every screen asks the week in force on each day — leave, calendars, month so far, home, payroll, reports; lint rule 9 | Built (25 Oct) | `S/domain/shared/workWeek.ts`, `workWeek.service.ts`, `W/features/settings/WeeklyOffPicker.jsx`, `scripts/architecture.ts` R9 | `workWeek.test.ts` (domain and API), `attendanceCalendar.test.ts`, `architecture.test.ts`; E2E `absentrule` |
| — | The month in plain words (client, 25 Oct): "Paid days 31 of 31" removed — the month shows the days cut (loss of pay) and the days not marked, paid until marked; a day checked into and never out left out of hours and expected (the person's month and the monthly hours table alike), "Not marked" on the calendar; the attendance report's weekly offs and holidays counted as the month page counts them | Built (25 Oct) | `monthSoFar.ts`, `myPayDays.service.ts`, `attendanceAdmin.service.ts` `monthlySummary`, `reportMath.ts` `daysOffWithin`, `W/features/attendance/MonthFigures.jsx`, `MonthCalendar.jsx` | `monthSoFar.test.ts`, `absentRule.test.ts`, `reports.test.ts`; E2E `absentrule` |
| — | Holidays year to year (client, 25 Oct): the next year's three fixed national holidays added from October, once; a December reminder when the festivals are missing | Built (25 Oct) | `holidayYear.service.ts` | `holidayYear.test.ts` |

## Payroll

| § | Requirement | Status | Where | Proved by |
|---|---|---|---|---|
| 38 | Salary → attendance and leave → overtime → incentives → deductions → TDS → approve → lock → payslip | Built | `S/modules/payroll`, `S/domain/payroll` | `payrollRun.test.ts`, `golden.test.ts` (the accountant's sheet); E2E `day18`, `golden` |
| 39 | PF, ESI, PT, TDS, rates editable | Built (4 Oct: ESI tested on ESI wages; a salary first recorded mid-period is tested on that day; pension stops at 58) | `S/domain/payroll/statutory.ts`, `esiCoverage.service.ts` | `statutory.test.ts`, `payroll.test.ts`; E2E `wages-share`, `day18-tds` |
| 40 | Components, bonus (outside ESI and PT), incentive, loans and advances | Built | `components.service.ts`, `loans.service.ts`; migration `20261025150000_bonus_outside_pt` | `v1Extras.test.ts`, `referenceData.test.ts`; E2E `v1gaps2` |
| 41 | Payslip and the employee's access to it | Built (download as PDF; viewed in the PDF) | `S/platform/pdf/payslipPdf.ts`, `W/pages/MyPayslips.jsx` | `payslipLifecycle.test.ts`; E2E `day18`, `golden` |
| 65 | Approve, lock, reopen | Built (no "reject": the preparer recalculates or discards a draft) | `payrollApproval.service.ts` | `payslipLifecycle.test.ts`; E2E `day18` |
| — | Bank transfer file | Built (4 Oct: only somebody above can enter or check a payroll person's own account; the employee is told when anybody else changes it; paying unchecked accounts is the Super Admin's call) | `bankAccount.service.ts`, `bankFile.service.ts` | `bankTransfer.test.ts`; E2E `day18`, `golden` |
| — | Whose payroll (client, 15 Oct): a payroll role limited like any module (a department, a team, …) — salaries, incentives, tax, loans, bank accounts, a run's payslips, payroll reports and the profile's bank tab of those people only (404 outside); a run, Home's card, the bank file and reports show their share, never the company's totals; the same choices as "Whose leave", working the same way — the choice decides whom the role is shown, the ticks what it may do; refusals name only its people, the rest counted; every role migrated with the reach it had; "Whose payslips" every choice too, Payslips → People's payslips listing the paid payslips of the people chosen | Built (15 Oct) | `S/modules/payroll/payrollReach.ts`, `S/platform/authz/catalogue.ts`, migration `20261015120000_payroll_scope` | `payrollScope.test.ts`, `roles.policy.test.ts`; E2E `payrollscope`, `day21` |

## Notifications, reports, audit, dashboards

| § | Requirement | Status | Where | Proved by |
|---|---|---|---|---|
| 45 | In-app and email notices | Built (email sends once SMTP is set) | `S/domain/notifications/events.ts`, `S/platform/email` | `notifications.test.ts`, `outbox.test.ts` |
| 46 | Reports, limited by scope; CSV and print | Built (no designation or expense report) | `S/modules/reports`, `W/pages/Reports.jsx` | `reports.test.ts`; E2E `day19`, `golden` |
| 47 | Audit log with old and new values | Built | `S/domain/audit/catalogue.ts`, Settings → Audit Log | `audit.test.ts`; E2E `day20`, `golden` |
| 57 | A dashboard per role | Built, differs: one home page made of sections, each shown by the login's permissions, so a new role gets the right ones too. Accounts gets payroll (the month's run, bank accounts, next month, incentives, loans); HR the company today, people, joining to exit and documents; managers their team today; everyone with a record their own day, leave and requests; anything waiting for the login's decision on top | `W/pages/Dashboard.jsx`, `W/features/home` | E2E `day20`, `lifecycle`, `v1gaps`, `newlook`, `demo-tour` |

## Open

Decisions for the client, or small items left:

1. Expense and reimbursement (§29, §46, §57): marked "Phase 8 — Future" by the client.
2. Account statuses Suspended / Expired (§4): today an account is active, invited or switched off.
3. Company logo, registration number, industry, company type (§8).
4. Document visibility per document or type (§44), and a retention rule (§64).
5. A payslip "view" page beside the PDF (§41).
6. A designation report (§46).
7. Leave that runs across a resignation's last working day stays with its approver to reject.
8. The pension (EPS) split in the month somebody turns 58 is flagged on the payslip for Accounts to check, not split by days (to build with the PF return file, once the accountant confirms the formula). A PF member with no date of birth is warned about on every payslip, since EPS could not stop at 58; the roster import takes `date_of_birth`.
9. A salary that starts mid-month is paid from the next month. The payslip warning gives the arrears for the days from the change — each new salary for its own days when there are two — on the company's pay-day basis, to enter under the Arrears component (whether Arrears counts for PF is the accountant's call), and says so once it is entered; a lower salary is told as an overpayment to recover. The salary form says the same before saving and offers the 1st of the next month instead.
10. Payroll: the alternate-Saturday weekly-off pattern is not built (it would go in `domain/shared/workWeek.ts`, which every count of a day asks).
10a. Work on a weekly off or holiday (client, 25 Oct 2026, for later): today it is Present and paid as the off day it is; overtime counts only the hours past the shift. Overtime for all of it, or comp off, waits for the client's choice.
11. The accountant has not yet signed off the golden payroll sheet (`golden.test.ts`).
12. Deploy: the Docker packaging, CI (on every pull request, `main` protected), the edge block for `ems.careermapsolutions.in`, the first-deploy runbook, CD (on a release tag, approved by a person) and the client's go-live guide are built (`deploy/DEPLOY.md`, `docs/client/EMS-Go-Live-Guide.pdf`). Running it on the client's box waits for: SSH, the DNS record, R2 keys, the administrator and owner emails, who keeps the backup passphrase; SMTP is optional.
12a. The statutory upload files — the EPFO ECR file and the ESIC monthly contribution file — are not built (in scope since 27 Sep 2026). Today Reports → PF and ESI contributions gives every figure they need, per person, as a CSV. To be built from a sample of the company's own last ECR and ESIC upload, with the accountant's rule for whole NCP days and the 58th-birthday EPS split (item 8).

Small items the reviews found and that are left as they are, each low risk:

13. Passwords are set by HR and the Super Admin, and told to the person by hand. Where the company hands them back to the person, links are handed over by whoever issues them; a "forgot password" email could be built then, since email exists.
14. Sign-in is limited per address and per account from one address, not per account across many addresses.
15. An access token stays valid for up to 15 minutes after signing out.
16. On a fixed 30-day basis, the payslip PDF shows calendar paid days, and a part month counts calendar days.
17. A negative payslip is left out of the bank file but counted in the run's total.
18. A loan closed while a draft is open, then the draft discarded, recovers one instalment less.
19. Approved leave that runs across the last working day stays charged in full; leave cancelled by an accepted resignation is not restored if the resignation is later called off.