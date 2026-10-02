# Role & Permission Documentation

**EMS — CareerMap Solutions** | Version 2.0 | 2 October 2026

This document says who can do what in EMS, and how the system enforces it. It describes the model built on Days 21–23:

- **Roles are the company's own.** The Super Admin creates, edits and orders them on **Settings → Roles & Permissions**. A new company starts with seven, listed in §3.
- **Approvals follow the company tree**, not a role. The person somebody reports to decides their leave (§5).
- **Your own work goes up the tree.** Nobody checks, corrects or enters their own items in their role's area, and neither do their peers or juniors (§6).
- **Two logins, one person.** Somebody with a role has an employee login and a role login, each with its own email. Both are the same person, so every rule above holds from both (§7).

The client's own description of the same model, in plain words, is `docs/client/EMS-Roles-and-Approvals.pdf`.

---

## 1. How access is decided

Every request is decided on the server, in this order:

1. **Who is signed in.** A login (a `Membership`) belongs to one company, holds one role, and is linked to a person (an `Employee`), or to nobody for an operator such as the first administrator.
2. **What the role may do.** Each role has a list of **permissions** (`server/src/platform/authz/permissions.ts`). A route asks for one with `authorize('…')`. Code never compares a role's name; the §A5 lint refuses it.
3. **Whose information it reaches.** Each role has a **scope per module**: employee records, salaries, attendance, leave, payslips and documents. The scope narrows every read and write (`platform/authz/scopeWhere.ts`, used by every module). A row outside it answers "not found", never "forbidden", so ids cannot be probed.
4. **The company tree and the person.** Leave decisions and "your own work goes up" are decided from the person's place in the tree. They do not depend on the role (§5, §6).

The role row is read again on every request, so a change on the Roles screen applies to the holder's very next click.

---

## 2. The scopes

| Scope | On screen | Reaches |
|-------|-----------|---------|
| `SELF` | Only their own | Their own rows |
| `DIRECT_REPORTS` | Their team | The people directly under them, and themselves |
| `ALL_REPORTS` | Everybody under them | Everybody below them in the tree, at every level, and themselves |
| `DEPARTMENT` | Their department | Everybody in their department |
| `ORGANIZATION_EXCEPT_ABOVE` | Whole company, except seniors | Everybody except the people above them in the tree. The owner and every Super Admin always count as "above" |
| `ORGANIZATION` | Whole company | Everybody |

The two tree scopes need the caller's place in the tree, so `authenticate` loads it, but only for a role that uses them.

---

## 3. The seven starting roles

A new company is given these the moment it is created, by a database trigger (`ems_seed_default_roles`, generated from `server/src/platform/authz/defaultRoles.ts` by `scripts/roleSeedSql.ts`). "Reset to default" on the Roles screen puts a built-in role back to this. `authz.test.ts` and `roles.test.ts` check the trigger against `defaultRoles.ts`.

### 3.1 The role order

```
Super Admin                (locked: nobody edits it)
  ├── Admin
  ├── Accounts
  └── HR
        └── Manager
              └── Reporting Manager
                    └── Employee
```

The order decides who may hand out or manage which role (§8). It does **not** pass permissions down: each role has its own list.

### 3.2 What each starting role may do

| Module | Super Admin | Admin | HR | Manager / RM | Accounts | Employee |
|--------|:-----------:|:-----:|:--:|:------------:|:--------:|:--------:|
| Dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ own |
| Employees (directory) | ✅ | ✅ create, edit | ✅ create, edit | 👁 view | ❌ | ❌ |
| Salaries on employee records | ✅ | ❌ | 👁 all but seniors' | ❌ | ✅ (through Payroll) | ❌ |
| PAN, UAN, PF, ESIC | ✅ | ❌ | 👁 | ❌ | on payslips | own payslips |
| Attendance | ✅ | ❌ | ✅ mark, edit, delete | 👁 team | ❌ | 🟡 own, punch |
| Leave — apply | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| Leave — see requests | ✅ | ❌ | 👁 all | 👁 team | ❌ | own |
| Leave — decide | By the company tree, whatever the role (§5) | | | | | |
| Leave year and balances | ✅ | ❌ | ✅ grant, correct | ❌ | ❌ | ❌ |
| Leave types | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Holidays | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Payroll — salary structures, runs | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Payroll — approve, reopen | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Payroll — incentives | ✅ | ❌ | ✅ (within salary scope) | ❌ | ✅ | ❌ |
| Bank accounts — record, check | ✅ | ❌ | ❌ | ❌ | ✅ | send in own |
| Bank transfer file | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| My Payslips | ✅ all | own | own | own | ✅ all | own |
| Employee documents | ✅ | ✅ upload, check | ✅ upload, check | ❌ | ❌ | 🟡 own |
| Company documents | ✅ | ✅ publish | ✅ publish | 👁 | 👁 | 👁 |
| Document checklist | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Reports | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Settings (company, payroll config, notifications) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Users, roles, company tree, approvals | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Audit log | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Notifications (the bell) | own | own | own | own | own | own |

✅ full  ·  🟡 limited  ·  👁 view only  ·  ❌ none

Notes:

- **Admin, HR:** Settings opens only for the tabs they run: leave types (Admin, HR), holidays (HR) and the document checklist (Admin, HR).
- **HR and salaries.** HR holds `employee:compensation:read` with the scope "Whole company, except seniors". HR sees salaries on employee records, never a senior's. HR does **not** hold `payroll:structure:read`, because Payroll shows every salary to whoever opens it.
- **Accounts** has no `employee:read`. Salaries and bank details reach Accounts through the payroll screens only.
- **Admin and Accounts cannot apply for leave** from their role login. They do it from their employee login (§7).
- **Manager, RM and Accounts** have no employee documents, so they cannot upload even their own from the role login. That is still an open question for the client (§12). From the employee login they can.

### 3.3 The starting scopes

| Module | Super Admin | Admin | HR | Manager / RM | Accounts | Employee |
|--------|:-----------:|:-----:|:--:|:------------:|:--------:|:--------:|
| Employee records | Company | Company | Company | Company | Company* | Own |
| Salaries | Company | Own | Company except seniors | Own | Company | Own |
| Attendance | Company | Own | Company | Team | Own | Own |
| Leave | Company | Own | Company | Team | Own | Own |
| Payslips | Company | Own | Own | Own | Company | Own |
| Documents | Company | Company | Company | Own | Own | Own |

\* Accounts has no `employee:read`, so the employee scope only matters inside payroll.

---

## 4. Roles the Super Admin makes

On **Settings → Roles & Permissions** the Super Admin can:

- create a role, give it a name and a description, and choose the role it comes under;
- tick its permissions per module, in plain words, and choose its scope per module;
- see a preview of what the role will be able to do before saving;
- edit, reset (built-in roles) or delete (custom roles nobody holds) a role.

Every change is written to the audit log. A custom role shows its own name everywhere: the top bar, the sidebar, the profile, Users and the audit log.

---

## 5. The company tree and approvals

### 5.1 The tree

- Everybody reports to exactly one person (`Employee.reportingManagerId`). The Super Admin sets the tree on **Settings → Company Tree**, or on a person's page.
- The tree cannot loop. Nobody reports to somebody who has left, and nobody is placed above the owner.
- **The tree in effect** skips managers who have left. Their people show under "Nobody above" until the Super Admin places them. A manager who is still here but has no live login stays in the tree; their people's requests go to the Super Admin (or the named person) until the login is back.
- **Moving people:** only the Super Admin may move an existing person under themselves, or under anybody below them. That move would hand over that person's leave and work decisions. A new joiner added straight into your own team is allowed.
- **The owner** is marked explicitly, on one person who holds the Super Admin panel. The owner sits at the top; any reporting line they had is taken away when they are marked. The owner's own leave and items need nobody's approval and are recorded directly. The mark counts only while that person is still here and holds the Super Admin panel on a live login.

### 5.2 Who decides leave

| Case | Who decides |
|------|-------------|
| The person has a reporting manager who can sign in | That manager, whatever their role. An Accounts head decides the accountant's leave. |
| Nobody above (or the manager has left, or has no live login) | The Super Admin, or the person **Settings → Approvals** names |
| Standing in for the manager (backup setting; EMS does not know who is away, so the backup may decide any waiting request) | The Super Admin (default), or the manager's own manager ("next up"), or nobody |
| The owner | Nobody: recorded directly |
| Reversing approved leave | The manager or the Super Admin (default), or the Super Admin only |

- `leave:approve` no longer exists. HR sees every request and decides none.
- Anybody with people under them gets **Leave → Team Requests**, whatever their role (`session.decidesLeave`).
- A pending request follows the tree as it is when somebody decides.
- Nobody decides, reverses or files leave for themselves. The person's other login counts as themselves too (§7).
- The only Super Admin with nobody above and no owner marked is refused when applying, with "mark the owner", because nobody could decide the request.

---

## 6. Your own work goes up the tree

Somebody who does a kind of work never does it on their own record. Neither do their peers or juniors. Only the people above them can, and in the end the Super Admin.

| Work | Permission that makes somebody "do" it |
|------|----------------------------------------|
| Checking a bank account | `employee:bank:manage` |
| Correcting a leave balance | `leave:balance:manage` |
| Checking (or removing a checked) document | `document:verify` |
| Marking or correcting attendance, attendance import rows | `attendance:mark` / `attendance:update` |
| Entering an incentive | `payroll:entry:manage` |
| Entering a salary or TDS | `payroll:structure:manage` |

- **Allowed:** the people above the person in the tree, in effect. A Super Admin is allowed too, unless they are junior to that person. The owner may do their own.
- **The direct superior** does it. If they lack the right, it goes to the next person up who has it.
- An ordinary employee's items are done as before, by anybody holding the right whose scope reaches them.
- Lists say, row by row, whether the caller may act and whom it goes to instead (`may_check`, `may_correct`, `may_enter`, `blocked`). The screens show "Goes to …" or "Entered by …", and refusals name the person to ask.
- With no owner marked, a top Super Admin's own work cannot be done by anybody, so it is refused with "mark the owner".

Code: `server/src/domain/org/workGoesUp.ts` (pure rules), `server/src/modules/organization/workRules.service.ts`.

---

## 7. Two logins, one person

### 7.1 The rule

A person who holds a role has two logins:

| Login | For | Example |
|-------|-----|---------|
| **Employee login** | Their own things only: punch in, own attendance, apply for and withdraw leave, own documents, own payslips, own bank account | `priya@careermap.in`, role Employee |
| **Role login** | The role's work, and their team's leave | `priya.hr@careermap.in`, role HR |

- Each login has its **own email and its own password**. Ordinary employees have one login.
- Nothing makes the second login by itself: the Super Admin adds it (§7.3). A login invited from Settings → Users **without an employee code** belongs to nobody on the staff (an operator, such as an outside administrator). It is outside the company tree, and so outside the rule that one's own work goes up. Somebody already on the staff gets their role login on their page, never this way; the invite form says so.
- Both logins belong to the **same person**: the same employee record and the same place in the company tree.
- The top bar always says which one is open: "Signed in as HR" or "Signed in as Employee". On a phone it shows the role as a small label.

### 7.2 What keys on the person, not the login

- **Own work goes up** (§6) from both logins. A person "does" a kind of work if **any** of their live logins' roles holds it. So once Priya has an HR login, a fellow HR person can no longer correct her leave balance either.
- **Leave:** nobody decides their own leave from either login. A person with people under them decides their team's leave from the **role login**. Their employee login is for their own things: it shows no Team Requests, is not told of the team's requests, and cannot decide them (`ctx.selfServiceOnly`, `domain/org/logins.ts` `isSelfServiceLogin`). While the role login is only invited or switched off, the employee login decides, so nothing waits.
- **The Super Admin panel** counts from any live login: for the owner mark, and for "the Super Admin is always above".
- **User management:** nobody changes the role of, switches off or removes their own logins, either one. Acting on any one login of a person (a password link, switching it, giving it a role, removing them) needs the right over **every** login of theirs: a senior's employee login is the senior.
- **Notifications** about the person go to all their logins that are not switched off; a request waiting for their decision goes to the role login. Nobody is told about their own action on their other login. A password change on one login is also told on the other.
- **The audit log** filter "about a person" finds the entries of both logins.

### 7.3 Adding, switching off, leaving

- **Adding a role login** is the Super Admin's (`role:manage`). It is done on the person's page (**Employees → the person → Logins → Add role login**), never by adding a new person. The login gets its own email and its own invitation link. The role must be one the person does not hold already (`POST /api/employees/:id/logins`).
- **Switching one login off** (Settings → Users, or the person's page) leaves the other as it is.
- **Leaving** (Remove in Settings → Users) closes **every** login of the person together, ends every session of both, and archives the employee record. The caller must be allowed to manage every one of those logins: HR cannot remove somebody whose other login is Accounts. The logins of somebody who has left stay closed: turning one back on is refused, and Users shows them as "Left" with no buttons.
- **Settings → Users & Roles** lists a person's logins together, with the name once, "2 logins", and "Their other login" on the second row. The role picker leaves out the roles their other logins hold.
- **Signing in by Employee ID** works when exactly one of the person's logins can sign in (a role login still invited, or switched off, does not count). An Employee ID names a person, so somebody with two live logins signs in with the email of the login they want. The sign-in page says so.

### 7.4 Data

`Membership.employeeId` links a login to its person. A person may have any number of logins, but only one per role (`@@unique([organizationId, employeeId, role])`). Migration `20261002045302_two_logins` copied every existing link from the old `Employee.membershipId` before dropping it; `20261002055519_two_logins_person_fk` makes a login go with its person if an employee row were ever hard-deleted (EMS never does).

---

## 8. Rules that hold whatever the Super Admin chooses

- The Super Admin role cannot be edited or deleted. At least one active Super Admin always remains.
- `role:manage` (and `employee:delete`, which nothing checks) cannot be given to another role.
- Nobody edits a role they hold themselves.
- A role somebody holds, a role other roles come under, and the seven built-in roles cannot be deleted.
- **Giving and managing.** A person may give only a role below their own that holds nothing they cannot do themselves. The same applies to changing, switching off, removing or resetting the password of somebody else's login.
- **Reach.** Managing logins works within the role's employee scope. A role reaching one department manages only that department's logins.
- **Moving people.** Nobody moves somebody into their own team or department when that would show them more (salaries, for example). Nobody moves a senior, because that could take them out of "the people above". Somebody above makes such moves.
- **Adding people.** Inviting (Settings → Users) and importing a roster need a company-wide employee scope, because both add people outside any team or department. A narrower role adds people under Employees, with itself as their reporting manager.
- A roster with an email column gives each person an Employee login, so only a role that may give the Employee role can import it. The preview says so.
- A role without "Open the dashboard" signs in to the first area it can open.
- The screen warns, and asks once more, before saving a role that both prepares and approves the payroll, or one that can read the audit log.

---

## 9. Key workflows

### Leave

```
Employee applies (from their employee login)
  → the person they report to decides (§5.2) → Approve or Reject
  → approval takes the days from the balance and marks the attendance
```

- Days are counted as working days (weekly offs and public holidays are left out). The balance shown is after anything already applied for.
- **Withdraw:** the person, while it is pending. It shows as *Cancelled*, and whoever decides it is told.
- **Reverse:** once approved, by the manager or the Super Admin (Settings → Approvals), never by the person it belongs to. The days go back to the balance and come off the attendance. A month whose payroll is approved cannot be changed.
- **Granting the year:** HR or the Super Admin, under Leave → Team Balances. Joiners get the months that are left, to the nearest half day. Unused days carry over up to each type's cap. Nothing is granted twice.
- **Correcting a balance:** HR or the Super Admin, in whole or half days, with a reason the employee sees. One's own goes up the tree (§6).

### Documents

```
Employee uploads against the checklist → whoever checks documents and reaches them is told
  → Verify, or Reject with a reason → the employee is told
```

- One's own documents, and a fellow checker's, are checked by the people above (§6). An upload by HR or Admin for somebody else can be marked verified at once.
- A new upload replaces the current one. Earlier ones stay listed, so what was rejected and why is not lost.
- Files are checked by their contents: PDF, JPG, PNG or WebP only, up to the company's limit (2 MB to start). Phone photos are shrunk in the browser first.
- Files are never reachable by a link. Each one is opened through the app after a permission check, every download is recorded, and every file is checked against its stored fingerprint.

### Payroll

```
Accounts sets salaries → creates the month's run (draft) → recalculates as needed
  → Super Admin approves → Accounts takes the bank file → Accounts marks it paid
```

- **Approve** and **reopen** are the Super Admin's (`payroll:run:approve`), so Accounts, who prepares, never signs. The Super Admin holds both and can do the whole run alone. Approving recalculates and refuses if any payslip would change.
- **Mark paid** stores every payslip as a PDF with a SHA-256 hash. A paid month cannot change.
- One's own salary, TDS and incentive go up the tree (§6).

### Bank accounts

- Accounts records an account from a cancelled cheque or passbook page and checks it. An employee can send in their own from their profile, with proof; it arrives pending and is not paid into until checked.
- One's own account, and a fellow checker's, are checked by the people above (§6).
- The bank file is made only from an approved or paid run, includes checked accounts only (a setting), and lists everybody left out with the reason.

### Notifications

- The bell shows each login its own notices.
- A leave request goes to the person who decides it (the Super Admin when that is the Super Admin). A document sent in goes to whoever checks documents and whose scope reaches the person; a bank account sent in goes to whoever checks bank accounts.
- Nobody is told about their own action, from either of their logins.
- The Super Admin turns each kind on or off. The password-changed notice is always sent. Notices older than 180 days are cleared by the maintenance job.

### Audit log

- Records every sign-in and refused sign-in, every refused request, every change to roles, logins, the company tree and the approval settings, every salary change, each payroll step, every file opened and every file that leaves the system.
- Each entry says in words what happened, with names, and the role the person held at the time.
- Read on Settings → Audit Log: the Super Admin only, unless `audit:read` is given to a role (with a warning). Nobody can change or delete an entry.

---

## 10. Security model

| Layer | What it does | Bypass-proof? |
|-------|-------------|:-------------:|
| Page guards in the browser | A page and its menu link show only for a permission that opens it (`web/src/config/navigation.js`) | No |
| Permission check on every route | `authenticate` + `authorize('…')` before anything runs | ✅ |
| Data scope | Every query narrowed to the company and to the caller's scope | ✅ |
| Tree rules | Leave decisions and own work, decided on the server from the tree | ✅ |

| Area | Implementation |
|------|----------------|
| Sign-in | Email, or Employee ID for somebody with one login, and password |
| Tokens | Access token 15 minutes; refresh token 7 days, rotated on use; a reused one ends the session. A role change ends access tokens at once |
| Passwords | bcrypt, cost 12; no default password; invitations and resets are single-use links valid 72 hours |
| Self-protection | Nobody changes their own role, switches off or removes their own logins, or does their own work in their role's area (§6, §7) |
| Roles | Rows per company; the starting set in `defaultRoles.ts`, checked against the database trigger by tests |
| Files | Checked by content, private storage, opened through the app, every download recorded |
| Audit log | Append-only, with who, as what role, from which device and address |
| Browser | CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy |
| Sign-in limits | 10 tries per account and 100 per address per 15 minutes |
| Backups | Nightly, sealed (AES-256-GCM), stored off the server; restored and checked every month |

---

## 11. Developer quick reference

- **Asking about access:** `ctx.can('permission')` on the server, `useAuthStore().can('permission')` in the browser. Never compare a role. `ctx.scopeFor('module')` gives the scope; `employeesInScope` / `isInScope` apply it.
- **"Own":** compare `ctx.employeeId` (the person), never `ctx.userId` or `ctx.membershipId` (the login). A person's logins are `Employee.memberships`; ask `domain/org/logins.ts` (`canSignIn`, `holdsSuperAdmin`, `permissionsOf`, `isSelfServiceLogin`, `decidingLogins`) about them together. Tree decisions go through `deciderOf(ctx)`, which honours `ctx.selfServiceOnly`.
- **A Prisma `where` that might be `{}`:** `employeesInScope` returns `{}` for the whole company. Never put it inside an `OR` — Prisma drops an empty condition there, so `OR: [{}, ids]` means only `ids`.
- **A new role:** made on the Roles screen. No code.
- **A new permission:** add it to `platform/authz/permissions.ts` and its words to `platform/authz/catalogue.ts`; give it to the starting roles in `defaultRoles.ts`; write a migration that updates existing roles and the trigger (`scripts/roleSeedSql.ts`); `roles.test.ts` fails until the trigger matches.
- **A new module with whose-information rules:** add it to `SCOPED_RESOURCES` and use `scopeWhere.ts`.

---

## 12. Testing checklist

**Sign-in**
- [ ] Each role signs in with email; somebody with one login also with Employee ID
- [ ] Somebody with two logins cannot sign in by Employee ID, and the sign-in page says to use the email
- [ ] The top bar says which login is open, on desktop and on a phone

**Permissions and scopes**
- [ ] The menu shows only what the role opens; a direct URL to anything else is refused
- [ ] A custom role does exactly what its ticks and scopes say, after a save, on the next click
- [ ] HR sees every salary on employee records except the seniors'; never Payroll

**The tree**
- [ ] Leave goes to the reporting manager, whatever their role; nobody above → the Super Admin
- [ ] The backup and reversal settings apply; the owner's leave is recorded directly
- [ ] Moving somebody under yourself is refused for everybody but the Super Admin

**Own work**
- [ ] Bank, leave balance, documents, attendance, incentive, salary/TDS: refused for oneself and for a peer; done by the person above

**Two logins**
- [ ] The Super Admin adds a role login on the person's page; nobody else can
- [ ] Own work and own leave are refused from both logins
- [ ] The team's leave is decided from the role login; the employee login shows no Team Requests
- [ ] Nobody below a person's highest login can reset, switch or re-role any login of theirs
- [ ] Switching one login off leaves the other; leaving closes both, ends both sessions, and they cannot be turned back on
- [ ] Users settings shows the two logins together

**Security**
- [ ] Every API route checks a permission; out of scope answers "not found"
- [ ] A file that is not really a PDF or image is refused, whatever its name
- [ ] Only the Super Admin reads the audit log by default

---

## 13. Open question and later ideas

> **Open question for the client:** Manager, RM and Accounts have no employee documents on their role login, so they cannot upload their own there. With two logins they can upload from their employee login. If the role login should manage its own documents too, it is one tick per role on the Roles screen.

| Idea | Description |
|------|-------------|
| Temporary permissions | Time-bound access (an acting manager for two weeks) |
| Multi-step approvals | Leave through more than one person in turn |
| Two-factor sign-in | For the Super Admin and Accounts logins |

---

*CareerMap Solutions Pvt. Ltd. — Internal Use Only*
