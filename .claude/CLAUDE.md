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
- [ ] **Day 21 ← next** — **Roles & Permissions, for the Super Admin.**
  - **Database.** A `Role` table per organization holds each role's name, the role it comes under, its permissions, and a scope per module. `Membership.role` (the Prisma enum) becomes a link to that table. The migration maps every existing login to its seeded role, so nobody's access changes.
  - **Seeds.** The seven current roles, as they are today, with "reset to default". The seeds carry the client's changes:
    - HR loses `leave:approve` (Day 22 moves approving to the tree).
    - Entering and changing salaries stays with Accounts (`payroll:structure:manage`). One person agrees a salary and another enters it.
    - HR's salary view (Devesh, 1 Oct 2026: HR negotiates salaries) is seeded on Day 22, together with the "company, except people above me" scope it needs. No build in between shows a senior's pay.
  - **Server.**
    - **Permissions and scopes are read from the role table on every request.** The server already reads the current role there (`authenticate.ts`), so a change applies at once, without a fresh login.
    - **API** to list, create, edit, reset and delete roles, and to give a role to a login.
    - **Role order.** Each role says which role it comes under, and the Super Admin is always at the top. A user can give only a role below their own. They can manage (reset a password, deactivate) only accounts whose role is below their own. This replaces today's "more access than your own" comparison.
    - **Guards.** The Super Admin role cannot be edited or removed, and at least one Super Admin always remains. Nobody edits a role they hold themselves. A role in use cannot be deleted. A warning appears when one role would both prepare and approve payroll. Every change is written to the audit log (new catalogue entries).
    - Salary becomes a scoped module of its own. Today `employee:compensation:read` is unscoped.
  - **Screens.** Settings → Roles & Permissions:
    - The list of roles, with how many people hold each and the order they come in.
    - The editor: permissions ticked per module, in plain words; a "whose information" choice per module (own, my team, department or company; the tree choices join on Day 22); and the role it comes under.
    - A preview of what the role will be able to do, before saving.
    - Reset to default, delete (refused while the role is in use), and every guard's message in plain words.
    - The four hardcoded role lists read from the API. A custom role shows its own name everywhere: top bar, sidebar, profile, Users and the audit log.
  - **Tests.** `authz.test` keeps testing the seven defaults. The whole server and E2E suite must pass against the seeded roles before any custom role is tried. New tests cover custom roles, scopes, the role order and every guard, plus E2E for the editor.
- [ ] **Day 22** — **The company tree, approvals that follow it, and "your own work goes up".**
  - **Database.** The owner mark, on exactly one person. The approval settings, with the client's defaults. (`reportingManagerId` already exists.)
  - **Server — the rules:**
  1. **The company tree.** Each person reports to exactly one person, and the Super Admin sits at the top and sets the tree. Role holders sit in it like everybody else. The tree cannot loop (A under B under A). People with nobody above them are listed, so the Super Admin can place them.
     - Two new scopes: everybody under me at every level, and company except people above me.
     - HR's salary view is seeded now, with the "company, except people above me" scope.
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
- [ ] **Day 23** — **Two logins, one person** (the client's choice), **and the wrap-up of Days 21–23.**
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
- [ ] **Deploy** — onto the client's Docker + shared-Caddy box (`187.77.96.52`, `/srv/ems`: API, web and Postgres containers, no published ports). Still needed: the Dockerfile, compose file, Caddy block, **CI** (tests on every push/PR) and **CD** (deploy on a version tag, backup first, rollback by tag), and a rewritten `deploy/DEPLOY.md`; the domain, R2 keys and SSH access. The order is in `deploy/DEPLOY.md`, "Still to build". Then tag `v1.0`

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

---

## Domain notes

7 roles: `super_admin · admin · hr · manager · rm · accounts · employee` — see [Role_Permission_Documentation.md](../Role_Permission_Documentation.md) §3 for the matrix (§10 is a manual QA checklist, not the matrix).

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
