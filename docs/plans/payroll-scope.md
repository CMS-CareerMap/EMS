# Whose payroll (client, 15 Oct 2026)

The client's third change after go-live.

What the client asked for: on Roles & Permissions, the **Payroll** module gets a "Whose …" dropdown like Employees, Salaries, Attendance and Leave. A payroll role can then be limited to some people — a department, a team, everybody under someone — instead of always covering the whole company.

Decided with the client (Devesh, 15 Oct 2026: "jo option choose kre uske hisaab se hi sbko dikhe, ekdm puda flow option pr depend ho … simple"):

- The dropdown offers exactly what "Whose leave" offers, and works the same way: **the choice decides whom the role is shown**, everywhere in Payroll.
- What a role may **do** is its ticks, as in every module. There are no extra rules: no "Whole company" needed for any step, and no refusal on the Roles screen.
- "Whose payroll" also decides the **bank accounts**, the **bank file's lines**, **payroll reports** and the **Bank account tab** on a profile.
- The migration keeps every role exactly as it was.

## As built

### The reach

- A new scoped resource, `payroll` (`platform/authz/scope.ts`), offers all six choices.
- The catalogue's Payroll module has `resource: 'payroll'` and `scopeQuestion: 'Whose payroll'`. All seven of its permissions work within it:
  - structure read/manage;
  - incentives;
  - run create/approve;
  - bank read/manage.
- `modules/payroll/payrollReach.ts` holds two helpers:
  - `payrollPeople(ctx)` gives the people as an Employee filter, or null for the whole company;
  - `shownOf(ctx, items, personOf)` gives the part of a list the caller may be shown: only their people, with the rest counted (`others`) and never named.

### Per person: confined to the reach, 404 outside it

- **Salary structure:**
  - the roster;
  - a person's salary history;
  - setting a salary;
  - the calculation preview;
  - ESI redecide.
- **Income tax (TDS):** the list and setting one.
- **Incentives:**
  - The list, setting and removing go by the payroll reach. It was the salaries reach for a role without Payroll.
  - Anyone outside the reach is listed as "whoever looks after their payroll".
- **Loans:** this was the salaries reach until now.
- **Bank accounts:**
  - the list, saving, the proof, checking;
  - the profile's Bank account tab, which is left out (not "none") for anyone outside the reach;
  - the "bank details to check" notice, which goes to whoever's reach covers the person (`reaching`, with the work rule).
- **A run's payslips:** detail and PDF.
- **Reports:** Monthly payroll and PF & ESI. Their chart is now summed over the same payslips whenever the reach is not the whole company. Before, it would have shown the company's totals.

### A run, seen with some people's payroll

- The run list, a run and the home page's payroll card show **that share**: count, gross, deductions, net and employer PF/ESI summed over those people's payslips in one query (`totalsAmong`). They never show the company's totals.
- They are marked `partial: true`. The run's own notes are left out, because they can name anybody.
- The next month's check (readiness) shows only those people's lines, blockers and "left out" names.

### The month's steps: by the ticks, shown by the choice

- The month's payroll stays **one run** for the company. Preparing, recalculating, discarding, approving, reopening and marking it paid are done by whoever holds the tick, whatever their "Whose payroll". The same goes for salary components and the bank file's layout.
- What such a role is shown follows its choice:
  - its share of the run;
  - the **bank file**, both preview and CSV, which carries only its people's lines;
  - a refusal's lists (what stops the run; payslips changed since they were calculated; days paid on no record), which name only its people. The others are counted (`others`) and never named.
- Readiness sends `others_blocking`: what stops the month about people outside the reach. The month is one run, so those stop it too, and "Run payroll" stays disabled. The page and home card say so in words.
- For a partial run, the Approve, Mark as paid, Reopen and Discard dialogs say that the step acts on the month's whole payroll, not only the people shown.
- The bank file says it is partial (`partial`, `others`: the month's payslips not in it), on screen and in the audit log.
- Archiving a component that is still on salaries names only the caller's people. The rest are counted.
- On a partial run the approver's count of days accepted as paid (`assumed_days`) is left out, as the run's notes are.

### The session and the web

- The session sends `payrollReach`.
- Buttons follow the permissions alone, as in every module.
- Partial figures are marked "in your payroll", with a note that they are not the company's totals.

### Whose payslips: every choice too

Asked the same day: "Whose payslips" offered only "Only their own" and "Whole company", because nothing listed anybody else's payslips. It now offers all six choices, like every module (the catalogue's `scopes` override is gone).

- `GET /api/payslips?year=&month=` (`payslip:read`) returns the paid payslips of the people the payslip scope reaches (`ownedRowsInScope`), a month at a time. Without a month it returns the latest paid month, plus the list of paid months.
- `GET /api/payslips/:id/pdf` already followed the scope, with every choice; anything outside it is a 404.
- The session sends `payslipReach`. Beyond `SELF`, My Payslips has a second tab, **People's payslips** (`?tab=people`). It shows a month picker and a table (a list on a phone), each row with its PDF. The page still opens on one's own payslips, and a login with no employee record is told there why it has none.
- Existing roles keep "Only their own" or "Whole company" as stored, so no migration is needed.

### The migration

`20261015120000_payroll_scope` adds a payroll reach to every role that has none:

| The role holds | Payroll reach |
|---|---|
| any of structure read/manage, run create/approve, bank read/manage | Whole company — they reached everybody there |
| incentives only (with salaries) | its salaries reach — HR: the company except seniors |
| none of these | Only their own |

It also replaces `ems_seed_default_roles` with the new defaults:

- Super Admin and Accounts: Whole company;
- HR: Whole company, except seniors;
- the rest: Only their own.

## Tests

- **Server:** `payrollScope.test.ts`, a department payroll role end to end:
  - the session's reach;
  - salaries, the calculation, bank accounts and the profile's bank tab;
  - its share of a run, the run list, and the home card;
  - payslips, readiness and reports;
  - components and the bank layout by the permission;
  - recalculating and approving, where the days paid on no record are named for its people only and the rest are counted;
  - the bank file with its people's lines only;
  - a role saved with any reach;
  - the migration's own UPDATE run on roles made as they were before it.
- **Server:** `roles.policy.test.ts` saves every "Whose payroll" choice with every payroll tick, and stores "Only their own" for a role with no payroll permission.
- **E2E:** `e2e/suites/payrollscope.mjs`, which covers:
  - every role's reach;
  - the role editor offering exactly what "Whose leave" offers, with no warning of its own;
  - a "Payroll Sales" role (Rekha, with prepare and approve) on every per-person route, with 404s outside Sales;
  - its share of the run;
  - recalculating and approving August, the refusal naming Ravi and never Hema;
  - the bank file with Sales lines only, in the preview and on screen;
  - components, the bank layout, reports, the home card's next step, profiles, and 390 px;
  - Accounts and HR as before;
  - bank notices going to the right people.
- **E2E:** `day21.mjs` checks the "Whose payroll" choice; a role holding both prepare and approve saves with the usual warning.
