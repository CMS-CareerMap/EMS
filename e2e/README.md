# Browser tests (E2E)

Real browser tests for EMS, run against the app as production runs it:

- the **built** web app on `http://localhost:5183`, served with the production security headers;
- the **compiled** API on `:4100` (`NODE_ENV=production`);
- a **local** Postgres database, `ems_e2e`.

They never touch Neon or your own dev servers on `:4000` / `:5173`. Any database URL that is not
`localhost` is refused before a single query.

## Setup (once)

1. Local Postgres running, and `server/.env.test` filled in (copy `server/.env.test.example`).
2. Microsoft Edge installed (the tests drive it headless).
3. `cd e2e && npm install`

## Running

| Command | What it does |
|---|---|
| `npm run e2e` | Every suite except `golden`, each on a fresh seed with a fresh API |
| `npm run e2e -- day20 v1gaps` | Just these suites |
| `npm run e2e -- --build` | Build the server and the web app first |
| `npm run e2e:all` | Build, **empty `ems_e2e`**, then `golden` first and every other suite |
| `npm run up` | Start the stack and leave it running (Ctrl+C stops it) |
| `npm run seed -- day20 seed` | Run one seed by hand |
| `npm run demo` | The demo company, to click through by hand — see `DEMO.md` |

Results print as one line per suite. Logs: `e2e/.work/logs/<suite>.log` (the suite) and
`<suite>.api.log` (its API). Screenshots and downloads: `e2e/.work/shots`, `e2e/.work/downloads-*`.
Nothing in `.work` is committed.

Build before running when code has changed, and never rebuild while a run is going: the web
server reads files from `web/dist` on every request.

## The suites

| Suite | Seed | Covers |
|---|---|---|
| `golden` | empty database | Day 0 to month end: bootstrap, company set-up, staff added and imported, invitations, the tree, leave grant, salaries, bank accounts, biometric import, GPS check-in, leave, payroll, bank file, payslip, report, audit log |
| `day18`, `day18b`, `day18-tds` | day18 | Payroll runs, approval, bank file, payslips, TDS (as on 30 Sep 2026) |
| `day19`, `day19b` | day19 | Documents, notifications, reports, uploads |
| `day20` | day20 | Every page as every role, phone width, refusals, audit log |
| `day21` | day20 | Roles & Permissions |
| `day22` | day20 | The company tree and approvals |
| `day23` | day20 | Two logins for one person |
| `lifecycle` | day20 | Onboarding to exit |
| `wages-share` | day20 | The 50% wages rule |
| `v1gaps`, `v1gaps2` | day20 | Requests, shifts, overtime, leave rules, encashment, components, loans, email |
| `sweep23` | day20 | Every page × every role × phone: no crash, no sideways scroll |
| `newlook` | day20 | The app's frame as every role: menus, page titles, the user menu, search, the phone tab bar and Menu drawer, dialogs opened from links, the employee profile page, the attendance calendar's days off, tabs from the keyboard, the mid-month salary hint |
| `holidays` | day20 | Home's holiday card: none left this year, some left, none ahead; the way to add them for HR and the Super Admin only, opening Settings at Holidays; a holiday added there on Home at once; a phone |
| `demo-tour` | the demo | Read-only tour of the demo as all seven roles (run with the demo up) |
| `rehearsal` | the laptop rehearsal | The Docker images behind a stand-in edge, over HTTPS (`deploy/local/rehearse.sh`, `deploy/DEPLOY.md`): headers, caching, 404s, the refresh cookie, every Super Admin page, a phone, a file up and back, the upload limits. Run by hand: `REHEARSAL_SA_PASSWORD='…' node suites/rehearsal.mjs` |

`golden` needs a database with no company in it, so it runs only after `--reset`
(`npm run e2e:all`). Emptying `ems_e2e` uses `prisma migrate reset`; when Claude runs it, Prisma
asks for your explicit consent first.
