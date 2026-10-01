# EMS — Technical Audit & Target System Design

**Product:** CareerMap Solutions' single-company HR & Payroll system
**Purpose:** make this product genuinely production-grade and client-delighting, before any multi-tenant/SaaS work is considered
**Companion docs:** ROADMAP.md (removed on 30 Sep 2026; it is in git history) (strategy) · [EMS_BUILD_GUIDE.md](EMS_BUILD_GUIDE.md) (current architecture + build plan) · [Role_Permission_Documentation.md](Role_Permission_Documentation.md) (intended RBAC)

---

## 1. Executive summary

The UI is genuinely good — nine pages, ~10,700 lines, a coherent dependency graph, a sensible Postgres schema, and RLS enabled on all 11 tables. This is not a bad codebase.

But it has never actually been run against its own database.

Because there is no `.env`, the app runs on a hand-written mock Supabase client (`src/lib/supabase.js`, 556 lines) backed by `localStorage`. That mock is **schemaless and forgiving**: it accepts any column, any RPC argument, and fakes every join. Postgres is neither. The frontend and the database were built in parallel against each other's assumptions and were never reconciled.

Three consequences, each independently blocking:

> **1. The switchover breaks the product.** Connect a real `.env` and roughly a dozen core workflows fail immediately — Add Employee, Mark Attendance, the entire Leave list, bank verification, salary structures, document upload, and every approver notification.
>
> **2. The system cannot be stood up at all.** There is no code path anywhere that creates the first `super_admin`. There is no way to enter opening leave balances for existing staff. There is no bulk import. Day one is unreachable.
>
> **3. Every business rule lives in the browser.** Fourteen rules — leave balances, payroll totals, the geofence, role assignment, bank verification — have no database constraint, trigger or RLS policy behind them. The browser is the only thing enforcing them, and it can be bypassed with one devtools request.

Layered on top are five independent paths by which an ordinary employee becomes Super Admin or reads every colleague's salary and bank account.

**The good news:** none of this needs an architectural rewrite. The work is (a) reconcile the app↔database contract, (b) move business rules into the database, (c) close the security holes, (d) build the missing bootstrap path. That is roughly 4–6 focused weeks.

**The uncomfortable news:** the demo passes. Every one of these problems is invisible today, because the app is built to fabricate data rather than surface absence. That is the deepest finding in this document, and §5 is devoted to it.

---

## 2. Audit scope and confidence

Twelve subsystem areas were audited by independent agents across three passes, then supplemented by two critics hunting for what the per-area passes structurally could not see.

| # | Area | Findings |
|---|---|---|
| 1 | Auth, routing, RBAC | 22 |
| 2 | Mock Supabase client & switchover | 25 |
| 3 | DB schema & migrations | 32 |
| 4 | RLS & backend authorization | 25 |
| 5 | Edge functions & privileged operations | 23 |
| 6 | Data layer (TanStack Query hooks) | 27 |
| 7 | Payroll module | 32 |
| 8 | Employee management module | 29 |
| 9 | Attendance & Leave (incl. geofencing) | 40 |
| 10 | Dashboards / Reports / Settings / Notifications / Documents | 48 |
| 11 | Documentation drift & repo hygiene | 28 |
| 12 | Frontend quality, dependencies, accessibility | 33 |
| — | Completeness critic (day-one, scale, zero-state, concurrency, time) | 39 |
| — | Cross-cutting critic (inconsistency, duplicated rules, trust boundaries) | 35 |
| | **Total** | **438** |

Roughly 60 are rated critical and 100 high by the agents that raised them.

### 2.1 Confidence — read this before acting on any single finding

**No finding was adversarially verified.** The verification pass was designed but every verifier agent died on a session rate limit. A workflow summary line reporting "24 refuted" is an artifact of those failures, not a real refutation.

What *does* support these findings:

- **I personally verified about twenty of the highest-impact ones** by direct reading of `schema.sql`, `policies.sql`, `migration_v2.sql`, `migration_v3_notifications.sql`, `App.jsx`, `ProtectedRoute.jsx`, `Layout.jsx`, `Sidebar.jsx`, `useEmployees.js`, plus targeted greps. Those are marked *(verified)* below.
- **Several agents produced empirical evidence**, not just reading: one ran `vite build` twice (with and without env vars) and grepped the output bundles; another executed the mock query builder under `node` to reproduce a crash; the frontend agent ran `npx eslint .` (it passes clean).
- Every finding carries a `file:line` citation, so each is cheap to check.

**Explicit limits, stated by the auditors themselves:**
- Nothing was verified against a live Postgres. Every claim about RLS outcomes is read off `policies.sql` and the PostgREST contract, not observed.
- The edge functions were read but never invoked.
- No runtime browser verification — crashes such as the `Documents.jsx` white-screen are reasoned from source.
- ~180 lines of `config.toml` (analytics, pooler, edge_runtime, OAuth) were not audited.

**Recommendation:** treat §4 as a prioritised worklist, not as gospel. The first engineering task in §7 P1 — apply the migrations to a real database and walk every workflow — will confirm or kill most of these in an afternoon.

---

## 3. What has actually been built

`.claude/plan.md`, the progress tracker this finding was written against, was inverted in both directions for 5 of 7 modules; it simultaneously claimed the auth guard was restored (§13) and that it still needed restoring (§179). It has since been deleted for that reason — `git show 0d3f381:.claude/plan.md` recovers it. The accurate picture at the time of audit:

**Working (against the mock):** 9 pages · 8 TanStack Query hook modules · a split HR/Employee dashboard · a notification panel with a realtime subscription · a profile drawer · a 591-line bank-verification flow · GPS geofencing wired into attendance check-in · an 11-table Postgres schema with CHECK constraints on every enum and correct FK `ON DELETE` choices · RLS enabled on all 11 tables using the correct `SECURITY DEFINER` helper pattern · two edge functions that do server-side authorization properly.

**Built but non-functional against real Postgres:** Add Employee · Mark Attendance · Leave list & approvals · Bank verification · Salary structures · Document upload · All approver notifications · Employee-ID login · Password reset · Company documents.

**Not built at all:** First-admin bootstrap · Opening leave balances · Bulk employee import · Department master data · Holiday management · Audit log · Settings persistence · Year-end rollover · Half-day leave · Payslips derived from attendance · Employee self check-in · An employee route to their own payslip · Termination dates · Real PDF payslips · Email delivery · Any test of any kind.

---

## 4. What is genuinely well done

Worth protecting during the fixes:

1. **Role is never trusted from the browser.** `authStore` has no `persist` middleware; the role is re-fetched from `profiles` on every load (`App.jsx:17-25`). A user cannot elevate by editing localStorage. *(verified)*
2. **`ProtectedRoute` fails closed** (`ProtectedRoute.jsx:6`) — an unknown or null role redirects rather than granting access. *(verified)*
3. **No guard race.** `Layout.jsx:24-36` returns a spinner while `loading` and never renders `<Outlet/>`, so nested guards never see a null role. No flash of restricted content on hard refresh. *(verified)*
4. **Edge functions authorize correctly** — they verify the caller's JWT, then re-read the role *from the database* with the service key rather than trusting a claim or the request body (`manage-user/index.ts:30-48`), and block self-modification.
5. **Payroll RLS isolation is correct** — `payroll_runs` is invisible to everyone except `super_admin`/`accounts`.
6. **The payroll table shapes are right** — `unique(month, year)` and `unique(employee_id, payroll_run_id)` are exactly the correct idempotency keys, and payslips are stored as immutable denormalised rows rather than re-derived at view time. The app just doesn't use them properly.
7. **Query keys are hierarchical and collision-free** — `['attendance', date]` vs `['attendance','month',y,m]` allows prefix invalidation.
8. **The dependency graph is coherent.** React 19.2.4, Vite 8.0.16, Tailwind 4.2.2, lucide-react 1.7.0, recharts 3.8.1, TanStack Query 5.95.2 — every declared peer range was checked and satisfied. `package-lock.json` is committed. `npx eslint .` passes clean. No secret is committed; `.gitignore` correctly covers `.env` and `dist/`.
9. **Every table is wrapped in `overflow-x-auto` with an explicit `min-w`** — horizontal scrolling is deliberate, and the page body never scrolls sideways.
10. **`useUsers.js` and `BankVerificationModal.jsx` are the quality bar** — the only hook that projects explicit columns instead of `select('*')`, and the only call site with proper `try/catch` + error display + pending state. Both should be the template for everything else.

---

## 5. Root causes

Four causes explain almost all 438 findings. Fixing the causes is cheaper than fixing the symptoms one at a time.

### RC1 — The mock client became the de-facto specification
The frontend was written against a schemaless localStorage mock; the schema was written separately. Nothing ever reconciled them, and nothing could, because the mock accepts everything.

This alone produces: the RPC signature mismatch, five sets of missing columns, the ambiguous embed, the `-31` date bug, the `demo-*-id` notification targets, and the Employee-ID login that cannot work under RLS. Roughly 40 findings.

### RC2 — Every business rule lives in the browser
The cross-cutting critic enumerated **fourteen** rules enforced only in client JavaScript, with no DB constraint, trigger or RLS policy behind them — including the number of leave days deducted, leave-balance sufficiency, payroll totals, the payroll state machine, the geofence, role assignment, and bank verification.

Postgres accepts whatever the browser sends. Anyone with devtools can send something else.

### RC3 — The app fabricates rather than surfaces absence
This is the deepest cause, because it is why RC1 and RC2 went unnoticed.

When data is missing, this codebase invents plausible data instead of showing an empty state or an error:

| Where | What it fabricates |
|---|---|
| `Payroll.jsx:393-400` | A full set of payslips, each badged green **"Generated"**, when none exist |
| `PayslipModal.jsx:76-77` | Statutory identifiers — a PF account `MH/BOM/12345/001`, a GSTIN, a pay date — identical for every employee |
| `useReports.js:144` | A **UAN fabricated from the employee's PAN** in the statutory PF/ESI report |
| `useReports.js:182-189` | A 6-month payout trend, defaulting to a literal `410000` when no run exists |
| `useDashboard.js:166-170` | A complete leave entitlement (12/12/18/24/5) when no balance row is readable |
| `Documents.jsx` | A *"Government of India — UIDAI · OFFICIAL COPY"* card, which HR then clicks Approve on |
| `BankVerificationModal.jsx:534-572` | A **cancelled cheque the app draws itself**, which the verifier approves against |
| `Settings.jsx:501,578,722` | `handleSave(){ setSaved(true) }` — a "Saved!" toast that persists nothing |
| `Payroll.jsx:777` | A "Payroll Status" KPI hardcoded to the string `'Draft'` |

Combined with **zero `onError` handlers in the entire codebase** (grep for `onError|onSettled|onMutate` → 0 matches), `useDashboardStats` discarding all four `{ error }` fields, `sendNotification` swallowing errors into `console.error`, and PostgREST returning success for RLS-denied updates — the product is *structurally incapable of telling anyone it is broken.*

### RC4 — The system was never stood up end to end
Nobody has ever created a first admin, imported real staff, set opening balances, or run a real payroll month. That is why the day-one gaps in §6.5 exist, and why none of RC1–RC3 was caught.

---

## 6. Findings by class

### 6.1 Security — five paths to full compromise

**S1. Any employee can promote themselves to Super Admin.** *(verified)*
`policies.sql:51-57` — the profiles UPDATE policy has **no `WITH CHECK`** and no column restriction. Postgres reuses `USING` as the check, and `auth.uid() = id` remains true after changing `role`:
```js
supabase.from('profiles').update({ role: 'super_admin' }).eq('id', myUserId)   // succeeds
```
The same request can rewrite `ctc`, `status`, `bank_account`, `ifsc`, `employee_id`. This makes the `manage-user` edge function pointless. A second route exists in the UI: `AddEmployeeModal.jsx:9` offers all seven roles, so any manager/rm/hr can edit their own row and pick `super_admin`.

**S2. Every authenticated user can read every colleague's salary, PAN and bank account.** *(verified)*
`policies.sql:41-44` — profiles SELECT is `using (true)`; RLS has no column granularity. `useEmployees.js:11` does `select('*')` and is called from `/attendance` (`App.jsx:67`, unguarded, open to all seven roles). A plain employee opening Attendance downloads every colleague's CTC and bank account into their browser.

**S3. `create_employee_account` is `SECURITY DEFINER` with zero authorization.** *(verified)*
`schema.sql:191-288` takes a caller-supplied `p_role`, writes directly into `auth.users`, and has no role check. `grep -rn "grant \|revoke " --include=*.sql` → 0 hits, and Postgres grants EXECUTE to PUBLIC by default. Any authenticated user can mint a Super Admin.

**S4. The signup trigger trusts client-supplied role metadata.** *(trigger flaw verified; exposure depends on hosted config)*
`schema.sql:302` — `handle_new_user` sets `role = coalesce(new.raw_user_meta_data->>'role', 'employee')`. That metadata is whatever the caller passes to `signUp({options:{data}})`. `config.toml:176,221` have `enable_signup = true` and `:226` `enable_confirmations = false`. **`config.toml` governs local dev and CLI config-push — the hosted project's Auth settings are authoritative, so check them today.** Fix the trigger regardless.

**S5. Deactivating an employee does not revoke access.** *(verified)*
Nothing in the auth path reads `profile.status` — not `App.jsx`, `ProtectedRoute.jsx`, `Layout.jsx` or `SignIn.jsx`. `manage-user`'s `toggle_status` writes `profiles.status` but never calls `auth.admin.updateUserById(..., { ban_duration })`, so the JWT keeps refreshing. A terminated employee can sign in the same afternoon and read the full directory.

**Also in this class:** no `storage.objects` policies and no bucket provisioning for Aadhaar/PAN scans · `notifications` INSERT is `with check (true)`, so any user can forge a notification to anyone · employees can mark **their own** identity documents `verified` (`policies.sql:229-235` grants `FOR ALL` on own rows) · HR/Finance can approve their own bank account, and any HR edit auto-verifies · no `search_path` pinned on any of the five `SECURITY DEFINER` functions · `/attendance`, `/leave` and `/documents` have no route guard · a hardcoded universal password `EMS@2026` and six seeded accounts ship in the no-env bundle — and that password is **published in a committed file**, `Role_Permission_Documentation.md:27`.

**A one-click attendance-fraud button ships to production.** `MarkAttendanceModal.jsx:174-178` renders a **"📍 Inside Office (0.05 km)"** button whose handler is `simulateOfficeLocation` — visible to every role. *(verified firsthand)* And denying GPS permission leaves `geofenceResult` untouched, so the geofence **fails open**.

### 6.2 Switchover breakage — the app↔schema contract

| # | What breaks | Where |
|---|---|---|
| B1 | **Add Employee, 100%.** The hook sends 8 RPC params the SQL function does not declare → PGRST202 *(verified: `grep -rn "p_ctc\|p_basic" supabase/` → 0)* | `useEmployees.js:36-43` vs `schema.sql:191-205` |
| B2 | **Add Employee fails a second way** — the function inserts the profile row that its own `auth.users` insert already triggered → 23505 duplicate key | `schema.sql:214, 245, 297-320` |
| B3 | **All salary-structure writes fail** — 5 non-existent columns, plus `effective_from` is NOT NULL with no default | `schema.sql:97-107` |
| B4 | **The entire bank-verification module is dead** — 9 columns exist in no SQL file | `schema.sql:32-34` |
| B5 | **The Leave module renders empty** — two FKs to `profiles` make the un-hinted embed ambiguous (PGRST201); `Leave.jsx:384` ignores `error`, so it shows "All requests are up to date" | `useLeave.js:11` |
| B6 | **Mark Attendance fails** — 4 geofence columns don't exist; the modal closes anyway | `schema.sql:47-57` |
| B7 | **Every approver notification fails** — five call sites target literal `'demo-hr-admin-id'` etc. against a `uuid` FK, swallowed by `console.error` | `useLeave.js:63`, `usePayroll.js:96,122` |
| B8 | **Two conflicting `notifications` tables** — no apply order produces a correct one *(verified)* | `schema.sql:181-188` vs `migration_v3` |
| B9 | **`migration_v2.sql` cannot run after `schema.sql`** — references a `url` column that never existed → 42703, aborting the chain | `migration_v2.sql:27-31` |
| B10 | **Monthly attendance blank 5 months a year** — range end built as `${month}-31` | `useAttendance.js:22-23` |
| B11 | **Document upload fails** — bucket never provisioned, `file_url`/`file_type` don't exist, and files are base64'd into a text column | `Documents.jsx:138-159` |
| B12 | **Employee-ID login is impossible** — `SignIn.jsx:28-32` reads `profiles` as `anon`, but the only SELECT policy is `to authenticated` | `policies.sql:41-44` |

### 6.3 Money — payroll correctness

This is the highest-risk module in an HR product and it has thirteen critical findings.

- **TDS is never computed.** `Payroll.jsx:24` is `net = gross - pf - esi - pt`; `:86` writes `tds: 0`. CareerMap is legally required to deduct monthly u/s 192. No slab table, no declarations, no Form 16/24Q.
- **`gross = CTC/12`** (`Payroll.jsx:16`) — CTC must have employer PF, employer ESI and gratuity carved out first. Every payout structurally overshoots the budgeted cost by ~5%.
- **PF has no ₹15,000 statutory wage ceiling and no employer share.** `grep -rn "15000" src/` → 0 matches. Meanwhile the statutory report prints employee PF twice under two different headers.
- **Zero attendance/LOP/proration input.** Payroll runs over `profiles` with no status filter, so terminated, invited and day-old joiners are all paid a full month.
- **The run is committed before the payslips**, in separate non-transactional calls, and `unique(month,year)` then makes the failure unrecoverable.
- **The run is created directly in `processing`** with payslips already released — the `draft` review step never happens.
- **Employees have no route to their own payslip**, yet receive a "Payslip Released" notification linking to `/payroll`, which their role cannot open.
- **Payslip "download" is `window.print()`** with no print stylesheet — it prints the whole application.
- **The salary formula is copy-pasted into seven files** with divergent clamping, so the preview screens and the DB writers disagree, and the unclamped copies will hit `check (net >= 0)` mid-run.

### 6.4 Data integrity

- **Employees can mint leave days.** *(verified)* The trigger deducts with `greatest(0, col - days)` (`schema.sql:341`) but refunds with `col + days` (`:348`). Balance 2 → approve a 5-day request → clamps to 0 → reject → balance becomes **5**. Repeat to inflate without limit.
- **On 1 January everyone gets unlimited leave.** Balance rows are only created for the current year; nothing creates next year's. The trigger's `UPDATE ... where year = ...` then matches zero rows and returns success, while the dashboard substitutes hardcoded defaults.
- **The trigger fires only on UPDATE** — inserts, deletes and day-count amendments never touch the balance.
- **Editing an employee's phone number silently reverts their negotiated salary breakup** to the 40% formula (`useUpdateEmployee`).
- **`salary_structures.employee_id` is UNIQUE** while the table carries `effective_from` — salary history is impossible.
- **One click on "Remove user" cascade-deletes every payslip, attendance row and leave record** that person ever had — statutory records that must be retained.
- **No audit trail anywhere.** No `updated_at`, no `updated_by`, no `audit_logs`, no logging in either edge function.
- **`schema.sql` is a reset script**, opening with 11 `DROP TABLE ... CASCADE`, and there is **no `supabase/migrations/` directory.** *(verified)*
- **Half-day leave is structurally impossible** (`days` is `integer`); maternity/paternity have quotas in two admin screens and no storage column at all.

### 6.5 Day one — the system cannot be stood up

The most consequential class, and the one no per-module audit could see:

- **There is no code path to create the first `super_admin`.** No `signUp` anywhere; `useInviteUser` is defined and never imported; Add Employee sits behind a role that does not yet exist; `handle_new_user` defaults to `'employee'`.
- **Opening leave balances can never be entered.** No UI, no RPC, no import writes `leave_balances` — so every existing CareerMap employee starts on day one with a fresh full quota.
- **No bulk import exists.** Existing staff must be typed in one at a time, each with a password.
- **Departments are three divergent hardcoded arrays** — no master data, and the lists don't even agree with each other.
- **Holidays are seeded for 2026 only, with no add-UI**, and the leave day-counter ignores them entirely — so employees are charged for Republic Day.
- **The geofence office location lives in the configuring admin's own `localStorage`**, so every other employee falls back to a hardcoded Mumbai coordinate and is hard-blocked from marking attendance.
- **The Reports month picker is six hardcoded strings ending March 2026** — today, no report can be run for any recent month.
- **The Documents page white-screens** (`TypeError` on a null `employee_id`) — which the bootstrap admin has — and there is no error boundary anywhere.

### 6.6 Consistency

The cross-cutting critic mapped every enum across the DB, the mock seed, the hooks and the UI. Divergences: account status (`invited` handled in Settings and nowhere else — the Employees page silently flips invited users to active) · attendance status (DB allows 7, the modal writes 5, `on_leave` is never written by anything yet three components count it) · leave type (7 allowed, 5 have balance columns, the trigger handles 5, the UI shows 4) · department (three arrays, 7/8/7 entries, none matching) · role (`MarkAttendanceModal.jsx:16` grants override to `'finance'`, a role that exists nowhere else) · currency (five formatters, one silently switching to lakhs) · date (six files use UTC `toISOString()` as "today", so the app is a day behind between 00:00 and 05:30 IST).

### 6.7 Frontend quality

No error boundary · no route-level code splitting (recharts, 108 KB gzipped, loads on the sign-in screen) · no test tooling and no CI · a `type-check` script that prints a sentence and exits 0 · eleven copy-pasted dialogs, 16 hand-written tables, 7 tab strips, 17 empty states, 11 `initials()` implementations, 10 date formatters, 6 CSV exporters (all with the same quoting bug, formula-injection risk and no Excel BOM) · 9 of 11 dialogs have no Escape key and no focus trap · zero accessibility affordances (no `aria`, no `role`, no `htmlFor`) · the documented caption token fails WCAG AA at 2.5:1 and is used 168 times · eight of twelve UI files have no responsive breakpoints · `alert()`/`confirm()` used for HR-critical actions · no security headers in `vercel.json`, which also returns HTTP 200 for every 404.

---

## 7. Target system design

> ⚠️ **This section is superseded.** It was written while the product was still expected to stay on Supabase, so it describes a target built on RLS policies, Postgres RPCs and edge functions. The project has since moved to **Node.js + Express + PostgreSQL + Prisma**, where authorization is middleware rather than RLS and business rules live in services rather than RPCs.
>
> **For the current target design, read [EMS_BUILD_GUIDE.md](EMS_BUILD_GUIDE.md) Part A.**
>
> Sections 1–6 of this document (the audit findings) remain fully valid and are the reason most of those design decisions exist. Section 7 is kept only for reference.

### 7.1 Two governing principles

> **P1 — Postgres is the system of record; the browser is a rendering layer.**
> Every business rule must have its authoritative implementation in the database or an edge function. The client may duplicate a rule for instant feedback, never as the only copy.

> **P2 — One source of truth per concept.**
> Salary math exists in seven places today. Target: exactly one, in SQL.

### 7.2 Layering and the trust boundary

```
┌─ Browser (React) ──────────────────────────────────────────────┐
│  pages/ + features/     presentation only                       │
│  hooks/                 the ONLY place that talks to Supabase   │
│  guards                 UX affordance — never security          │
└────────────────────────────────────────────────────────────────┘
                    ══ trust boundary ══
┌─ Supabase ─────────────────────────────────────────────────────┐
│  PostgREST + RLS + column GRANTs   ← all READ paths            │
│  RPC (SECURITY DEFINER, role-checked, transactional)            │
│                                    ← all WRITE paths with rules │
│  Edge Functions (service role)     ← auth-admin ops only        │
│  Postgres constraints + triggers   ← invariants that must hold  │
│  Storage (private buckets + object policies)  ← documents       │
└────────────────────────────────────────────────────────────────┘
```

**The rule that fixes most of §6: reads through RLS, writes through RPC.**
Any write touching more than one table, or carrying a business rule, goes through a `SECURITY DEFINER` function that (1) checks the caller's role, (2) validates inputs, (3) does the whole thing in one transaction, (4) writes an audit row.

Concretely, that means three payroll RPCs — `payroll_run_open(month, year)`, `payroll_run_approve(run_id)`, `payroll_run_mark_paid(run_id)` — each opening with `if not has_any_role(array['super_admin','accounts']) then raise exception`. `payroll_run_open` inserts the run as `draft`, selects eligible employees, computes each payslip **in SQL**, inserts all payslips and sets the totals from `sum(payslips)` — all inside one `BEGIN`. Either the month exists complete or it does not exist at all. That single change kills the unrecoverable-state bug, the duplicate-run race, and the browser-as-source-of-truth problem simultaneously.

Add a `before update` trigger on `payroll_runs` rejecting any transition other than draft→processing→approved→paid, and one on `payslips` raising if the parent run is `approved` or `paid`. That is the "payslip lock" the Settings screen already advertises.

`Documents.jsx` currently bypasses the hooks layer and calls `supabase` directly. That should stop — one door in, one door out.

### 7.3 Data model corrections

| Change | Fixes |
|---|---|
| **Split sensitive columns out of `profiles`** into `employee_financial` (employee_id PK, ctc, pan, bank_*) with RLS = self + accounts + super_admin | S2 structurally — RLS has no column granularity. **Note:** `useEmployees` is one wide `select('*')` shared by four pages; split it into two hooks *before* tightening RLS, or the Attendance roster silently loses rows |
| New **`company_settings`** single-row table — company identity, PF/ESI/PT rates, pay day, payslip lock, geofence lat/lon/radius, notification prefs | Four of five Settings tabs persist nothing; the geofence lives in one admin's localStorage; statutory rates are hardcoded in six files |
| New **`departments`**, **`designations`**, **`leave_types`** master tables | Three divergent hardcoded arrays; quotas hardcoded in four files |
| `salary_structures`: drop `UNIQUE(employee_id)`, default `effective_from`, add the derived columns the app writes | B3, salary history |
| `attendance`: add `check_in_lat`, `check_in_lon`, `distance_km`, `geofence_verified`; add an UPDATE policy for `auth.uid() = employee_id and date = current_date` | B6, and employees currently cannot check out |
| `leave_requests.days` / `leave_balances.*` → `numeric(4,1)`; add `half_day_type`; add maternity/paternity columns | Half-day is impossible; two leave types are untracked |
| `payslips`: add `month`, `year`, `paid_days`, `lop_days`, `overtime_hours` | Employees cannot find their own payslip; net pay ignores LOP |
| **One** `notifications` definition with `title`, `link`, `related_entity_id` | B8 |
| `employee_documents`: add `file_type`; move files to Storage, never base64 | B11 |
| New **`audit_logs`** + triggers on profiles, salary, payroll, attendance amendments | No audit trail |
| `updated_at` / `updated_by` on every mutable table; soft-delete (`archived_at`) instead of hard delete | Cascade data loss |
| Add `termination_date` | The Joiners & Exits report prints the literal string "Inactive" as the exit date |

### 7.4 Security model — three enforcement layers

| Layer | Fixes |
|---|---|
| **Database** | `WITH CHECK` on every UPDATE policy; a `BEFORE UPDATE` guard trigger making `role`, `status`, `ctc`, `employee_id` immutable except via RPC; column-level `GRANT`s; tighten profiles SELECT; `storage.objects` policies; pin `search_path` on all five definer functions; `CHECK` constraints for leave sufficiency and payslip reconciliation |
| **RPC / Edge functions** | `REVOKE EXECUTE ... FROM anon, authenticated` on `create_employee_account`, then add a role check — or better, **move employee creation to an edge function using `auth.admin.createUser`** and delete the hand-rolled `auth.users` INSERT entirely (it omits `auth.identities`, which GoTrue requires for password login) · validate the role string against the 7-role set in both edge functions |
| **Frontend** | Guard `/attendance`, `/leave`, `/documents`; add a 404 route and an error boundary; clear the TanStack cache on sign-out; **delete the "Simulate GPS" button**; derive `canEdit`/`canSeeCompensation`/`canDelete` from `role` in `Employees.jsx`, which today imports `useAuthStore` not at all |

Plus: disable public signup on the **hosted** project · force `role='employee'` / `status='invited'` in `handle_new_user` · check `profile.status` at login · call `ban_duration` when deactivating · rotate `EMS@2026` and remove it from the committed doc.

### 7.5 One role registry

Export `ROLES`, `ROLE_LABELS`, `ROLE_COLORS` and a `can(role, module, action)` helper from a single `src/lib/roles.js` derived from the DB CHECK values. Today there are four divergent `ROLE_LABELS` maps (`Sidebar.jsx:35`, `TopBar.jsx:7`, `ProfileDrawer.jsx:12`, `Settings.jsx:294`) plus five inline role-array gates. That reduces the "add a role" checklist from ~13 touchpoints to two, and kills the `'finance'` ghost role.

### 7.6 Environment and deployment discipline

The highest-consequence risk in the repo: **a deploy with missing env vars silently ships a fake HR system with a published Super Admin password.** An agent verified this by building twice — without env vars the bundle contains `EMS@2026` and `ems_mock_database` and the real Supabase client is tree-shaken out entirely.

```js
// src/lib/supabase.js
if (import.meta.env.PROD && !supabaseUrl) {
  throw new Error('FATAL: VITE_SUPABASE_URL missing — refusing to start with the mock client')
}
```
Plus `.env.example`, a dev-only dynamic import for the mock so it cannot be bundled, and a CI gate on env presence.

### 7.7 Migrations

Replace the four loose `.sql` files with a forward-only chain under `supabase/migrations/`, starting from `schema.sql` **minus its DROP CASCADE header**. Then `supabase db reset` against an empty database must succeed end to end — and that becomes the CI check. Today no apply order works at all.

### 7.8 Error-handling contract

`QueryClient` gets `defaultOptions` (don't retry 4xx, sensible `staleTime`) · a global toast provider replaces every `alert()` · **every** mutation gets `onError`, and every call site awaits before closing its modal · never destructure `{ data }` without `{ error }` · an `ErrorBoundary` per route · and **delete every fabricating fallback in §5 RC3** — an empty state is honest, an invented number is not.

### 7.9 Testing

1. **Contract tests** — local Supabase with migrations applied, then execute every hook's query against it. This entire class of bug (§6.2) dies here.
2. **RLS test suite** — for each of the 7 roles, assert allowed/denied per table. A direct implementation of `Role_Permission_Documentation.md §10`.
3. **Payroll golden tests** — fixed inputs → expected payslip figures.

---

## 8. Improvement roadmap

### P0 — Security blockers (before any real employee data enters the system)
1. `WITH CHECK` + guard trigger protecting `role`/`status`/`ctc`/`employee_id` **(S1)**
2. `REVOKE EXECUTE` on `create_employee_account`; add a role check **(S3)**
3. Force `role`/`status` in `handle_new_user`; verify and disable signup on the hosted project **(S4)**
4. Move `ctc`/`pan`/`bank_*` to `employee_financial`; split `useEmployees` first **(S2)**
5. Check `profile.status` at login; `ban_duration` on deactivate **(S5)**
6. Storage bucket + `storage.objects` policies
7. Pin `search_path` on all five `SECURITY DEFINER` functions
8. Make the mock impossible to ship in a production build **(§7.6)**
9. **Delete the "Simulate GPS inside office" button; make the geofence fail closed on GPS denial**
10. Rotate `EMS@2026`; remove it from `Role_Permission_Documentation.md:27`

### P1 — Make the app work on real Supabase
1. Build the real migrations chain; prove `db reset` succeeds on an empty DB **(§7.7)**
2. Rewrite employee creation as an edge function using `auth.admin.createUser` **(B1, B2)**
3. Add every missing column **(B3, B4, B6, B11)**
4. FK embed hints — `profiles!leave_requests_employee_id_fkey` **(B5)**
5. Replace `demo-*-id` notification targets with a role query **(B7)**
6. Fix the `-31` date construction **(B10)**
7. Decide Employee-ID login: a `SECURITY DEFINER` lookup RPC, or drop the advertised feature **(B12)**
8. **Then connect a real `.env` and walk every workflow by hand.** Nothing is "done" until this passes.

### P2 — Day one (do this before P3; without it there is no go-live)
1. A bootstrap path for the first `super_admin` — a seeded migration or a documented one-time SQL step
2. An opening-balance entry path for `leave_balances`
3. **Bulk CSV import** for existing employees
4. `departments` / `designations` / `leave_types` master tables + admin CRUD
5. Holiday management UI, and make the leave day-counter respect holidays
6. Move the geofence into `company_settings` so it reaches employees' phones
7. Un-freeze the Reports month picker

### P3 — Correctness and integrity
1. Rewrite the leave trigger: validate sufficiency, refund `old.days`, cover INSERT/DELETE **(§6.4)**
2. Year-end rollover job
3. Payroll: one SQL formula, LOP/proration from attendance, TDS, the PF ceiling, employer contributions, the state machine and lock **(§6.3)**
4. `audit_logs` + triggers
5. Persist Settings to `company_settings`; delete the six hardcoded rate copies
6. `onError` everywhere + global toasts; **remove every fabricating fallback**
7. One `src/lib/date.js` with a single `todayLocal()`; replace all six UTC `toISOString()` uses
8. Soft-delete; add `termination_date`

### P4 — Client delight and engineering quality
Employee self check-in/out · an employee route to their own payslip · real PDF payslips · email delivery · half-day leave · employee lifecycle (probation → confirmation → resignation → exit) · error boundaries · route code-splitting · shared UI components (11 dialogs → 1) · accessibility pass · contract + RLS + payroll tests · CI · a real README · `.env.example` · **commit `ROADMAP.md` and `SYSTEM_DESIGN_AND_AUDIT.md`, which are currently untracked**

---

## 9. Definition of done

- [ ] `supabase db reset` succeeds on an empty database from `migrations/` alone
- [ ] Every workflow performed end-to-end against **real** Supabase, by a human
- [ ] For each of the 7 roles: sidebar, direct-URL access and raw REST access all match `Role_Permission_Documentation.md` — verified by the RLS test suite, not by inspection
- [ ] An employee cannot read any other employee's salary or bank details by any route
- [ ] A terminated employee cannot sign in
- [ ] A failed mutation always produces visible feedback; **no screen ever invents a number**
- [ ] A build with missing env vars fails instead of shipping the mock
- [ ] CareerMap's real roster imported, opening balances set, and one real payroll month run and reconciled by hand

## 10. Explicitly out of scope

Multi-tenancy, `company_id`, subscriptions, licensing, billing, a CMS platform-admin portal, country-configurable payroll, custom role builders. Those belong to the future SaaS phase in ROADMAP.md (removed on 30 Sep 2026; it is in git history) §5. Starting any of them before the above is done would be a mistake.
