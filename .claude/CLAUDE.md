# EMS — HR & Payroll Management System

HR & Payroll system for **CareerMap Solutions**. Employee lifecycle, attendance, leave, payroll, documents, reports.

> **Read [EMS_BUILD_GUIDE.md](../EMS_BUILD_GUIDE.md) before making any change.** It is the source of truth for architecture, conventions and the day-by-day plan. Part A is the system design; Part B is the schedule.

---

## Current state — v1.0 built; deploy next

The project runs entirely on its own stack: React + Vite in front, Node + Express + Prisma + PostgreSQL behind it, files in Cloudflare R2.

| | Status |
|---|---|
| `web/` — React app | Every screen reads the API |
| `server/` — Express + Prisma | Every module: auth, people, attendance, leave, payroll, documents, notifications, reports |

Work follows the build guide's day plan.

### Migration progress

- [x] **Day 1** — workspace split, Express + TypeScript skeleton, error contract, `/health`
- [x] **Day 2** — Prisma schema (identity / org / people), first migration, tenant conformance test
- [x] **Day 3** — platform layer (scoped client, transactions, logger, password, storage), bootstrap CLI
- [x] **Day 4** — login: email or employee code, access + refresh tokens
- [x] **Day 5** — sessions: rotation, reuse detection, logout, change-password, rate limits
- [x] **Day 6** — permissions registry, data scopes, frontend auth cutover
- [x] **Day 7** — employee reads, scoped + field-level permissions, field contract
- [x] **Day 8** — employee writes, invitations, role/status/termination
- [x] **Day 9** — settings, statutory policy, geofence, master data
- [x] **Day 10** — CSV roster import with dry-run preview
- [x] **Day 11** — attendance punch flow, server-side geofence, domain layer
- [x] **Day 12** — attendance views, monthly hours, biometric import
- [x] **Day 13** — leave requests, working-day counting, ledger backfill
- [x] **Day 14** — leave approval, reversal, dashboards
- [x] **Days 15–18** — payroll: policy, runs, payslips and PDFs, payroll frontend, bank file (`v0.5-payroll`)
- [x] **Day 19** — documents, notifications, reports, one CSV writer, bank proof
- [x] **Day 20** — DataState on every screen, error boundaries, 404 page, lazy pages, confirm dialogs, audit log screen, security headers, backup + tested restore, deploy runbook (`deploy/`)
- **Days 21–23** are the client's requests after reviewing the first roles document (30 Sep 2026, since deleted). The design agreed is written up for the client in `docs/client/EMS-Roles-and-Approvals.pdf` (1 Oct 2026; its HTML source sits beside it); keep the two in step. The client's idea in one line: **a hierarchy. Everybody sits under somebody, the person above decides, and the Super Admin sets all of it. Nothing about roles or approvals stays hardcoded.** All three days change the database schema, so all three are **done before the first deploy**.
  - **Every day goes through every layer: database → server → API → screens.** A rule that lives only in the server is not done until a screen shows it. A screen is not done until the server enforces what it shows. Each day ends with E2E runs for every role, on desktop and on a phone, and an independent review (Definition of done).
  - **The web hardcodes the role list in four places:** `lib/roles.js` (labels), `UsersSettings.jsx` (ROLES and colours), `UserAccess.jsx` (INVITABLE_ROLES) and `AddEmployeeModal.jsx` (LOGIN_ROLES). Day 21 replaces all four with the roles from the API. Permissions already come from the server (`authStore.can()`).
- [x] **Day 21** — **Roles & Permissions, for the Super Admin.** Built 1 Oct 2026 on `phase/8-roles-hierarchy` (migration `20261001062620_roles_table`). What follows is the plan as written. Beyond it:
  - One scope definition for every module (`platform/authz/scopeWhere.ts`), with DEPARTMENT implemented.
  - Attendance mark and import, leave on someone's behalf, leave balances, documents compliance and payslips all honour the scope.
  - Notifications go only to holders whose scope reaches the person.
  - `GET /users` opens to any of the four user permissions.
  - `employee:delete` (checked by nothing) is kept off the Roles screen.
  - Payslips offer only own or company.
  - Every audit row keeps the role's name at the time.
  - A role edit ends its holders' access tokens, so their screen refreshes at once.
  - Review fixes (core): a role change ends access tokens, not sessions, and a refresh with an ended (never rotated) token is a plain 401, not a reuse alarm; user actions check the target is in the actor's employee reach (`assertTargetInReach`, 404 outside) and `GET /users` is filtered by it (`meta.reach` tells the screen whose logins they are); nobody moves themselves, and nobody moves a person INTO their team/department scope (`assertNoNewReach`); roster import and every invite need an ORGANIZATION employee scope (invite reads it from the role re-read under the lock); import logins must be givable (Employee role), checked in the preview too; `audit:read` gets a warning like payroll prepare+approve, and the Audit Log's filter lists come from `GET /api/audit-log/people` (audit:read), not /users or /employees; audit summaries for role created/deleted say whose information it reaches; reach refusals are 403, out-of-reach targets 404 (checked before status or role-key errors); a role without `dashboard:read` lands on its first permitted area (`pages/Dashboard.jsx`).
  - **Database.** A `Role` table per organization holds each role's name, the role it comes under, its permissions, and a scope per module. `Membership.role` (the Prisma enum) becomes a link to that table. The migration maps every existing login to its seeded role, so nobody's access changes.
  - **Seeds.** The seven current roles, exactly as they are today, with "reset to default". Two of the client's changes wait for Day 22, which brings what they depend on:
    - HR loses `leave:approve` on Day 22, in the same change that moves approving to the tree. Taking it on Day 21 would leave days in which nobody approved for HR's own team.
    - HR's salary view (Devesh, 1 Oct 2026: HR negotiates salaries) is seeded on Day 22, together with the "company, except people above me" scope it needs. No build in between shows a senior's pay.
    - Entering and changing salaries stays with Accounts (`payroll:structure:manage`). One person agrees a salary and another enters it.
    - Day 22 changes these defaults with a migration that replaces the seeding function and updates the HR rows still at their default.
  - **Server.**
    - **Permissions and scopes are read from the role table on every request.** The server already reads the current role there (`authenticate.ts`), so a change applies at once, without a fresh login.
    - **API** to list, create, edit, reset and delete roles, and to give a role to a login.
    - **Role order.** Each role says which role it comes under, and the Super Admin is always at the top. A user can give only a role below their own. They can manage (reset a password, deactivate) only accounts whose role is below their own. The old "more access than your own" comparison is KEPT alongside it (it now compares scopes as well), so a role placed below yours by mistake, but holding payroll, still cannot be handed out through you.
    - **Guards.** The Super Admin role cannot be edited or removed, and at least one Super Admin always remains. Nobody edits a role they hold themselves. A role in use cannot be deleted. A warning appears when one role would both prepare and approve payroll. Every change is written to the audit log (new catalogue entries).
    - Salary becomes a scoped module of its own. Today `employee:compensation:read` is unscoped.
  - **Screens.** Settings → Roles & Permissions:
    - The list of roles, with how many people hold each and the order they come in.
    - The editor: permissions ticked per module, in plain words; a "whose information" choice per module (own, my team, department or company; the tree choices join on Day 22); and the role it comes under.
    - A preview of what the role will be able to do, before saving.
    - Reset to default, delete (refused while the role is in use), and every guard's message in plain words.
    - The four hardcoded role lists read from the API. A custom role shows its own name everywhere: top bar, sidebar, profile, Users and the audit log.
  - **Tests.** `authz.test` keeps testing the seven defaults. The whole server and E2E suite must pass against the seeded roles before any custom role is tried. New tests cover custom roles, scopes, the role order and every guard, plus E2E for the editor.
- [x] **Day 22** — **The company tree, approvals that follow it, and "your own work goes up".** Built 2 Oct 2026 on `phase/9-company-tree` (migration `20261001191257_company_tree`). What follows is the plan as written. As built:
  - **Pure rules in the domain:** `domain/org/companyTree.ts` (tree in effect vs as recorded, loops, unplaced, `placeIn` with the owner and Super Admins always "above"), `domain/leave/approval.ts` (route, mayDecide, mayReverse), `domain/org/workGoesUp.ts`.
  - **`leave:approve` is gone** (permissions, catalogue, defaults; migration strips it from every role). Approve/reject/reverse/withdraw-for-others need only a signed-in caller; `leave/leaveApprover.service.ts` decides from the tree and Settings → Approvals, names who decides in refusals, 404s anybody who cannot see the request. `GET /api/leave-requests/team` (requests the caller decides + `backup` list); every leave row carries `can_decide`, `can_reverse`, `as_backup`, `decided_by`. A manager with no live login, or one who has left, counts as nobody above.
  - **Owner:** `Organization.ownerEmployeeId`, honoured only while that person is here and holds the locked Super Admin role on a live login (`findApprovalRules`). Their leave is approved in the same transaction (`leave.recorded_directly`). The only Super Admin with nobody above and no owner marked is refused with "mark the owner".
  - **Settings → Approvals:** `Organization.leaveNoManagerApproverId` (null = Super Admin), `leaveBackup` (super_admin | next_up | none), `leaveReversal` (manager_or_super_admin | super_admin_only); `GET/PUT /api/company-tree/approvals`.
  - **Settings → Company tree:** `GET /api/company-tree`, `PUT /api/company-tree/owner` (role:manage). Moving is `PATCH /employees/:id` under `treeLock` with `assertManagerFits`: no loops, nobody under somebody who left, nobody above the owner, and nobody but the Super Admin moves an existing person under themselves or anybody below them (a new hire into your own team is allowed).
  - **Scopes:** `ALL_REPORTS`, `ORGANIZATION_EXCEPT_ABOVE`; ScopeContext.tree loaded in `authenticate` only for grants that use them; HR default compensation = `ORGANIZATION_EXCEPT_ABOVE` with `employee:compensation:read` (no Payroll).
  - **Own work goes up** (`organization/workRules.service.ts`): bank check, leave balance, document check, attendance mark/import, incentive, salary/TDS. Lists carry `may_check`/`may_correct`/`may_enter`/`blocked` with whom to ask.
  - **Review fixes:** the owner and every Super Admin always count as "above" for `ORGANIZATION_EXCEPT_ABOVE` (`placeIn`; a login with no employee record sees all but them); incentives are scoped by the salary scope for anybody without `payroll:structure:read` (HR never sees or sets a senior's); removing a checked document goes up the tree; with no owner marked, a top Super Admin's own work and leave are refused with "mark the owner"; `ALL_REPORTS` judges existing records by the tree as it stands; Team Balances also lists the people the caller decides; the attendance roster carries `mark_goes_to`; leave notices link to `/leave?tab=decide`.
  - **Screens:** Leave → Team Requests (menu shows Leave for `session.decidesLeave`, the `@decidesLeave` pseudo-permission in `authStore.canAny`), HR sees no Approve, dashboards count "waiting for you", Settings → Company Tree and Approvals, the two scopes with hints in the Roles editor, employee page "Reports to" says when the manager has left.
  - **Database.** The owner mark, on exactly one person. The approval settings, with the client's defaults. (`reportingManagerId` already exists.)
  - **Server — the rules:**
  1. **The company tree.** Each person reports to exactly one person, and the Super Admin sits at the top and sets the tree. Role holders sit in it like everybody else. The tree cannot loop (A under B under A). People with nobody above them are listed, so the Super Admin can place them.
     - Two new scopes: everybody under me at every level, and company except people above me. Add them in `platform/authz/scopeWhere.ts`, which ALL modules use since Day 21: `employeesInScope`, `ownedRowsInScope` and `isInScope`. They will need the caller's place in the tree (their subtree, their ancestors), so ScopeContext grows. Notifications (`notify.service` `reaching`) and the create/edit reach check (`employee.service` `assertWithinReach`) go through `isInScope` and must keep working.
     - HR's salary view is seeded now, with the "company, except people above me" scope. **Keep HR without `payroll:structure:read`.** Payroll and Reports show every salary to whoever opens them (the editor says so). The salary scope governs employee records only, so HR seeing Payroll would show the seniors' pay the scope hides.
  2. **Approvals come from the tree, not from the role.**
     - A leave request goes to the requester's reporting manager, whatever that person's role. Anybody with people under them gets their team's requests automatically, even an Accounts head whose role has no leave rights.
     - HR no longer approves leave. HR still sees every request, grants the leave year and corrects balances.
     - **Confirmed by the client (30 Sep 2026):** nobody above → the Super Admin approves. If the reporting manager is away or has left, the Super Admin can approve as the backup. Approved leave can be reversed by the reporting manager or the Super Admin. These are settings with those defaults (Settings → Approvals), not code.
     - A pending request follows the tree as it is when somebody decides. Moving a person, or a manager leaving, sends it to the new approver. When a manager leaves, their people are listed as "nobody above" until the Super Admin places them.
     - **The owner needs no approval** (Devesh, 1 Oct 2026). The owner is the person at the very top of the tree, with nobody above, who holds the Super Admin panel. Their own leave, and their own items generally, are recorded directly and shown in the audit log. Any other Super Admin sits under somebody in the tree like everybody else.
       - **The owner is marked explicitly**, on exactly one person. Being placed at the top is never enough. Otherwise somebody left without a manager by mistake would also skip approval. Anybody else with nobody above is listed as "nobody above", and their items go to the Super Admin.
  3. **Your own work in your role's area goes UP the tree** (Devesh, 1 Oct 2026). Somebody who does a kind of work (HR, Accounts, Admin) cannot do that work on their own record, from either login. Peers and juniors cannot do it either. Only the people above them can.
     - The direct superior does it. If the direct superior lacks that right, it goes to the next person up who has it, and in the end to the Super Admin.
     - Examples: an accountant's bank account is verified by the person above them (say the Accounts head), not by themselves or another accountant. An HR executive's leave balance is corrected by their superior in the tree, not by anybody else in HR. The same goes for documents.
     - An ordinary employee's items are handled as today, by anybody holding the right.
     - Today's messages ("ask someone else in Accounts", "somebody else in HR has to") change to "the person above you".
     - Three self-checks do not exist yet and are added under the same rule: HR marking or correcting their own attendance, entering their own incentive (`payroll:entry:manage`), and Accounts entering or changing their own salary (`payroll:structure:manage`).
  - **Screens.**
    - **Settings → Company tree:** the tree drawn as a chart. From there the Super Admin changes who somebody reports to, marks the owner, and works through the "nobody above" list. The person's own page shows "reports to" too, and can change it.
    - **Leave:** anybody with people under them sees a Team requests tab and approves there, whatever their role. The menu shows Leave to them even when their role has no leave rights. HR sees every request, with no Approve buttons.
    - **Settings → Approvals:** the three settings.
    - **Salary for HR:** read only, on an employee's page, and hidden for the people above them.
    - **Refusals** say who to ask instead: "Ask the person above you (name)".
    - The two new scopes appear in the Roles & Permissions editor.
  - **Tests.** Who approves in every case: the direct manager, nobody above, the backup, the owner, a person who moved, a manager who left. Also loops, the walk up the tree, the three new self-checks and the two new scopes. E2E as a manager, an Accounts head with a team, HR and the Super Admin.
- [x] **Day 23** — **Two logins, one person** (the client's choice), **and the wrap-up of Days 21–23.** Built 2 Oct 2026 on `phase/10-two-logins` (migration `20261002045302_two_logins`). What follows is the plan as written. As built:
  - **Database:** the link moved to `Membership.employeeId` (FK Cascade since `20261002055519_two_logins_person_fk`, `@@unique([organizationId, employeeId, role])`, `@@index([employeeId])`); `Employee.membershipId` dropped AFTER the migration copied every link across. `Employee.memberships` is the list.
  - **Person-keyed rules:** `domain/org/logins.ts` (`canSignIn`, `holdsSuperAdmin`, `permissionsOf` over all live logins) used by `tree.repository` (treePeople, topPeople, workPeople = permissions union), `session.repository.findTreePlace`, `organization.repository.findApprovalRules` (owner by any live SA login), `companyTree.service` (role shown as "Employee, HR"). Self-checks were already on `ctx.employeeId`.
  - **Employee login = own things only:** `isSelfServiceLogin` (the Employee-role login of somebody with an ACTIVE other-role login) → `ctx.selfServiceOnly` → `deciderOf` decides nobody; session `decidesLeave` false; `decidingUsersOfEmployee` leaves it out of "waiting for you" notices. With the role login invited/off, the employee login decides again. Its scopes are all SELF whatever the Employee role is given (`platform/authz/grant.ts` `ownThingsOnly`, applied in `session.repository.findAuthState`, `auth.repository.grantOf` and `notify.service` `reaching`), so widening the Employee role never widens an employee login of a role holder.
  - **User management:** `user.policy.isOwnLogin` — your own other login is "own" for role change, status and remove. Acting on ANY login of a person needs the right over every login of theirs (`assertOtherLoginsBelow`: password link, status, role, remove) — a senior's employee login is the senior. `terminateUser` closes every login, archives the employee once (a second remove keeps the date), revokes every session. "Last Super Admin" counts only an ACTIVE target (an invited SA login can be withdrawn). A left person's login cannot be turned back on. `changeRole` refuses a role the person's other login holds (409). `POST /api/employees/:id/logins` (`role:manage`, `addLogin`, 409 on a racing email) adds an invited login with its own email and link; audit `user.login_added`; `user.status_changed` names the login.
  - **Notifications:** `usersOfEmployee(s)` return every non-inactive login; `notify` drops all of the actor's own logins; `approverUsers` drops all of the applicant's; a password change is also told on the person's other login.
  - **Sign-in by employee code** when exactly one login is active (or the only/one invited one); two live → null → "use the email".
  - **Day 22 fix found by the Day 23 E2E:** `leave.repository.peopleInScope` built `OR: [{}, ids]` — Prisma drops `{}` there, so a company-wide HR with a team saw only the team's balances. Now skipped when the scope is everybody.
  - **API shape:** employee `logins: [{id,email,role,role_name,status}]` (oldest first); single `email/role/role_name/account_status` = the first login. Users rows `person_id`. Audit "about a person" covers all their logins.
  - **Screens:** person page → Logins (list, "Add another login" for the Super Admin with no role picked for them and a warning on Super Admin, Turn off/on, New link for an invited login; `EmployeeLogins.jsx`) on the profile page's Logins tab; top bar "Signed in as …" (phone: a role chip); Users settings grouped by person ("2 logins", "Their other login", "Left", buttons only when every login of the person is manageable, Remove on the person, role picker without the other login's role, counts "logins"); invite form says to add a staff member's role login on their page; Audit Log "Done by" names which login; sign-in page hint.
  - **Tests:** `user/twoLogins.test.ts` (23), `domain/org/logins.test.ts` (6), policy tests for the other login; E2E `day23.mjs` 75 (also the Day 22 browser-only items: owner of somebody with a manager, next-up backup, "Entered by", TDS picker, own documents note).
  - **Wrap-up:** `Role_Permission_Documentation.md` rewritten (v2.0) for the model of Days 21–23; `docs/client/EMS-Roles-and-Approvals` corrected against the build and its PDF printed again (2 Oct). Independent reviews of server, web and docs; every finding fixed.
  - **Days 21–23 wrap-up pass** (branch `fix/wrapup-21-23`; four reviewers over the whole of `ae5ada9..93a94c9`, plus `sweep23.mjs`: every login × every page and tab × desktop and 390px). No schema change. Fixed:
    - **The tree is the Super Admin's:** setting, changing or clearing an EXISTING person's reporting manager needs `role:manage` (closed: HR handing people to a new hire whose invite link it holds, clearing a line to reach the "nobody above" approver, moving a peer's manager). A new joiner is still placed by whoever adds them; the edit form locks the field for others. Moving somebody tells their new approver about waiting requests (`tellNewApprovers`).
    - **Giving relative scopes:** `grantsMoreThan` — a candidate scope other than SELF is covered only by the actor's ORGANIZATION (the scope is measured from the new holder).
    - **Tree over role order in user management:** nobody but the SA manages the logins of somebody above them in the tree (`assertOtherLoginsBelow`).
    - `placeIn` counts every SA and the owner as "above" even when placed below; the owner mark needs nobody above them; approval settings' `version` is a hash of the settings (not `Organization.updatedAt`); a named approver who cannot sign in is shown as such and does not block saving.
    - Leave: leavers' pending requests stay in `peopleDecidedBy`; the owner's own old request is theirs; stand-ins found from the tree with `mayDecide` (`pendingExcept` removed); Team Balances `may_correct` also needs the leave scope; create-employee reads back by the company (tree scopes); import re-checks company-wide reach under the roles lock.
    - Notices: `to: { doing }` and `reaching.work` send "to check" notices only to people who may check; `reaching` uses effective scopes (`toGrant`); a password change is told on the person's other login.
    - Ticks: `payroll:entry:manage` requires `employee:compensation:read`; `attendance:delete` moved to `SUPER_ADMIN_ONLY` (nothing checks it) and out of the work list; marking an already-recorded day (or an import over one) needs `attendance:update`; `statutory` writes need `employee:identity:read`; the Documents module note says documents can show pay.
    - Logins: `logins` sent only to login managers (`FieldAccess.includeLogins`); `POST /api/users/:id/withdraw` deletes an unused invitation (audit `user.invite_withdrawn`); session carries `employeeReach` (Import button only for ORGANIZATION).
    - Web: dashboard needs `dashboard:read` (+ a profile for the personal one); Payroll menu also for `employee:bank:read`; Checklist Remove follows `may_check`; Leave tab follows the address (notice links work on an open page), Approve/Reject held while sending, phone layout; Roles editor reloads after a 409 and drops ticks nobody can tick; Approvals keeps its form mounted; Company Tree says how to make the first owner; Users: words for status, Withdraw, confirm before turning off, aria-labels; Escape on the drawer and the older modals.
    - Decided (Devesh, 2 Oct 2026): HR keeps a company-wide document reach, seniors' offer letters (pay) included. Changeable on the Roles screen.
  - **The rule.** A role holder has an employee login and a role login, each with its own email. Both belong to the SAME person in the tree. That is what lets Day 22's rule 3 see that both logins are one person.
  - **Database.** A person can have more than one login. Today `Employee.membershipId` is unique, so a person has one login. The link moves, so two logins can point at the same employee record.
  - **Server.**
    - The Super Admin adds a role login from that person's page, never as a new person. It gets its own email and its own invite link.
    - The self-rules, the tree and "your own work goes up" all key on the person, not the login.
    - Leaving closes every login of that person together, and ends every session of both.
  - **Screens.**
    - On the person's page: their logins, "Add role login", and turning a login off.
    - The top bar always says which login is in use ("Signed in as HR" / "Signed in as employee"), so nobody works in the wrong one by mistake.
    - Users settings groups logins by person.
    - The employee login shows self-service on own data only: punch in, own attendance, apply for and withdraw leave, own documents, own payslips, own bank account.
  - **Tests.** Own work is refused from both logins. Leaving closes both. E2E as a person with two logins.
  - **Wrap-up.**
    - Rewrite `Role_Permission_Documentation.md` for the new model (it still describes the seven fixed roles).
    - Check `docs/client/EMS-Roles-and-Approvals` against what was built, and print a fresh PDF if anything differs.
    - A Neon migration (Devesh runs it).
    - Full regression E2E for every role, on desktop and phone, and an independent review of Days 21–23.
- [x] **Employee lifecycle (client §43)** — built 3 Oct 2026 on `fix/wrapup-21-23` (migration `20261003054408_employee_lifecycle`; Neon must migrate). One company. As built:
  - **Stages** (`domain/org/lifecycle.ts` `stageOf`, derived, never stored): joining_soon → onboarding → probation → confirmed → resigned → notice_period → exit_due → left. From `Employee.onboardedOn / probationEndDate / confirmedOn / lastWorkingDate / exitReason`, archived/inactive, and the open `Resignation` (submitted | accepted). Employee API sends `lifecycle_stage` and the dates.
  - **Data:** `EmploymentEvent` (the history: kind, effectiveDate, details JSON, note, by) and `Resignation` (submitted → accepted | withdrawn | cancelled → completed); `Organization.probationMonths` (6) and `noticePeriodDays` (30). The migration backfilled existing people (joined → onboarded; probation = joining + 6 months; confirmed if that has passed), gave `employee:lifecycle:manage` to locked roles and built-in HR, dropped the retired `attendance:delete`, and regenerated `ems_seed_default_roles`.
  - **Who:** HR's steps need `employee:lifecycle:manage` (requires `employee:update`), within the employee scope, and own/peer work goes up (`workRules` kind `lifecycle`). A resignation is the person's own to hand in/withdraw (before acceptance); it is accepted by the tree decider (`mayDecide`/`deciderOf`, standing in included) — never HR as such; called off by the decider or HR (clears the last working day it set). Changing the reporting line in a transfer stays `role:manage`. Never on somebody above the caller in the tree (`workRules.aboveCaller`, tree.above) — the Super Admin's. `assertMayChangeEmployment` (workRules) is the one check for steps AND for editing designation/department/last working day on the employee record (which also records `promoted`/`transferred` events with `via: 'edit'`, refuses a last day while a resignation is open, and payroll-locks last-day and joining-date changes).
  - **Privacy:** the view's `detailed` (self, their own record, role:manage, whoever runs this record — `checkWork` kind `lifecycle`, so not a senior's nor a fellow HR person's — and the tree decider) gates history, resignation, onboarding facts and exit reason; others see the stage with an unaccepted resignation hidden. The employee serializer masks `resigned`/`exit_reason` the same way (`FieldAccess.lifecycleOf`: everybody for runners/SA except records that are not theirs to run (`notTheirs`: above the caller, or refused by `checkWork`), else self and direct reports). Seniors, and a fellow runner's unaccepted resignation, are also left out of the summary card and of lifecycle notices (`mayDoWork` for kind `lifecycle`).
  - **Server:** `modules/lifecycle` (`/api/lifecycle`: me, summary, settings, employees/:id + onboarding|probation|confirm|transfer|promote|resignation|exit, resignations + waiting|accept|withdraw|cancel). Each step: one transaction under `lifecycle:${id}` lock (exit: rolesLock first), event + audit + notice. The view's `may` flags are what the server allows. Exit any time (early relief before an accepted last day; `may.exit` = `mayCloseLoginsForExit`, so no button where a login could not be closed); a joining-soon person leaves with no last day (`neverJoined`). `closeLoginsForExit` (caller must manage every login), archive, inactive, resignation completed, sessions ended after commit. A changed last working day respects the payroll lock (`assertOpenFrom` from the day after the earlier date). Remove in Settings → Users leaves the same way: lifecycle lock after the roles lock, inactive, last day today (or an earlier one; none for a future joiner; kept as it was, with `payrollClosed` in the event, when that month is approved — `isOpenFrom`), open resignation completed, `exited` event. `notice_period` comes only from an accepted resignation (a contract end date leaves the stage alone until it passes → `exit_due`). Owner and "nobody could accept" resignations refused; notices use `reaching` (scope-aware); withdraw/call-off tell the approver and HR; any move in the tree (transfer, edit, Company Tree) tells the new approver about a waiting resignation (`tellNewApprovers`). The edit writes designation/department/last day/joining only when changed (no lost update) and the joining date goes through the same check. Employee export has Stage + `stage` filter.
  - **Knock-ons:** punch-in refused before joining/after the last day; leave preview `outside_employment`; payroll `employeesForMonth` and `findEmployeeBrief` include an archived leaver for their last month (was: a leaver archived mid-month was not paid); create/import take `confirmedOn` (`confirmed_on` column; not before joining, not in the future); editing the joining date moves a default probation end.
  - **Screens:** the employee's profile page `/employees/:id?tab=employment` → Employment (stage, dates, onboarding checklist, open resignation, step dialogs, history); Employees list Stage column + filter, `?open=<id>` still works (redirects to the profile); Home "Joining to exit" card (links to the Employment tab); resignations waiting for the login in Home's "Waiting for you" (Accept / Call off, every one listed); My Profile → My employment (resign, withdraw); Settings → Employee Lifecycle (HR reads, `settings:update` changes); Add Employee "Confirmed On"; notifications group Employment.
  - **Reviews:** two independent reviews (server, web) and a re-review of the fixes; every real finding fixed.
  - **Tests:** `lifecycle/lifecycle.test.ts` (34), `domain/org/lifecycle.test.ts` (8); E2E `lifecycle.mjs` 56 (desktop + 390px). The Day 20 E2E seed now gives its people lifecycle dates.
- [x] **Labour Codes wages rule** — built 3 Oct 2026 on `feat/wages-share-rule` (migration `20261003115245_wages_share_rule`; Neon must migrate). `OrganizationPolicy.wagesShareEnabled` (default false) and `wagesSharePercent` (default 50, 1–100), effective-dated like every rate and carried into new periods; Settings → Payroll Config "Labour Codes: Wages Rule" (toggle + %, the Super Admin's). `domain/payroll/salary.ts` `withWagesShare`: PF wages = max(countsForPf components, share × gross earned), compared in whole rupees (no paisa triggers), before the ceiling; `SalaryResult.wagesShare` {percent, wages, raisedTo} is set only when the PF base actually moved (not when the ceiling already took it all), lands in the payslip `basis.wagesShare`, and the payslip modal says "PF wages {pf_wages}: raised from … to X% of gross earned (…, up to the wage ceiling)". EPS membership tests the joining wages with the rule as it stood on the joining day (`wagesAtJoining`), so existing members never flip. % validated 1–100, two decimals. ESI/PT untouched (already on gross). A month uses the policy in force on its first paid day, so a change applies from the next month's payroll (said on screen). Payslip PDF unchanged (client sign-off). Tests: 12 domain (incl. ceiling, rounding, EPS split, joining wages), settings + payroll-run API tests; E2E `wages-share.mjs` 19 (desktop + 390px). Independent review done; its findings fixed. **What counts as PF wages** is a Super Admin switch — and, since V1 gaps, also Accounts' via Payroll → Components (Devesh, 4 Oct: both stay) per earning component (Settings → Payroll Config; `GET/PATCH /api/settings/pf-components`, `settings:read`/`settings:update`, audit `salary_component.pf_changed`, under the policy lock). Not effective-dated: a calculation after the change follows it, closed months keep their payslips. EPS membership is a fact about the person: `EmployeeStatutoryIdentity.epsMember` (migration `20261003142354_eps_member_recorded`), recorded by HR from the PF record on the employee form (Statutory Details, "Pension (EPS) Member?"); null lets payroll work it out (`isEpsMember` on the joining wages, with the wages rule as it was on the joining day) and warns when that excludes them. A recorded value holds through any change to the switches, ceilings or rule. Open for the accountant: whether Special Allowance should count.
- [x] **V1 gaps from the client PDF** — built 4 Oct 2026 on `feat/v1-gaps` (migrations `20261003184018_requests_and_personal_details`, `20261003191940_shift_rules_overtime_leave_loans_email`, `20261004032724_overtime_off_by_default`; Neon must migrate). One office, SaaS parts and branches (§9) out of scope. As built:
  - **Requests engine (§27–29)** `modules/requests` (`/api/requests`): `EmployeeRequest` (type attendance_correction | work_from_home | on_duty | overtime | profile_change | leave_encashment; status pending → approved | rejected | withdrawn; `number` → REQ-0042; details JSON; one attachment). Who decides each type is `Organization.<kind>Approver` (manager | hr; Settings → Approvals, `role:manage`): manager = the tree (`mayDecide`/`deciderOf`, standing in included), hr = permission + scope + `checkWork` per `HR_WORK` (attendance:update/attendance; employee:update/profile; leave:balance:manage/leave_balance). Owner auto-approved. Approval takes effect in its transaction (`takeEffect`): correction → `writeCorrectedDay`; profile → employee fields (audit keeps old→new); overtime and encashment → `payMonthFor` stamps `details.payYear/payMonth` (the OT day's month / this month, or the next open one; never past a leaver's last month — refused once that payroll is approved) under that month's `runLock`; encashment also `leave-apply` lock, re-check (incl. still encashable), ledger `encashed` −days. Payroll approval refuses (409) while an OT/encashment for the month was decided after `calculatedAt` (`payDecidedSince`); `calculatedAt` is stamped when the calculation STARTS reading. Overtime can be claimed while today's policy has `overtimeEnabled`; an approved claim is always paid at the pay month's rate. A correction needs both times on a day with nothing recorded, and a check-in alone must be before the check-out on record. Corrections refuse approved-leave days, keep holiday/weekly-off status, and read an at-or-before check-out as the next morning. Profile changes need `employee:update` + `employee:identity:read` (`HR_WORK.holds`) and are audited by field name only (the name keeps from/to). Exit and Remove close pending requests (`closePendingOf`). Pending encashments count as held in leave apply/preview and carry-forward. Locks `requests:<emp>`. Sending (POST /, attachment) needs `leave:apply` — one's own, like leave; Admin/Accounts role logins ask from the employee login (Day 23). `/all` = HR view scoped per type. Notices `request.submitted`/`request.decided`.
  - **Attendance (§31–34):** `Attendance.workMode` (office/wfh/on_duty/remote from an approved away request or `Employee.workArrangement`), `checkInDevice` (user agent), `lateMinutes`/`earlyLeavingMinutes`/`overtimeMinutes`. Shift rules on `Shift` (graceMinutes 0, lateThresholdMinutes null, earlyLeavingMinutes null, minFull/HalfDayHours null = 75%/50%, overtimeAfterMinutes 30) in `domain/attendance/shiftRules.ts` (`measureDay`, minutes from the date's midnight, >1440 next morning, ±12 h "far" guard), applied at punch-out, manual mark, correction and import. WFH GPS switch `Organization.wfhGpsRequired`. `GET /attendance/me/workplace`.
  - **Leave (§36–37):** `LeaveType` minNoticeDays, maxDaysPerRequest, eligibleAfterDays, eligibleGender, accrual (yearly | monthly — `grant.ts accruedBy`, by the leave's start month; `leave.service unearnedDays` in preview, apply under-lock check, balances `unearned`), halfDayAllowed, countsNonWorkingDays (balance only — payroll still counts working days), encashable + encashMaxDaysPerYear. Pure checks `domain/leave/rules.ts`. `LeaveRequest.halfDaySessions` {date: first_half|second_half}.
  - **Payroll (§35, §40):** policy `overtimeEnabled` (false — off until the company turns it on; `/attendance/me/workplace` says it so the app offers claims only then), `overtimeRate` (2), `overtimeBasis` (gross), `encashmentBasis` (basic) — effective-dated. `calculate()` adds `OT` (approved minutes, capped by the day's recorded overtime; hour = basis ÷ pay days ÷ the day's expected hours) and `LEAVE_ENC` (days × basis ÷ pay days; outside ESI) as monthly lines, and `LOAN`/`ADVANCE` deductions from `EmployeeLoan` (installment, capped by net pay; recovered = other months' `LoanRecovery` rows, which belong to payslips so a recalculated draft never recovers twice). `SalaryComponent.countsForEsi/countsForPt` feed ESI wages and the PT gross (`salary.ts`). Component CRUD `/payroll/components` (reserved codes PF ESI PT TDS OT LEAVE_ENC LOAN ADVANCE; kind fixed once used; archive refused while on a salary in force or an open month's entry); seed + migration add BONUS (no ESI) and COMMISSION. Loans `/payroll/loans` (`payroll:structure:*`, compensation scope, own goes up). Run readiness warns about pending corrections/overtime/encashment.
  - **Email (§45):** SMTP_* env (off until SMTP_HOST + SMTP_FROM); `notify()` queues `EmailOutbox` rows in the notice's transaction (per-event `NotificationSetting.email`, default on); `platform/email/outbox.ts` sender every 30 s per company via `forOrg`, 5 tries, purge after 30 days; `/notifications/email-status`. New events `employment.joined` / `employment.left` (`peopleNotices.ts`).
  - **Audit (§47):** `employee.updated` keeps `changes` {field: {from,to}} for the work record (contact/personal/statutory named only); shift, leave type and component edits keep `before`; `catalogue.ts beforeAfter`.
  - **Reports (§46):** `shift-overtime`, `requests`; every report now needs its own permission (attendance:read, leave:read, payroll:structure:read, employee:read) and is limited to that scope (`REPORT_ACCESS`), on top of `report:read`.
  - **Personal details (§42):** dateOfBirth, nationality, address, emergency contact on `Employee` (shown with identity read or to the person); My Profile → My Details → "Request an update" (a profile change; its values are shown only to the person and to whoever reads personal details — a manager deciding it sees which fields).
  - **Tests:** `requests.test.ts`, `payroll/v1Extras.test.ts`, `platform/email/outbox.test.ts`, `domain/attendance/shiftRules.test.ts`, `domain/leave/rules.test.ts`, accrual and ESI/PT-flag domain tests; full suite 73 files / 1431 tests. E2E `v1gaps.mjs` 35 and `v1gaps2.mjs` 43 (desktop + 390px), plus every earlier suite on the final build. Three independent reviews and a re-review; every verified finding fixed.
- [x] **Final audit** — 4 Oct 2026 on `chore/final-audit` (no migration). Requirements traced section by section in `docs/REQUIREMENTS_TRACEABILITY.md` (what is built, where, which test proves it, what is open). Five independent reviews (attendance, leave/lifecycle, payroll, access control ×3); every verified finding fixed or listed as open. Decisions in memory `final-audit-decisions`.
  - **Fixed:** night shifts (check-out next morning, check-in after midnight, the card after check-out; a night's day lasts until 12 h past its end or 2 h before the next start, whichever is first; a day shift left open carries over only until 3 h before the shift starts again — `openDayCarries`); app check-in only for `attendanceMode = app`; approved leave days (whole day refuses punch/mark/correction/import; a half day grades the worked half from the middle of the shift for the leave's session — `forWorkedHalf`); past days graded on the shift they were recorded on (`gradedBy`); import with one time is present, never absent; mark/import refuse days outside employment; PATCH of one's own/a fellow HR person's/a senior's record goes up the tree (`assertMayChangeRecord`; the Super Admin is exempt); bank accounts: entering one's own/fellow's/senior's goes up, the person gets a non-optional `bank.changed` notice, only the Super Admin lets the bank file pay unchecked accounts; ESI tested on ESI wages, a salary first recorded mid-period tested on that day (`first_wage_in_period`), re-decided while the period is open if the test day's wage changes; EPS stops at 58 (birthday month flagged); mid-month salary change warned on the payslip; leave may not cross the leave-year start; leave after the last working day settled on accept/exit/remove/last-day edit (`settleLeaveAfter`, the person is told); join/leave notices only to logins that decide; import PAN needs identity read; an employee cannot remove a document HR filed; balance corrections count days waiting to be encashed.
  - **Screens that were missing:** biometric attendance import (the Day 12 API had none), hours worked per person per month (Attendance → Monthly, with month navigation for HR too) and on the employee dashboard; the roster import takes a `shift` column.
  - **E2E now in the repo:** `e2e/` (`npm run e2e`, `e2e:all`, `up`, `seed`, `demo`, `perf`; see `e2e/README.md`). `golden.mjs` walks day 0 to month end on an emptied database (65 checks). The demo company (`npm run demo`, `e2e/DEMO.md`, `demo-tour.mjs` 105 checks) has all seven roles. Drift check (migrations vs schema) clean; backup drill passed on `ems_e2e`.
- [x] **New look** — 5 Oct 2026 on `feat/new-look` (no migration; Neon needs nothing). The approved design (logo colours, Keka-style layout; `.claude/style.md`) on every screen, the dashboard fixes, and every bug met on the way. As built:
  - **Shell:** white top bar (logo, search Ctrl K, bell, user menu with My Profile and Sign Out — Escape closes it; phone: the role beside the avatar), slim plum sidebar (icon over label), phone bottom tab bar + More + Menu drawer. Pieces in `web/src/components/ui` (`styles.js` btn/card/field/th/td, `bits.jsx` Card/StatTile/Chip/Avatar/Ring/EmptyState, `PageHeader` with `role="tab"` tabs in `?tab=`, `Segmented`, `ProfileCover`). A titled `Card` and a settings `Section` are regions named by their title.
  - **Pages:** Home made of sections by permission (Waiting for you — leave, requests and every resignation, Accept/Call off; failed lists shown; Leave waiting for others' decisions for a leave reach beyond one's own (session `leaveReach`); My month beside Check In with how the days are recorded; Accounts' payroll cards); the employee profile is a page `/employees/:id?tab=` (`?open=` redirects; the list's search/filters/sort live in its address and survive the visit; no Edit once somebody has left); My Profile a page with tabs; Attendance — the employee's own page (punch, month figures, timings, log/calendar with days off from `GET /attendance/calendar`, requests) and the roster/month for a reach beyond one's own (decided by the session's `attendanceReach`); Leave, Requests (kind chooser `?new=`), Payroll, Documents, Reports, Settings (grouped sections) restyled. Date Format setting removed (one format; the validator refuses `dateFormat`).
  - **Fixed on the way:** requests no longer readable by somebody who once decided them; a fellow HR person's unaccepted resignation hidden (`notTheirs`); an employee login narrowed to its own rows whatever the Employee role's scopes (`ownThingsOnly`); **every pay input checks its month under the month's payroll lock inside its own transaction** (`payrollLock.service` with `tx`; month locks after the person's own locks — lifecycle, requests, leave-apply — before any row is written, earliest first), and approval holds the lock from comparison to move; the connection pool sized to 20 (`platform/db/prisma.ts`); the attendance calendar draws a month by the weekly offs in force as it began, as payroll counts it; today-at-work shows leave only with `leave:read` in the leave scope; dashboard weekly off defaults to Sunday; dialog footers wrap on a phone; instants on the company clock.
  - **Follow-ups (5 Oct, Devesh's go-ahead):** a payslip warning for a PF member with no date of birth (EPS cannot stop at 58) and `date_of_birth` in the roster import (identity read, as PAN); the mid-month salary warning gives the arrears figure (`domain/payroll/payDays.ts` `arrearsFor`, the company's pay-day basis; each of several changes for its own days, none after the last working day, "already entered" once Arrears is entered, a cut as an overpayment), a default monthly **Arrears** component (`referenceData.ts`; PF off until the accountant says), and the salary form's hint with "Start on the 1st instead"; tabs answer ← → Home End with only the chosen tab in the Tab order, and name their panel (`components/ui/Tabs.jsx` `TabPanel`, `tabKeys.js`).
  - **Tests:** server 74 files / 1497 tests; E2E on the final build — day18 66, day18b 25, day18-tds 12, day19 165, day19b 43, day20 258, day21 85, day22 45, day23 77, lifecycle 58, wages-share 28, v1gaps 36, v1gaps2 45, `newlook.mjs` 246 (the frame as every role, desktop and 390px, dialogs from links, the profile page, the calendar's days off, the review fixes, tabs from the keyboard, the salary hint, a date of birth in the roster), sweep23 322 page views / 0 issues, demo-tour 105. `golden` 65 (on an emptied ems_e2e, Devesh's consent of 5 Oct). Three independent reviews and a re-review; every verified finding fixed.
- [x] **Holiday card** — 5 Oct 2026 on `fix/holiday-card` (no migration). A new company has only the three fixed national holidays, so after 2 Oct Home's card showed January next as "next" with no word why. Now: "No more holidays entered for <year>." once this year's are behind, and an **Add holidays** link to `/settings?tab=leave#holidays` for `holiday:manage` only (also on "No holidays ahead"); the rows carry the whole date ("Sun, 15 Aug 2027"). Settings' `Section` takes an `id`; the Holidays section scrolls itself into view and takes the focus from that link, held for 3 s while the sections above load, unless the person scrolls, clicks or types. E2E `holidays.mjs` (none left / some left / none ahead, HR·SA·Employee·Manager, phone, a holiday added in Settings on Home at once, the calendar put back).
- [x] **HR sets passwords (client point #3)** — 6 Oct 2026 on `fix/holiday-card`. **Migrations `20261006020727_hr_sets_passwords` and `20261006093000_spend_old_password_links` (data only: links out before then spent, a Super Admin's kept) — Neon must migrate.** HR types a new employee's Employee ID and password (nothing generated) and the login works at once; the employee cannot change it, HR sets a new one; a role login's is the Super Admin's alone; a Super Admin's own is always theirs. Built as settings with the client's defaults: `Organization.employeePasswords` / `rolePasswords` (`PasswordSetter` company | self, default company) and `passwordMinLength` (8–64, default 10), on **Settings → Users & Roles → Passwords** (changed with `role:manage`, read with `settings:read`); `self` brings the links back. `User.email` nullable: an employee login may have none and signs in by Employee ID (matched case-insensitively; codes differing only in case refused — `freeEmployeeCode`); role logins need an email. New permission `user:password:set` (Super Admin, HR; backfilled + trigger regenerated): `POST /api/users/:id/password` (`setPassword`: never one's own, a role login only by a locked actor, `mayManage` + reach + `assertOtherLoginsBelow`; bumps tokenVersion, revokes refresh tokens, spends links, activates an invited login, audit `user.password_set`, bell "A new password was set for you"); `GET/PUT /api/users/password-rules` (audit `user.password_rules_updated`; switching a kind to company spends its links for good). Logins start `password` | `link` | `none` (`loginStartFor`), in Add Employee, Add user, a person's Logins (HR may add an employee login to somebody below with none) and the import (waits, `waiting_for_password`). Change-password, link issue/inspect/redeem and `npm run reset-link` refuse company-set logins, naming who sets it. For somebody with two logins the Employee ID now opens the **employee** login. After two independent reviews: a Super Admin's passwords are all their own (`passwordSetBy(…, { holdsSuperAdmin })` in the session; `setPassword` lets a locked actor set their own *other* login's, never the one in use); in `self` mode nobody sets it for them (409); the rules are read and changed under `rolesLock`; Employee IDs are taken under a per-ID lock (`employeeCodeLock`, the import too), the clash names nobody, and `@` is refused; a login with no email cannot be given a role; HR's Add login needs every login of the person below HR; `/roles/assignable` sends `login_kind` (and accepts `user:password:set`); `has_password` is read from the hash; Settings opens HR on Leave Config still (`notLanding`). Domain `domain/org/passwords.ts`; web `lib/logins.js`, `PasswordFields`, `SetPasswordDialog`, `PasswordRules`; session carries `loginKind`, `passwordSetBy`, `passwordMinLength`, `passwordRules`; rows `login_kind`, `has_password`. Link-era E2E suites switch the rules to self first (day19, day20, day23); `passwords.mjs` covers company mode; `golden` follows the new default. A third review: Prisma's case-insensitive `equals` is ILIKE with the value as a pattern ("CMS0_1" matched CMS001, "%" everybody) — every such lookup now goes through `platform/db/insensitive.ts` `equalsInsensitive` (escapes the backslash, `%` and `_`), sign-in and the ID check also compare the rows exactly; changing the rules is the Super Admin's alone (`PUT /users/password-rules` needs `role:manage`); nobody sets a password of a person holding the Super Admin panel but that person (409); an unchanged Employee ID is not checked again on edit; the no-email role-change refusal comes after the ownership ones; own-login refusals are 403. **Tests:** server 77 files / 1547; E2E on the final build — day18 66, day18b 25, day18-tds 12, day19 165, day19b 43, day20 258, day21 85, day22 45, day23 77, lifecycle 58, wages-share 28, v1gaps 36, v1gaps2 45, sweep23 324 page views / 0 issues, newlook 246, holidays 34, `passwords.mjs` 85; demo-tour 105. `golden` 70, rewritten for the new default (the Super Admin types the role logins' passwords, HR sets the imported employees', the owner sets his own from his link), on an emptied ems_e2e with Devesh's consent of 6 Oct.
- [ ] **Deploy ← in progress** — onto the client's Docker + shared-Caddy box (`187.77.96.52`, `/srv/ems`, no published ports). Phases in `deploy/DEPLOY.md`, "Still to build"; each starts only on Devesh's word.
  - **Phase 1, packaging — done 5 Oct 2026 on `feat/deploy-docker`** (no migration). `deploy/api.Dockerfile` (Node 22 Debian 13, all deps — the jobs run tsx, migrations need the Prisma CLI; `pg_dump` 17; supercronic pinned by SHA-1), `deploy/web.Dockerfile` (Vite build → Caddy 2.11 on :8080, `setcap -r` so it runs with no capability), per-Dockerfile allow-list `.dockerignore`s, `deploy/web/Caddyfile` + `security-headers.caddy` (the one headers source; `e2e/scripts/web.mjs` reads it), `deploy/compose.yml` (`db` postgres:17-trixie + init `postgres/10-ems-role.sh` making a non-superuser `ems` with CREATEDB; `api` (alias `ems-api`); `jobs` = supercronic + `deploy/crontab`; **`ems-web`** — on the shared `edge` only `ems-` names, so nothing answers for the other project's `web`/`api`; non-root, read-only, caps dropped, tmpfs owned by the image users, mem limits, log caps; optional settings passed by name only), `deploy/env.example`, `deploy/deploy.sh` (lock → ask the DB → stop api+jobs → backup → `previous` = last healthy (`good`), `current` = new → migrate → `up --wait` → `good`; failed migration puts every tag back; prune keeps the 3 highest versions and those in use; `--rollback`, `--status`), `deploy/build.sh` (`-dirty` revision on trial builds), and the laptop rehearsal `deploy/local/` (stand-in edge with local certs on https://localhost:8443). Server: `TRUST_PROXY_HOPS` (default 1, empty = default; the E2E stack pins 1; compose sets 2); `/health` now asks the database (`platform/db/health.ts`, 503 if it does not answer). Old Nginx/PM2 files removed; DEPLOY.md rewritten. `e2e/scripts/web.mjs` reads `deploy/web/security-headers.caddy` strictly; 404s `no-store`, dot-paths 404.
  - **Rehearsed end to end:** deploy, redeploy, the lock, rollback ×2, a broken migration (undone whole; P3009 until `migrate resolve --rolled-back`), a version that never came up healthy then a fix (`previous` skips the bad one), a failing backup and a database that would not answer (nothing changed, site up), backup/list/drill/restore + rename swap, crontab under supercronic, the real visitor IP through both proxies (the edge's with 1 hop), decoy `api`/`web` on `edge` ignored, edge cannot reach api/db, crash restart, graceful stop, Docker restart; `e2e/suites/rehearsal.mjs` 38/38 over HTTPS on a fresh box; server 75 files / 1500 tests (and the suite as it stood, 1497, on Node 22 in UTC inside the image); day20 258 and newlook 246 on the rebuilt stack (day20 now re-signs in after 12 minutes, and reads Team Balances from its own panel). Not yet run (step 4): R2, the real box and edge, a reboot of the box, IPv6 visitors.
  - **Phase 2, CI — built 7 Oct 2026 on `feat/ci`.** `.github/workflows/ci.yml` on pull requests, pushes to `main` and by hand: **server** (Postgres 17 service on localhost, `migrate deploy` from the first, `tsc --noEmit`, `npm run lint` §A5, the field contract regenerated and diffed, `npm test` — with `TZ=UTC`, as the containers run; checked on the laptop first: 77 files / 1547 under UTC), **web** (lint, build), **images** (`deploy/build.sh v0.0-ci.<run>`, not pushed). Node 22, no secrets (throwaway DB; JWT keys in the file are CI-only), so it runs on `priyanshu3372/EMS` now and moves with the repo; after the move: allow Actions in the org, require CI on `main`. The browser suites stay on the laptop (Edge on Windows). `scripts/fieldContract.ts` now orders files by their `/` path and keeps `generatedAt` when nothing else changed, so a regenerate in CI finds no difference.
  - **Next:** 3 Caddy block (domain), 4 first deploy (SSH, domain, R2, SA email, passphrase keeper), 5 CD, 6 the client's go-live guide. Then tag `v1.0`

---

## Two databases

| | Where | Used by |
|---|---|---|
| Development | **Neon** (`.env`) | `npm run dev`, prisma studio, bootstrap |
| Test | **local Postgres 17** (`.env.test`) | `npm test` |

`.env.test` is loaded ON TOP of `.env` when `NODE_ENV=test`, so it overrides only
the two database URLs — secrets stay in `.env` alone.

**The suite refuses to run against a non-localhost database** (`vitest.setup.ts`).
It deletes rows; that guard is what stops a forgotten `.env.test` from pointing it
at Neon, or worse.

Why not use Neon for both: measured from here it answers in **~2.5 seconds per
query**. The same suite takes 283s on Neon and **23s** locally. A test suite nobody
is willing to wait for stops being run.

New machine: install Postgres 17, create the `ems_test` database, copy
`.env.test.example` to `.env.test`, then `npm run db:test -- migrate deploy`.

---

## Workspaces

```
EMS/
├── web/       React 19 + Vite + Tailwind v4 · JavaScript · Zustand · TanStack Query
└── server/    Express 5 + TypeScript · Prisma + PostgreSQL
```

**Two `package.json` files.** Always `cd web` or `cd server` first — Prisma lives only under `server/`.

### Pinned versions — do not let these drift

| | Version | Why it matters |
|---|---|---|
| Node | 20.20.0 | Prisma 8 needs Node 22+; we are on 6.x |
| Prisma + @prisma/client | **6.19.3, identical** | CLI and client must match exactly |
| Express | **5.x** | The single-error-handler contract depends on Express 5 forwarding async rejections |
| Zod | 4.x | v4 API — `z.url()`, not `z.string().url()` |
| TypeScript | 7.x | Server only; the frontend stays JavaScript |
| nodemailer | **10.0.14+** | Ships its own types (no `@types/nodemailer`); 7.x–10.0.5 have SMTP-injection advisories |

---

## Server architecture

```
server/src/
  http/       routes · controllers · middleware · validators · serializers
  modules/    <feature>.service.ts · .repository.ts · .policy.ts
  domain/     PURE functions. No Prisma, no Express, no I/O
  platform/   db · authz · auth · storage · errors · logger
```

Direction is one-way: `http` → `modules` → `domain`. Never the reverse.

### Rules enforced by lint and tests

1. Only `platform/db/scoped.ts` and `unsafe.ts` may import the raw Prisma client
2. `ctx.db` appears only in `*.repository.ts`
3. `req` / `res` never appear below `http/`
4. `domain/` imports nothing from the project
5. Never compare `role === 'hr'` — only `can('payroll:run:create')`
6. Serializers are allow-lists (`pick`, never `omit`) with no `??` / `||` fallback for business data
7. No statutory constant (`0.12`, `21000`, `15000`, …) outside `domain/`
8. No `toISOString()` outside `domain/shared/dates.ts`

### Non-negotiables

- **`errorHandler.ts` is the only file that sends a 4xx or 5xx.** Everything else throws an `AppError`
- **Never fabricate data.** A missing payslip is a 404, not a placeholder. No invented defaults, no `?? 12` fallbacks. The current app does this everywhere and it is the deepest bug in the product
- **Every response uses the envelope** — `{ data, meta }` or `{ error }`
- Multi-table writes go in a transaction
- Every tenant table carries `organizationId`, and every unique constraint includes it

---

## Frontend conventions

- JavaScript, not TypeScript. Tailwind for styling — see [style.md](./style.md)
- `web/src/api/` is the only place that talks to the network; hooks call it
- Hooks kept their names and return shapes through the cutover, so pages did not change with them
- **The API emits `snake_case` for v1.** Leave requests carry `full_name` / `employee_code` / `department` at the top level; there is no nested `profiles` key
- A screen renders a query through `components/DataState.jsx` (`DataState`, `DataRows`, `QueryError`): an error is never shown as an empty list or a zero. A `<select>` fed by a query uses `lib/optionsNote.js`
- "Are you sure?" is `components/ConfirmDialog.jsx`, never `window.confirm`. Days are formatted by `lib/dates.js` (`formatDay`, `formatDayOf`, `formatInstant`), whose fixed month table always gives "Sep", never "Sept"
- A mutation's `onSuccess` **returns** its invalidation promise, so a dialog closes only after the list shows the change
- A role is shown by the name the server sends (`roleName` in the session, `role_name` on users and employees) through `lib/roles.js` `roleLabel(key, name)`. A role picker offers `GET /api/roles/assignable` (`hooks/useRoles.js`), never a list typed into the page

---

## Domain notes

7 built-in roles: `super_admin · admin · hr · manager · rm · accounts · employee` — see [Role_Permission_Documentation.md](../Role_Permission_Documentation.md) §3 for the starting matrix and scopes (§12 is a manual QA checklist, not the matrix). Since Day 21 roles are rows in the `Role` table: the Super Admin edits them and adds more, so code never assumes the list. The starting definitions are `platform/authz/defaultRoles.ts`; a database trigger copies them into every new company, and `roles.test.ts` checks that the two match. A new permission reaches no company's roles until a migration gives it.

India payroll: PF 12% with the ₹15,000 wage ceiling and the EPS split · ESI 0.75%/3.25% with eligibility **locked per contribution period**, not re-tested monthly · PT is **per-state, per-employee** · TDS is manual-entry for v1.

Do not hardcode any of these — they live in `OrganizationPolicy` and `PtSlab`.

---

## Known-bad references

- `SYSTEM_DESIGN_AND_AUDIT.md` §1–6 are valid findings; **§7 is superseded** by the build guide
- The current `web/` code contains the 438 audited problems. Assume anything you read there is suspect until checked

## Commands

```bash
cd server && npm run dev        # API on :4000
cd web    && npm run dev        # UI on :5173

cd server && npm run typecheck  # tsx does NOT type-check
cd server && npm test
cd server && npx prisma studio

cd server && npm run bootstrap  # first org + admin. Runs once, refuses after

cd server && npm run storage:check          # put/get/list/delete against the configured storage (local or R2)
cd server && npm run maintenance            # dry run: orphaned files, old notifications
cd server && npm run maintenance -- --apply # actually remove them (nightly on the server: deploy/crontab)

cd server && npm run grant-leave            # grant the leave year from the terminal (HR does it in the app: Leave → Team Balances)
cd server && npm run backup                 # dump → sealed → storage (backups/db/), then prune
cd server && npm run backup -- --list       # what backups exist
cd server && npm run restore -- --target-db <empty db>   # never over the live one
cd server && npm run backup:drill           # backup, restore into a scratch db, check every table, drop it

cd server && npm run db:test -- migrate deploy   # migrate the TEST database
cd server && npm run db:test -- migrate reset    # wipe and rebuild it
```
