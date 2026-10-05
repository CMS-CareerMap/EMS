# Requirements traceability

How each section of the client's requirements document ("CMS HRMS Functional Requirements",
69 sections) maps to the code and to the tests that prove it, for the single-company build
for CareerMap Solutions. Checked on 5 Oct 2026, branch `feat/new-look`.

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
| 4 | Sign in with Employee ID or email + password, no OTP | Built | `S/modules/auth` | `auth.test.ts`; E2E `day20`, `day23`, `demo-tour` |
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
| 63 | Add → ID → department → designation → manager → role → login → active; bulk import | Built (employee code typed, not generated; 4 Oct: the import takes a `shift` column, so imported people's days are measured) | Add Employee, Import Employees | `userManagement.test.ts`, `import.test.ts`; E2E `golden` |
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

## Attendance

| § | Requirement | Status | Where | Proved by |
|---|---|---|---|---|
| 30 | Check-in inside the office radius | Built | `S/domain/attendance/geofence.ts` | `attendance.test.ts`; E2E `golden` (check-in at the office, refused 2 km away) |
| 31, 33 | Location, time, device, work mode | Built (check-out is not geofenced, by design) | `Attendance` model | `attendance.test.ts` |
| 32 | WFH on an approved request | Built | requests `work_from_home` | `requests.test.ts`; E2E `v1gaps` |
| 34 | Shifts with grace, late, early, minimum hours, overtime | Built (4 Oct: night shifts checked out of the next morning; a check-in after midnight counts for last night) | `S/domain/attendance/shiftRules.ts`, `attendance.service.ts` | `shiftRules.test.ts`, `attendance.test.ts` |
| 35 | Overtime: recorded, claimed, approved, paid | Built (off until the company turns it on) | requests `overtime`, `payroll.service.ts` | `v1Extras.test.ts`; E2E `v1gaps` |
| — | Biometric machine import | Built (4 Oct: the screen — the import itself was there since Day 12) | `W/features/attendance/ImportAttendanceModal.jsx` | `attendanceAdmin.test.ts`; E2E `golden` |
| — | Hours worked, daily and for the month | Built (4 Oct: the month's hours per person on Attendance → Monthly, with a month picker for HR and managers too, and on the dashboard) | `W/pages/Attendance.jsx` | `attendanceAdmin.test.ts` "monthly hours"; E2E `golden` |
| — | A half day of leave, the other half worked | Built (4 Oct: the worked half is graded as a half) | `forWorkedHalf` | `attendance.test.ts`, `attendanceAdmin.test.ts` |

## Payroll

| § | Requirement | Status | Where | Proved by |
|---|---|---|---|---|
| 38 | Salary → attendance and leave → overtime → incentives → deductions → TDS → approve → lock → payslip | Built | `S/modules/payroll`, `S/domain/payroll` | `payrollRun.test.ts`, `golden.test.ts` (the accountant's sheet); E2E `day18`, `golden` |
| 39 | PF, ESI, PT, TDS, rates editable | Built (4 Oct: ESI tested on ESI wages; a salary first recorded mid-period is tested on that day; pension stops at 58) | `S/domain/payroll/statutory.ts`, `esiCoverage.service.ts` | `statutory.test.ts`, `payroll.test.ts`; E2E `wages-share`, `day18-tds` |
| 40 | Components, bonus, incentive, loans and advances | Built | `components.service.ts`, `loans.service.ts` | `v1Extras.test.ts`; E2E `v1gaps2` |
| 41 | Payslip and the employee's access to it | Built (download as PDF; viewed in the PDF) | `S/platform/pdf/payslipPdf.ts`, `W/pages/MyPayslips.jsx` | `payslipLifecycle.test.ts`; E2E `day18`, `golden` |
| 65 | Approve, lock, reopen | Built (no "reject": the preparer recalculates or discards a draft) | `payrollApproval.service.ts` | `payslipLifecycle.test.ts`; E2E `day18` |
| — | Bank transfer file | Built (4 Oct: only somebody above can enter or check a payroll person's own account; the employee is told when anybody else changes it; paying unchecked accounts is the Super Admin's call) | `bankAccount.service.ts`, `bankFile.service.ts` | `bankTransfer.test.ts`; E2E `day18`, `golden` |

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
10. Payroll: the alternate-Saturday weekly-off pattern is not built.
11. The accountant has not yet signed off the golden payroll sheet (`golden.test.ts`).
12. Deploy (Docker, CI/CD, domain, R2, SMTP, backup passphrase) is still to do.
12a. The statutory upload files — the EPFO ECR file and the ESIC monthly contribution file — are not built (in scope since 27 Sep 2026). Today Reports → PF and ESI contributions gives every figure they need, per person, as a CSV. To be built from a sample of the company's own last ECR and ESIC upload, with the accountant's rule for whole NCP days and the 58th-birthday EPS split (item 8).

Small items the reviews found and that are left as they are, each low risk:

13. Password links are handed over by whoever issues them; self-service "forgot password" by email can now be built, since email exists.
14. Sign-in is limited per address and per account from one address, not per account across many addresses.
15. An access token stays valid for up to 15 minutes after signing out.
16. On a fixed 30-day basis, the payslip PDF shows calendar paid days, and a part month counts calendar days.
17. A negative payslip is left out of the bank file but counted in the run's total.
18. A loan closed while a draft is open, then the draft discarded, recovers one instalment less.
19. Approved leave that runs across the last working day stays charged in full; leave cancelled by an accepted resignation is not restored if the resignation is later called off.