# EMS — HR & Payroll Management System

HR & Payroll system for **CareerMap Solutions**. Employee lifecycle, attendance, leave, payroll, documents, reports.

> **Read [EMS_BUILD_GUIDE.md](../EMS_BUILD_GUIDE.md) before making any change.** It is the source of truth for architecture, conventions and the day-by-day plan. Part A is the system design; Part B is the schedule.

---

## Current state — migration complete, hardening next

The project has moved **off Supabase onto its own Node backend**. Nothing talks to Supabase any more.

| | Status |
|---|---|
| `web/` — React app | Every screen reads the API. `lib/supabase.js` and `@supabase/supabase-js` deleted on Day 19 |
| `server/` — Express + Prisma | Every module: auth, people, attendance, leave, payroll, documents, notifications, reports |
| `supabase/` | Deleted on Day 19 (it is in git history if the old SQL is ever needed) |

Work follows the build guide's day plan.

### Migration progress

- [x] **Day 1** — workspace split, Express + TypeScript skeleton, error contract, `/health`
- [x] **Day 2** — Prisma schema (identity / org / people), first migration, tenant conformance test
- [x] **Day 3** — platform layer (scoped client, transactions, logger, password, storage), bootstrap CLI
- [x] **Day 4** — login: email or employee code, access + refresh tokens
- [x] **Day 5** — sessions: rotation, reuse detection, logout, change-password, rate limits
- [x] **Day 6** — permissions registry, data scopes, frontend auth cutover (Supabase Auth deleted)
- [x] **Day 7** — employee reads, scoped + field-level permissions, field contract
- [x] **Day 8** — employee writes, invitations, role/status/termination
- [x] **Day 9** — settings, statutory policy, geofence, master data
- [x] **Day 10** — CSV roster import with dry-run preview
- [x] **Day 11** — attendance punch flow, server-side geofence, domain layer
- [x] **Day 12** — attendance views, monthly hours, biometric import
- [x] **Day 13** — leave requests, working-day counting, ledger backfill
- [x] **Day 14** — leave approval, reversal, dashboards
- [x] **Days 15–18** — payroll: policy, runs, payslips and PDFs, payroll frontend, bank file (`v0.5-payroll`)
- [x] **Day 19** — documents, notifications, reports, one CSV writer, bank proof; **`web/src/lib/supabase.js` deleted**
- [ ] **Day 20 ← next** — hardening, deploy

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
- **The API emits `snake_case` for v1** and reproduces the nested `profiles` key the pages already read

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
cd server && npm run maintenance -- --apply # actually remove them (schedule this nightly once deployed)

cd server && npm run db:test -- migrate deploy   # migrate the TEST database
cd server && npm run db:test -- migrate reset    # wipe and rebuild it
```
