# Role & Permission Documentation

**EMS — CareerMap Solutions** | Version 1.0 | 11 July 2026

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
| Payroll | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Documents | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | 🟡 Own |
| Reports | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Settings | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

✅ Full  |  🟡 Limited  |  👁 View-only  |  ❌ No Access

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
| Manage salary structures | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Run payroll | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Upload documents | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ Own |
| Verify/reject documents | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| View reports | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
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
| **Documents** | Upload for anyone, verify/reject |
| **Reports** | Generate all 7 report types |
| **Settings** | Invite users, change roles, toggle status, delete users, edit company info |

**Unique to this role:** Only role with access to Reports, Settings, and user management.
**Restriction:** Cannot modify own account via the manage-user function (self-protection).

---

### 4.2 Admin

**Purpose:** Employee and document management without operational or financial access.

| Area | What They Can Do |
|------|------------------|
| **Employees** | Create, view, edit profiles |
| **Documents** | Upload, verify, reject employee documents |

**No access to:** Attendance, Leave, Payroll, Reports, Settings.

---

### 4.3 HR

**Purpose:** People operations — the most feature-rich non-admin role.

| Area | What They Can Do |
|------|------------------|
| **Employees** | Create, view, edit profiles |
| **Attendance** | View all, mark/edit/delete for anyone |
| **Leave** | View all, approve/reject any request, manage balances |
| **Documents** | Upload, verify, reject employee documents |
| **Incentive** | Enter each employee's monthly incentive amount (as Accounts can). Nothing else of payroll — no salaries, runs or payslips |

**No access to:** Payroll (beyond entering incentives), Reports, Settings. Cannot delete employees.

---

### 4.4 Manager & Reporting Manager

**Purpose:** Team oversight — approve leave and monitor attendance for direct reports.

| Area | What They Can Do |
|------|------------------|
| **Employees** | View all (read-only) |
| **Attendance** | View own + direct reports |
| **Leave** | Apply own, approve/reject direct reports' requests |

**Data scope:** Only sees attendance/leave for employees whose `reporting_manager_id` points to them.
**No access to:** Payroll, Documents, Reports, Settings. Cannot edit profiles or mark attendance.

---

### 4.5 Accounts

**Purpose:** Finance and payroll — completely isolated from people operations.

| Area | What They Can Do |
|------|------------------|
| **Payroll** | Create/edit salary structures, create payroll runs, generate payslips, change run status (draft → approved → paid) |
| **Payroll inputs** | Enter each employee's monthly TDS amount (₹0 needs a reason) and monthly incentive amounts |

**No access to:** Employees page, Attendance, Leave, Documents, Reports, Settings.
**Can view:** Employee financial data (PAN, bank details) within payslip context.

---

### 4.6 Employee

**Purpose:** Self-service — view own data and apply for leave.

| Area | What They Can Do |
|------|------------------|
| **Dashboard** | Personal stats (attendance summary, leave balances) |
| **Attendance** | View own records only |
| **Leave** | Apply for leave, view own requests, view holidays |
| **Documents** | Upload own documents, view verification status |

**Cannot:** View other employees' data, approve anything, access payroll/reports/settings.
**Can delete:** Only own pending leave requests.

---

## 5. Data Visibility (RLS)

The database enforces row-level security even if the frontend is bypassed.

| Table | Super Admin | Admin | HR | Manager/RM | Accounts | Employee |
|-------|:-----------:|:-----:|:--:|:----------:|:--------:|:--------:|
| profiles | All | All | All | All | All | All |
| attendance | All | ❌ | All | Own + reports | ❌ | Own |
| leave_requests | All | ❌ | All | Own + reports | ❌ | Own |
| leave_balances | All | ❌ | All | Own | ❌ | Own |
| salary_structures | All | ❌ | ❌ | ❌ | All | Own |
| payroll_runs | All | ❌ | ❌ | ❌ | All | ❌ |
| payslips | All | ❌ | ❌ | ❌ | All | Own |
| documents | All | All | All | All | All | All |
| employee_documents | All | All | All | ❌ | ❌ | Own |
| holidays | All | All | All | All | All | All |
| notifications | All | Own | Own | Own | Own | Own |

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
                              DB trigger auto-deducts leave balance
```

### Document Verification

```
Employee uploads file → HR/Admin reviews → Verify or Reject (with remarks)
```

### Payroll

```
Accounts creates salary structure → Creates payroll run (draft)
  → Auto-generates payslips → Updates status: draft → approved → paid
```

### Employee Onboarding

```
HR/Super Admin fills form → RPC creates auth user + profile + leave balances
```

### User Invitation (Super Admin only)

```
Settings → Invite → Edge function validates caller is super_admin
  → Sends email invite → Creates profile with status = 'invited'
```

---

## 8. Security Model

### Three Layers of Enforcement

| Layer | What It Does | Bypass-proof? |
|-------|-------------|:-------------:|
| **Frontend Route Guards** | `ProtectedRoute` blocks page navigation by role | No (client-side) |
| **Edge Function Auth** | JWT verification + role check for user management | ✅ |
| **Database RLS Policies** | Row-level security on all 11 tables | ✅ |

### Key Security Details

| Area | Implementation |
|------|----------------|
| Authentication | Supabase Auth (email/password), JWT tokens |
| Token expiry | 1 hour, with refresh token rotation |
| Password hashing | bcrypt via pgcrypto |
| Self-protection | Super Admin cannot modify own account via edge function |
| Role validation | `has_role()` and `has_any_role()` SQL functions (SECURITY DEFINER) |

---

## 9. Developer Quick Reference

| Role | Sidebar Items | Route Guard | RLS Scope |
|------|---------------|-------------|-----------|
| `super_admin` | All 8 modules | No restrictions | All rows, all tables |
| `admin` | Dashboard, Employees, Documents | Blocked: Payroll, Reports, Settings | No attendance/leave/payroll data |
| `hr` | Dashboard, Employees, Attendance, Leave, Documents | Blocked: Payroll, Reports, Settings | All rows in people tables |
| `manager` / `rm` | Dashboard, Employees, Attendance, Leave | Blocked: Payroll, Documents, Reports, Settings | Own + `reporting_manager_id = auth.uid()` |
| `accounts` | Dashboard, Payroll | Blocked: Employees, Attendance, Leave, Docs, Reports, Settings | All payroll tables only |
| `employee` | Dashboard, Attendance, Leave, Documents | Blocked: Employees, Payroll, Reports, Settings | `employee_id = auth.uid()` only |

**When adding a new role:**
1. Add to `profiles.role` CHECK constraint (schema.sql + migration)
2. Add RLS policies for the role on relevant tables
3. Add to `NAV` array in `Sidebar.jsx`
4. Add to `ProtectedRoute` wrappers in `App.jsx`
5. Add to `ROLE_LABELS` mapping

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
- [ ] CRUD operations blocked on restricted modules (RLS error)

### Negative Tests

- [ ] Employee cannot see approve/reject buttons
- [ ] Manager accessing `/payroll` → redirected
- [ ] Accounts querying attendance API → empty result (RLS)
- [ ] Non-super_admin calling invite-user → 403
- [ ] Super Admin modifying own account → "Cannot modify your own account"

### Security

- [ ] Unauthenticated access → redirected to `/signin`
- [ ] Expired JWT → triggers re-authentication
- [ ] RLS enabled on all 11 tables
- [ ] Passwords stored as bcrypt hashes

---

## 11. Future Enhancements

| Enhancement | Description |
|-------------|-------------|
| **Custom roles** | Dynamic role creation via a `roles` table instead of CHECK constraint |
| **Temporary permissions** | Time-bound elevated access (e.g., acting manager for 2 weeks) |
| **Department-scoped HR** | HR restricted to specific departments |
| **Multi-level approvals** | Leave: RM → HR → Auto-approved chain |
| **Audit dashboard** | Log all login, CRUD, and role-change events |
| **2FA** | TOTP-based two-factor for Super Admin & Accounts |
| **Time-based access** | Restrict payroll module to business hours only |

---

*CareerMap Solutions Pvt. Ltd. — Internal Use Only*
