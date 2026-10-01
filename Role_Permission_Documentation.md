# Role & Permission Documentation

**EMS — CareerMap Solutions** | Version 1.3 | 1 October 2026

> **Since Day 21 these are the roles every company STARTS with.** Roles are now the company's own rows, and the Super Admin can change any of them on **Settings → Roles & Permissions**. There the Super Admin can create new roles, tick what each role may do, choose whose information it reaches (only their own, their team, their department, or the whole company), and set which role it comes under. The matrix below is what a new company is given, and what "Reset to default" puts back. `authz.test.ts` checks it against `server/src/platform/authz/defaultRoles.ts`, and `roles.test.ts` checks that file against what a new company actually receives.
>
> Fixed, whatever the Super Admin chooses:
> - The Super Admin role cannot be edited or deleted.
> - Managing roles (`role:manage`) cannot be given to another role.
> - Nobody edits a role they hold themselves.
> - A role somebody holds, a role other roles come under, and the seven built-in roles cannot be deleted.
> - A person may give only a role below their own, holding nothing they cannot do themselves. The same applies to changing, switching off or resetting the password of somebody else's login.
> - Managing logins (invite, switch on/off, remove, change role) works within the role's "Whose records" reach under Employees. A role reaching one department sees and manages only that department's logins.
> - Nobody moves themselves to another manager or department, and nobody moves a person into their own team or department when that would show them more (salaries, for example). Somebody above makes such a move.
> - Inviting somebody (Settings → Users) and importing a roster (CSV) need a company-wide "Whose records" reach: both add people outside any team or department. A narrower role adds people under Employees, with itself as their reporting manager, and gives the login there.
> - A roster with an email column gives each person an Employee login, so only a role that may give the Employee role can import it. The preview says so before anything is saved.
> - A role without "Open the dashboard" signs in to the first area it can open.
> - The screen warns, and asks once more, before saving a role that both prepares and approves the payroll, or one that can read the audit log (which shows the whole company, salary changes included).
>
> The full rewrite for the client's hierarchy model (Days 22–23) follows `docs/client/EMS-Roles-and-Approvals.pdf`.

---

## 1. Introduction

This document defines who can access what in the Employee Management System (EMS). It covers all 7 user roles, their permissions, and how security is enforced.

**Why RBAC?** Instead of configuring permissions per user, we assign a role. The role determines what pages, data, and actions a user can access — consistently, securely, and at scale.

---

## 2. Roles at a Glance

| Role | Key | Who Is This? |
|------|-----|--------------|
| **Super Admin** | `super_admin` | System owner — full access |
| **Admin** | `admin` | Department admin — employees & docs |
| **HR** | `hr` | People ops — employees, attendance, leave, docs |
| **Manager** | `manager` | Team lead — approve leave for direct reports |
| **Reporting Manager** | `rm` | Same as Manager (different org title) |
| **Accounts** | `accounts` | Finance — salary & payroll only |
| **Employee** | `employee` | Self-service — own data only |

> **Accounts and passwords:** there is no shared or default password. The first Super Admin is created on the server with `npm run bootstrap`. Everybody else is invited from **Settings → Users & Roles**, or added as an employee, and sets their own password from a single-use link that expires after 72 hours. The six demo logins this table used to list belonged to the old prototype, all on one password published here; they do not exist in this system.

---

## 3. Permission Matrix

### 3.1 Module Access

| Module | Super Admin | Admin | HR | Manager | RM | Accounts | Employee |
|--------|:-----------:|:-----:|:--:|:-------:|:--:|:--------:|:--------:|
| Dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ Personal |
| Employees | ✅ | ✅ | ✅ | 👁 View | 👁 View | ❌ | ❌ |
| Attendance | ✅ | ❌ | ✅ | 🟡 Team | 🟡 Team | ❌ | 🟡 Own |
| Leave | ✅ | ❌ | ✅ | 🟡 Team | 🟡 Team | ❌ | 🟡 Own |
| Payroll | ✅ | ❌ | 🟡 Incentives | ❌ | ❌ | ✅ | ❌ |
| My Payslips | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Documents — employee files | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | 🟡 Own |
| Documents — company documents | ✅ | ✅ | ✅ | 👁 View | 👁 View | 👁 View | 👁 View |
| Reports | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Settings | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Notifications (the bell) | ✅ Own | ✅ Own | ✅ Own | ✅ Own | ✅ Own | ✅ Own | ✅ Own |

✅ Full  |  🟡 Limited  |  👁 View-only  |  ❌ No Access

> **Company documents** are the company's own papers — policies, the handbook, templates, announcements. Everybody reads them (§5 has always said "All"); only Super Admin, Admin and HR publish or withdraw them. Nobody's personal files are in there.
>
> **Settings, in part:** Admin and HR open Settings for the tabs they run and nothing else — leave types (Admin, HR), holidays (HR) and the document checklist (Admin, HR). Company details, users, payroll configuration, the upload size limit and the notification switches stay Super Admin's.

### 3.2 Action Permissions

| Action | Super Admin | Admin | HR | Manager/RM | Accounts | Employee |
|--------|:-----------:|:-----:|:--:|:----------:|:--------:|:--------:|
| Create employee | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Edit employee | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Delete employee | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Mark attendance | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Edit/delete attendance | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Apply for leave | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| Approve/reject leave | ✅ | ❌ | ✅ | 🟡 Team | ❌ | ❌ |
| Grant the leave year / correct a balance | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Manage salary structures | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Run payroll | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Approve / reopen payroll | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Mark payroll paid | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Enter monthly incentives | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ |
| Record / verify bank accounts | ✅ | ❌ | ❌ | ❌ | ✅ (not own) | ❌ |
| Download bank transfer file | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Download own payslips | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Send in own bank account (with cheque/passbook proof) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Upload documents | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ Own |
| Verify/reject documents | ✅ (not own) | ✅ (not own) | ✅ (not own) | ❌ | ❌ | ❌ |
| Read company documents | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Publish/withdraw company documents | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Edit the document checklist | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| View reports | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Read the audit log (and export it) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Manage roles and permissions (Day 21; cannot be given to another role) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Read own notifications | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Turn notification events on/off | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Invite users | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Manage roles/status | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Delete users | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Change settings | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 4. Role Details

### 4.1 Super Admin

**Purpose:** Full system control — configuration, oversight, and user management.

| Area | What They Can Do |
|------|------------------|
| **Employees** | Create, view, edit, delete any profile |
| **Attendance** | View all, mark/edit/delete for anyone |
| **Leave** | Apply own, approve/reject anyone's requests |
| **Payroll** | Create salary structures, run payroll, generate payslips |
| **Documents** | Upload for anyone; verify or reject anybody's but their own; publish and withdraw company documents; edit the document checklist |
| **Reports** | All 8 reports — attendance summary, attendance by department, leave taken, leave balances, payroll summary, PF & ESI, headcount, joiners & exits — for any month, with Print / PDF and a CSV download. Every download is recorded |
| **Settings** | Invite users, change roles, toggle status, delete users, edit company info; the upload size limit (1–10 MB, 2 MB to start); which notifications are sent |

**Unique to this role:** Only role with access to Reports, company Settings, and user management.
**Restriction:** Cannot change their own role or status, or delete their own account (self-protection).

---

### 4.2 Admin

**Purpose:** Employee and document management without operational or financial access.

| Area | What They Can Do |
|------|------------------|
| **Employees** | Create, view, edit profiles |
| **Documents** | Upload, verify, reject employee documents — never their own; publish and withdraw company documents; edit the document checklist (Settings → Documents) |
| **Leave types** | Add and edit the company's leave types (Settings → Leave) |

**No access to:** Attendance, Leave records, Payroll, Reports, and the rest of Settings.

---

### 4.3 HR

**Purpose:** People operations — the most feature-rich non-admin role.

| Area | What They Can Do |
|------|------------------|
| **Employees** | Create, view, edit profiles |
| **Attendance** | View all, mark/edit/delete for anyone |
| **Leave** | View all, approve/reject any request, manage balances |
| **Documents** | Upload, verify, reject employee documents — never their own; publish and withdraw company documents; edit the document checklist (Settings → Documents) |
| **Leave setup** | Leave types and the holiday calendar (Settings → Leave) |
| **Incentive** | Enter each employee's monthly incentive amount (as Accounts can), under Payroll → Incentives. Nothing else of payroll — no salaries, runs, other people's payslips or bank details |

**No access to:** Payroll (beyond entering incentives), Reports, and the rest of Settings. Cannot delete employees.

---

### 4.4 Manager & Reporting Manager

**Purpose:** Team oversight — approve leave and monitor attendance for direct reports.

| Area | What They Can Do |
|------|------------------|
| **Employees** | View all (read-only) |
| **Attendance** | View own + direct reports |
| **Leave** | Apply own, approve/reject direct reports' requests |
| **Company documents** | Read and download the company's policies, handbook and templates |

**Data scope:** Only sees attendance/leave for employees whose `reporting_manager_id` points to them.
**No access to:** Payroll, employee documents (their own included — see the note in §11), Reports, Settings. Cannot edit profiles or mark attendance.

---

### 4.5 Accounts

**Purpose:** Finance and payroll — completely isolated from people operations.

| Area | What They Can Do |
|------|------------------|
| **Payroll** | Create/edit salary structures; create a month's payroll run as a draft, recalculate or discard it; mark an approved run paid. Approving is Super Admin's |
| **Payroll inputs** | Enter monthly incentive amounts; and, only if the company deducts TDS through payroll (Settings → Payroll Config, off by default), each employee's monthly TDS amount (₹0 needs a reason) |
| **Bank accounts** | Record each employee's salary bank account from a cancelled cheque or passbook page (the photo or PDF can be attached), and verify or reject it (a rejection needs a reason). Accounts an employee sends in themselves arrive as pending with their proof attached, marked "Sent in by them". Never their own — somebody else in Accounts, or the Super Admin, checks that |
| **Bank transfer file** | Download the month's bank file (CSV) from an approved or paid run, and set its layout once to match the bank's bulk-payment format |

**No access to:** Employees page, Attendance, Leave, employee documents, Reports, Settings.
**Can view:** Employee financial data (PAN, bank details) within payroll screens, and the company's documents.

---

### 4.6 Employee

**Purpose:** Self-service — view own data and apply for leave.

| Area | What They Can Do |
|------|------------------|
| **Dashboard** | Personal stats (attendance summary, leave balances) |
| **Attendance** | View own records only |
| **Leave** | Apply for leave, view own requests, view holidays |
| **Documents** | Upload their documents against the company's checklist; see each one's status — pending, verified, or rejected with the reason; replace one; remove their own upload while it is still pending. Read the company's documents |
| **Payslips** | View and download own payslips (My Payslips), once the month is paid |
| **Bank account** | See where their salary is paid (last four digits and status) in their profile, and send in a new or changed account there with a photo or PDF of a cancelled cheque or passbook page. It is pending — and not paid into — until Accounts checks it |
| **Notifications** | Their own: a leave request decided, a payslip ready, a document checked, a bank account checked, their password changed |

**Cannot:** View other employees' data, approve anything, access payroll/reports/settings.
**Can delete:** Only own pending leave requests.

---

## 5. Data Visibility

The API server decides this on every request, so it holds even if the frontend is bypassed: the permission decides whether a request runs at all, and the data scope decides whose rows it can reach. A row outside the caller's scope answers "not found", not "forbidden", so ids cannot be probed one by one.

| Records | Super Admin | Admin | HR | Manager/RM | Accounts | Employee |
|---------|:-----------:|:-----:|:--:|:----------:|:--------:|:--------:|
| Employee directory (no salary, bank or tax ids) | All | All | All | All | ❌ | ❌ |
| Salary and bank details | All | ❌ | ❌ | ❌ | All | Own |
| PAN, UAN, PF and ESIC numbers | All | ❌ | All | ❌ | On payslips | Own payslips |
| Attendance | All | ❌ | All | Own + reports | ❌ | Own |
| Leave requests and balances | All | ❌ | All | Own + reports | ❌ | Own |
| Salary structures, payroll runs | All | ❌ | ❌ | ❌ | All | ❌ |
| Payslips | All | Own | Own | Own | All | Own |
| Company documents | All | All | All | All | All | All |
| Employee documents | All | All | All | ❌ | ❌ | Own |
| Holidays | All | All | All | All | All | All |
| Notifications | Own | Own | Own | Own | Own | Own |
| Reports | All | ❌ | ❌ | ❌ | ❌ | ❌ |

A notification is only ever written by the server, as part of the change it reports — the browser has no way to create one, or to send one to somebody else.

---

## 6. Role Hierarchy

```
Super Admin ─── Full control
  ├── Admin ─── Employees + Documents
  ├── HR ─── Employees + Attendance + Leave + Documents
  ├── Accounts ─── Payroll only
  └── Manager / RM ─── Team leave & attendance
        └── Employee ─── Self-service only
```

> [!NOTE]
> This is a **flat RBAC model** — roles do NOT inherit permissions from higher roles. Each role is independently defined.

---

## 7. Key Workflows

### Leave Request

```
Employee applies → Manager/RM/HR reviews → Approve or Reject
                                              ↓
                  approval takes the days from the leave balance
```

- The days are counted as working days (weekly offs and public holidays are not counted), and the balance shown is after anything already applied for.
- **Withdraw:** a person can withdraw their own request while it is still pending. It shows as *Cancelled*, and the approvers are told.
- **Reverse:** once approved, leave can only be reversed by an approver, **never by the person it belongs to**, whatever their role. Reversing puts the days back in the balance and takes the leave days off the attendance. A month whose payroll is already approved cannot be changed.
- Nobody approves, rejects or reverses their own leave. On their own request an approver sees only Withdraw.
- **Granting the year:** HR or the Super Admin grants each leave year under Leave → Team Balances. Until they do, balances are zero and nobody can apply.
  - Joiners get the months that are left, to the nearest half day. Anybody who has already left gets nothing.
  - Unused days carry into the new year up to each type's cap, once the old year has ended; the same days leave the old year.
  - Nothing is granted twice, so pressing Grant again reaches only the people added since.
- **Correcting a balance:** HR or the Super Admin can add or take away whole or half days, with a reason the employee is shown. Days already applied for cannot be taken away, and nobody corrects their own balance.
- **Seeing balances:** HR and the Super Admin see everybody's. A manager or RM sees their own team's, without grant or correct.

### Document Verification

```
Employee uploads a file against the checklist → HR/Admin is notified
  → opens it in the app → Verify, or Reject with a reason → the employee is notified
```

- Nobody verifies their own document, whichever role they hold. An upload by HR or Admin for somebody else can be marked verified at once.
- A new upload replaces the current one; the earlier ones stay listed, so what was rejected and why is not lost. Taking back a new upload — a second copy sent by mistake — makes the one it replaced current again.
- Files are checked on the server by their contents, not their name: PDF, JPG, PNG or WebP only, up to the company's limit (2 MB to start, Settings → Documents). A photo taken on a phone is shrunk in the browser before it is sent.
- Files are never reachable by a link. Each one is opened through the app after a permission check, and every download is recorded.
- Every file is checked against the fingerprint taken when it was stored. A file that has gone missing or been altered is refused with a plain message, and the attempt to open it is recorded for the administrator.
- The checklist — which documents each employee owes, and which are required — is the company's own (Settings → Documents). HR sees who is missing what under Documents → Employees.

### Audit log

- **What it records:** every sign-in, refused sign-in and sign-out; every request the system turned down; every change to a user's role or status; every salary change; each step of a payroll (calculated, approved, reopened, paid); every document or proof opened; and every file that leaves the system (reports, the employee list, attendance, payslips, the bank file, the audit log itself).
- **Where to read it:** Settings → Audit Log. In a new company that is the **Super Admin only**; the Super Admin can give `audit:read` to another role, after a warning that the log shows the whole company. It can be filtered by dates on the company's clock, by area, by who did it, or by whom it was about (people who have left included). It can be exported as a CSV, and the export is itself recorded.
- **What it shows:** each entry says in words what happened, with the names of the people involved. It also shows the role the person held **at the time**. An entry from before roles were recorded is marked "(now)".
- **What nobody can do:** change or delete an entry. There is no way to do either, anywhere in the system.
- **Backups:** the nightly backup and the monthly restore drill write their outcome here too, under *System jobs*. A failure shows up where Super Admin looks.

### Notifications

- The bell shows each person their own notices and checks for new ones every minute.
- A notice goes to whoever holds the matching right — for example, a leave request goes to the people who may approve it (HR, Super Admin and the employee's own manager), and a document sent in goes to whoever verifies documents. Nobody is sent a notice about their own action, and nobody is asked to approve their own leave — even when HR filed it for them. When HR files or withdraws a request for somebody, the notice says who did, and the person it was for is told of a withdrawal.
- The password notice goes out however the password changed: by the person while signed in, or through a reset link from the administrator.
- Super Admin turns each kind on or off under Settings → Notifications. The notice that a password was changed is always sent.
- Notices older than 180 days are cleared by the regular maintenance job.

### Reports

- Super Admin picks a report and a month (the last two years are offered); some reports also take a department or an employee.
- Every figure is counted by the server from the records. Nothing is estimated: somebody with no leave balance recorded shows none, not a made-up allowance, and a person who has left shows their real last working day.
- People who have left are counted for the months they worked, including those whose access was removed. Somebody let go with no last working day recorded is shown leaving on the day their access was removed, and says so. Somebody marked inactive with no last working day at all is left out, with a note — as payroll leaves them out.
- A past month is counted by the rules it had (its weekly offs), not today's. Payroll reports follow the department printed on each payslip.
- Print / PDF prints the report as shown. The CSV is made on the server from the same rows and totals, and opens correctly in Excel.

### Payroll

```
Accounts creates salary structure → Creates payroll run (draft)
  → Auto-generates payslips → Super Admin approves → Accounts marks paid
```

- **Approve** is Super Admin's (`payroll:run:approve`), so one person does not both prepare and sign. Before approving, the system recalculates the month and refuses if any payslip would come out differently. Days counted as paid with no attendance must be confirmed.
- **Reopen** (approved → draft) is also Super Admin's, until the payslip lock day of the following month.
- **Mark paid** is Accounts'. It stores every payslip as a PDF with a SHA-256 hash. A paid payroll cannot be changed.
- Once a month is approved, its attendance, leave decisions, holidays, salaries, PT tables, ESI decisions, TDS and incentives can no longer be changed.
- Everybody sees their own payslips (paid months only). Accounts and Super Admin see everyone's.

### Bank accounts and the bank transfer file

```
Accounts records the account from a cancelled cheque → ticks "checked" (verified)
  → payroll approved → Accounts downloads the bank file → uploads it to the bank → marks the run paid
```

- Nobody verifies their own bank account (`employee:bank:manage`, held by Accounts and Super Admin). Changing an account's number or IFSC makes it unverified again.
- An employee can send in their own account from their profile. A new account, or a changed number or IFSC, needs a photo or PDF of a cancelled cheque or passbook page. It arrives as pending, Accounts is notified, opens the proof in the app, and verifies or rejects it — and the employee is told which.
- A decision holds only for the account that was checked. If new details arrive while Accounts has the old ones open, the verify (or a save from that stale form) is refused and the new details have to be looked at first.
- The bank file is made only from an approved or paid run, and pays exactly each payslip's net pay.
- It includes verified accounts only (a setting in Payroll → Bank file format, on by default). A rejected account is never paid. Everybody left out is listed with the reason before the file is downloaded.
- Every download of the file is recorded, with who took it and when. The screens show only the last four digits of an account number; the file has them in full.

### Employee Onboarding

```
HR/Super Admin fills the form → the server creates the employee and their leave balances
  → an invitation link lets them set their own password
```

### User Invitation (Super Admin only)

```
Settings → Invite → the server checks the caller holds user:invite
  → sends a single-use link (valid 72 hours) → status is "invited" until a password is set
```

---

## 8. Security Model

### Three Layers of Enforcement

| Layer | What It Does | Bypass-proof? |
|-------|-------------|:-------------:|
| **Frontend page guards** | A page and its sidebar link are shown only for the permission that opens it | No (client-side) |
| **API permission check** | Every route signs the caller in and checks the permission it needs before anything runs | ✅ |
| **Data scope** | Every read and write is narrowed to the caller's company and to whose rows they may reach (§5) | ✅ |

### Key Security Details

| Area | Implementation |
|------|----------------|
| Authentication | The company's own API server (email or employee ID, and password) |
| Token expiry | Access token 15 minutes; a refresh token of 7 days, rotated on each use, and a reused one ends the session |
| Password hashing | bcrypt, cost 12 |
| Self-protection | Nobody changes their own role or status, deletes their own account, or verifies their own document or bank account |
| Role validation | One list of permissions per role (`server/src/platform/authz/roles.ts`), checked against this document by an automated test |
| Files | Checked by content on upload, kept in private storage, opened only through the app, each download recorded |
| Audit log | Append-only; read with `audit:read` (Super Admin by default; can be given to a role, with a warning); every entry says who, as what role, from which device and address |
| Browser | Content-Security-Policy, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy and Permissions-Policy on the app; helmet's headers on the API |
| Sign-in limits | 10 tries per account and 100 per address per 15 minutes on sign-in and password links. Refreshing a session has its own, much higher limit, so an office on one address is never locked out by it. |
| Backups | Nightly, sealed (AES-256-GCM), stored off the server; restored and checked every month (`deploy/DEPLOY.md`) |

---

## 9. Developer Quick Reference

| Role | Sidebar Items | Data scope |
|------|---------------|-----------|
| `super_admin` | Everything | The whole company |
| `admin` | Dashboard, Employees, My Payslips, Documents, Settings (leave types, document checklist) | People and documents; no attendance, leave or payroll |
| `hr` | Dashboard, Employees, Attendance, Leave, Payroll (Incentives), My Payslips, Documents, Settings (leave, holidays, document checklist) | All people records; own payslips |
| `manager` / `rm` | Dashboard, Employees, Attendance, Leave, My Payslips, Documents (company) | Own + direct reports for attendance and leave |
| `accounts` | Dashboard, Payroll, My Payslips, Documents (company) | All payroll records |
| `employee` | Dashboard, Attendance, Leave, My Payslips, Documents | Their own rows only |

The sidebar and the page guards read one list (`web/src/config/navigation.js`) of which permission opens each page, so nothing in the browser names a role.

**When adding a new role:**
1. Add it to the `Role` enum in the Prisma schema, with a migration
2. Give it its permission list in `server/src/platform/authz/roles.ts` and its data scope in `scope.ts`
3. Add it to `authz.test.ts` and to this document, so the two cannot drift apart
4. Add its label in Settings → Users & Roles

---

## 10. Testing Checklist

### Login

- [ ] Each role can log in with email or Employee ID
- [ ] Invalid credentials show error
- [ ] Logout clears session

### Permissions (test per role)

- [ ] Sidebar shows only permitted modules
- [ ] Direct URL to restricted page → redirects to `/dashboard`
- [ ] CRUD operations work on permitted modules
- [ ] CRUD operations blocked on restricted modules (the API answers 403)

### Negative Tests

- [ ] Employee cannot see approve/reject buttons
- [ ] Manager accessing `/payroll` → redirected
- [ ] Accounts calling the attendance API → 403
- [ ] Non-super_admin calling invite → 403
- [ ] Super Admin changing their own role or status → refused
- [ ] HR verifying their own document → refused
- [ ] An employee opening another employee's document by id → not found

### Security

- [ ] Unauthenticated access → redirected to `/signin`
- [ ] Expired JWT → triggers re-authentication
- [ ] Every API route checks a permission
- [ ] Passwords stored as bcrypt hashes
- [ ] An uploaded file that is not really a PDF or image is refused, whatever its name
- [ ] Only Super Admin sees Settings → Audit Log; the API answers 403 to everybody else
- [ ] Nobody can reverse their own approved leave
- [ ] A page that fails to load says so, with a reference and Try again — never an empty list

---

## 11. Future Enhancements

| Enhancement | Description |
|-------------|-------------|
| **Custom roles** | Dynamic role creation via a `roles` table instead of CHECK constraint |
| **Temporary permissions** | Time-bound elevated access (e.g., acting manager for 2 weeks) |
| **Department-scoped HR** | HR restricted to specific departments |
| **Multi-level approvals** | Leave: RM → HR → Auto-approved chain |
| **2FA** | TOTP-based two-factor for Super Admin & Accounts |
| **Time-based access** | Restrict payroll module to business hours only |

> **Open question for the client:** §3.1 gives Manager, RM and Accounts no access to employee documents, so they cannot upload or see even their own. That is how it is built, as written. If they should manage their own like everybody else, it is a one-line change per role.

---

*CareerMap Solutions Pvt. Ltd. — Internal Use Only*
