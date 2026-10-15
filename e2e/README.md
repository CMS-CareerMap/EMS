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
| `golden` | empty database | Day 0 to month end: bootstrap, company set-up, staff added and imported, invitations, the tree, leave grant, salaries, bank accounts, biometric import, the office set on Attendance Security (20 m), GPS check-in on a phone, leave, payroll, bank file, payslip, report, audit log |
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
| `leavepolicy` | day20 | Who gets how much leave, and Loss of Pay: Leave Types shows Loss of Pay (unpaid, no limit) and no Work From Home; a type's "A new joiner gets" and "Only after confirmation"; a monthly type says its month's share (12 a year = 1 a month); new days a year with this year's balances when asked; HR adds a joiner with their own Casual Leave (granted at once, pro-rated) and changes it on the profile's Leave tab; Priya with one day left asks for three on a phone and applies like the offer says (1 Casual Leave + 2 Loss of Pay); Comp Off with nothing offers all as Loss of Pay; the form points working from home to Requests; Manoj sees one item and approves both parts; balances, Home, Team Balances (Loss of Pay as days taken, never corrected) and payroll (two days cut) |
| `leaveextras` | day20 | Leave day to day: Priya’s Attendance names each leave day by its type (Loss of Pay in amber) and gives Paid days / Unpaid days (loss of pay) as payroll counts them; an absent day is told to her and offers “Apply leave” — the form opens on that day, costed; approved, the day says Casual Leave and is no longer cut from pay; Leave Balance → Statement, like a passbook (HR sees it on her profile); Manoj sees “Also away: …” beside her request, on Leave and Home; Leave Config → Year-end Reminder (1–90 days); both notices in Settings → Notifications; a phone |
| `checkinsecurity` | day20 | Check-in security (browser with a fixed location and a fake camera): Settings → Attendance Security (office radius and accuracy kept to 15–20 / 10–20 m, "test this spot", the method Location to start with no separate check-out or phones-only switch); Priya on a phone refused 21 m out — the attempt kept as evidence — and in at the office; check-out refused 40 m out with "Ask HR to record your check-out"; no office set refuses everyone; HR gives Ravi a Machine ID and imports a machine file (one line a scan, yesterday and today): Priya confirmed, Ravi's days filled by his Machine ID, Neha not on the machine yesterday (today is never judged) — then absent when the company says so; Manoj refused from a laptop, a too-precise phone reading taken and flagged; Attendance → Suspicious; with Location + Selfie and one phone on, Hema's location then photo then punch, her second phone waiting until replaced (asked first); a day's evidence with the photos from the roster, a selfie opened larger; a refused punch's evidence from Suspicious; Attendance Security, Suspicious and the evidence at 390 px |
| `punchmethod` | day20 | The punch method (client, 14 Oct 2026): Settings → Attendance Security shows three methods as one radio (Location to start, each with its strength) and the flow they ask for; the old switches gone; Selfie chosen through an "are you sure?" and audited; Priya on a laptop with no location allowed checks in and out by photo alone; the company moves to Location + Selfie and her day still ends by photo; Ravi with location blocked is refused before the camera opens, then in by location and photo once allowed — at a warehouse 3 km from the office, no office needed, his vague reading flagged; HR sees it on Suspicious with Open map and the day's evidence ("Taken at …", the photo); one phone with Selfie — Manoj's second phone refused with "Contact HR", Admin told with a link to his page; Admin (no Attendance pages) opens it from the link and Replaces (old phone off in the same step), then Resets (Manoj told; his next new phone is his by itself); no Punch phone card for a Reporting Manager; with no office Location is held (Location + Selfie is not), and Settings and the home page say the setup is not finished; Settings and the Punch phone card at 390 px |
| `personmonth` | day20 | One person's month (client, 15 Oct 2026): Priya checks in at the office (an hour and a half ago); HR clicks her name on today's roster and gets her page on this month — heading, code and department, "Month so far" counted till today with working days, present, leave · absent and not marked exactly as the server counts them, today's time running live (checked against the real clock, in the figures and in Day by day — also from a computer whose clock is 10 minutes fast), paid and unpaid days; the calendar, Day by day with her Evidence; the month before counted to its end; the seeded September (her two absences, the 10th Absent) whatever month it runs in; Attendance → Monthly's hours table agrees, its name links, and "← Attendance" comes back to that month; Kiran (last day 10 Sep: "to the last working day", Day by day stops there) and Neha (joined 14 Sep) said in words; Ravi refused 3 km out → his name on Suspicious opens his month; the profile's Attendance tab and "Open on Attendance"; the roster's name and the page at 390 px; Manoj sees his team and is told "Not yours to see" for Ravi (no toast), on the page and the profile tab; Admin has no tab and no page; Priya's own page, "Attendance stats" and Home's "My month" are the same count; no Evidence of her own; the Super Admin sees Evidence |
| `payrollscope` | day20 | Whose payroll (client, 15 Oct 2026): every role's payroll reach (Accounts whole company, HR the company except seniors, Manager own); Roles & Permissions asks "Whose payroll" with exactly the choices of "Whose leave", any choice with any tick, no warning of its own; a "Payroll Sales" role for Rekha (her department, with Prepare and Approve): salaries, bank accounts, incentives, loans, the calculation, payslips and reports of Sales only (404 outside), Accounts' August run as Sales's share ("in your payroll", net = Sales's payslips, no run notes), next month's check of Sales only; she adds a component, recalculates August, is asked about the days paid on no record naming Ravi and never Hema (the rest counted), approves it, and her bank file — preview and on screen — has Sales's lines only; on screen Reopen/Mark as paid/Bank file, Components and the bank layout hers to keep, profiles showing the bank tab only for Sales, Home's card marked with its next step, 390 px; Accounts sees the whole month and the whole bank file; HR as before; Accounts marks August paid and Manoj, given "Whose payslips: Their team", gets a People’s payslips tab with Priya's and his own — no Ravi, no Hema — Priya's PDF downloads, Ravi's is not there, on a phone too; Ravi's bank details told to Rekha and Accounts, Hema's to Accounts only |
| `passwords` | day20 | Passwords set by the company: HR adds an employee with an Employee ID and a typed password, no email (short and mismatched stopped); she signs in by ID in small letters and cannot change it; HR sets a new one (old session out, bell notice); a roster's logins wait for HR ("No password yet"); the Super Admin sets a role login's and gives HR an email-less employee login (her ID opens it); what HR cannot do; Settings → Passwords (length, handed back to employees and taken back — a link issued meanwhile dies); forgot password; a phone |
| `demo-tour` | the demo | Read-only tour of the demo as all seven roles (run with the demo up) |
| `rehearsal` | the laptop rehearsal | The Docker images behind a stand-in edge, over HTTPS (`deploy/local/rehearse.sh`, `deploy/DEPLOY.md`): headers, caching, 404s, the refresh cookie, every Super Admin page, a phone, a file up and back, the upload limits. Run by hand: `REHEARSAL_SA_PASSWORD='…' node suites/rehearsal.mjs` |

`golden` needs a database with no company in it, so it runs only after `--reset`
(`npm run e2e:all`). Emptying `ems_e2e` uses `prisma migrate reset`; when Claude runs it, Prisma
asks for your explicit consent first.
