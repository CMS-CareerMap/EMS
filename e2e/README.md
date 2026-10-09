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
| `dayrules` | day20 | The client's day: Settings → Organisation → Shifts shows Shift hours, Full day from, Half day from and Unpaid break (General: 9h · 8h · 4h 30m · none); HR's typed hours graded by it (8h Present, 7h 59m and 4h 30m Half day, 4h 29m Absent, no break off); a change in the table grades the next day, emptied it falls back "(auto)"; the employee's Timings card says the rule, on a phone |
| `layout` | day20 | Short screens: at 160% zoom (1200×516), a laptop and Full HD the Settings menu stays whole on screen and in one place while the page scrolls, every section is in reach inside it without moving the page, a section chosen from halfway down opens at its top with its name in view; the dark side menu keeps its spacing, has every page in reach (Super Admin's 10, HR's 9: it scrolls with a thin scrollbar where they do not fit) and the open page in view; a phone keeps its strip of tabs and no sideways scrolling |
| `liveroster` | day20 | Whoever watches sees the time at work run: HR's roster, open before Priya checks in, finds her within a minute with no reload and runs "0h 1m so far" (computer and phone); her manager's "My team today" says "in 09:… · 1m so far"; her own "My last 7 days" says her minutes, not "In"; after Check Out the stored hours, the count stopped; a day with a check-in only says "No check-out" |
| `livetime` | day20 | The "Time today" card: before Check In the time of day; after it the time at work, h:mm:ss ticking by the second and the minute, the shift's unpaid break said up front, and how far to a full day in words ("Full day at 6h · 6h to go", then "Full day done"; nothing with no shift; no coloured line of the day any more); after Check Out the hours worked as Xh Ym like the Attendance page, with the break that came off them, shown and spoken alike (7.18 h: 7h 11m) — a computer with no shift, a phone on a 45-minute-break shift |
| `passwords` | day20 | Passwords set by the company: HR adds an employee with an Employee ID and a typed password, no email (short and mismatched stopped); she signs in by ID in small letters and cannot change it; HR sets a new one (old session out, bell notice); a roster's logins wait for HR ("No password yet"); the Super Admin sets a role login's and gives HR an email-less employee login (her ID opens it); what HR cannot do; Settings → Passwords (length, handed back to employees and taken back — a link issued meanwhile dies); forgot password; a phone |
| `demo-tour` | the demo | Read-only tour of the demo as all seven roles (run with the demo up) |
| `rehearsal` | the laptop rehearsal | The Docker images behind a stand-in edge, over HTTPS (`deploy/local/rehearse.sh`, `deploy/DEPLOY.md`): headers, caching, 404s, the refresh cookie, every Super Admin page, a phone, a file up and back, the upload limits. Run by hand: `REHEARSAL_SA_PASSWORD='…' node suites/rehearsal.mjs` |

`golden` needs a database with no company in it, so it runs only after `--reset`
(`npm run e2e:all`). Emptying `ems_e2e` uses `prisma migrate reset`; when Claude runs it, Prisma
asks for your explicit consent first.
