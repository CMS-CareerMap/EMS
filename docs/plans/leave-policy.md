# Plan: leave policy, Loss of Pay and short leave

Status: **Part 1 built on 10 Oct 2026 on `feat/leave-policy`** (see "Part 1 as
built" at the end); Part 2 planned, not built. Asked for by the client through
Devesh; decisions taken 9 Oct 2026.

**The principle Devesh set:** every rule is a setting the Super Admin can change
for their own company, and it applies to everybody. Nothing is hardcoded. Where
one person needs something different, it is set on that person's profile. Who
else may change these settings (HR, Admin) is the Super Admin's choice, in
Roles & Permissions. Today `leave:type:manage` is held by Super Admin, Admin
and HR; `leave:balance:manage` by HR and Super Admin.

The work is in three parts, each on its own branch, each with full tests:

1. **`feat/leave-policy`** (this plan): who gets how much leave and from when, a
   per-employee override, automatic grants, the Loss of Pay type, the "rest as
   Loss of Pay" application, and Work From Home taken off the leave list.
2. **`feat/short-leave`** (this plan): short leave.
3. **`feat/employee-attendance-rules`**: after go-live. See
   `docs/plans/employee-attendance-rules.md`.

## How leave works today (checked in the code, 9 Oct 2026)

- **Types and settings.** Leave types live in the database, per company. Five
  are seeded for a new company: CL 12, SL 12, EL 15 (carry forward up to 30),
  WFH 0, CO 0. All are paid.
  - In Settings → Leave Config → Leave Types: Days / Year, Paid, carry forward
    and its cap.
  - Behind each type's sliders (`LeaveTypeRulesDialog.jsx`): earned all at once
    or monthly, notice days, most days in one application, "Usable after (days
    of service)", gender, half days, calendar days, encashment.
- **One number per type for everybody.** There is no per-employee quota. HR
  can only "Correct" a balance by hand (`adjustBalance`).
- **Grants are manual.** HR presses "Grant leave" on the Leave page, and a
  joiner added mid-year gets their share only when it is pressed again
  (`domain/leave/grant.ts`: pro-rated by the months left, never twice, quota-0
  types never granted).
- **The balance check refuses every type, unpaid ones too.**
  `checkBalance` gives "no balance to draw on — ask HR" for quota 0, or "You
  are N days short". The form's Submit is disabled. So an unpaid type cannot
  be used without days being granted to it.
- **The ledger** is debited on approval (`consumed`); a reversal adds the days
  back. Available = balance − pending − unearned.
- **Payroll is already right.** An approved unpaid-leave day is 1 day of loss
  of pay, half a day 0.5 (`payDays.ts lossOfPay`, `paid` from
  `leaveType.isPaid`). Absence without leave is LOP too.
- **Work From Home is twice over.** It is a quota-0 leave type, useless, and
  shown as "0 days available". It is also the real Requests flow
  (`work_from_home`: approved, then check-in that day records WFH). No code
  reads the WFH leave-type code.

## Part 1: `feat/leave-policy`

### 1a. Who gets how much, and from when: settings per leave type

All of these are in Settings → Leave Config, per type. Defaults are today's behaviour.

| Setting | Options | Default |
|---|---|---|
| Days per year | any number (exists) | CL 12, SL 12, EL 15 |
| How it is earned | all at once / monthly (exists) | all at once |
| **A new joiner gets** | the months left (pro-rated) / the full year / nothing until next month | the months left |
| **Usable from** | first day / after N days of service (exists) / **after confirmation** (end of probation) | first day |
| Who may use it | all / women / men (exists) | all |
| Notice, most per application, half days, calendar days, encashment, carry forward | (exist) | as today |

### 1b. A person's own entitlement (per-employee override)

- Add/Edit Employee and the profile get a **"Leave"** block: per type, that
  person's own days per year. Blank means the type's.
- Changing it mid-year applies the difference to this year's balance at once
  (12 → 15 adds 3), with an audited ledger `adjustment` and a note.
- Set by whoever holds `leave:balance:manage`. The record rules hold: never
  one's own record, never a senior's; the Super Admin is exempt.

### 1c. Automatic grants

- **On creating an employee**, or on setting their joining date, their share of
  this leave year is granted at once, by the type's "new joiner" rule and any
  override.
- **At the start of each leave year**, the daily maintenance job grants
  everybody, carry forward included. It is idempotent: `planGrant` never grants
  twice.
- HR's "Grant leave" button stays for previews and checks, but is no longer
  needed.

### 1d. Loss of Pay

- **A "Loss of Pay" type, code LOP, unpaid**, is seeded for new companies. A
  migration adds it to every existing company **that has no unpaid type yet**.
  It can be renamed or archived like any type.
- **The limit on an unpaid type is a setting.** Days per year **0 means no
  limit**: the balance check is skipped, approval is still needed, and every
  day is loss of pay. N means at most N a year: granted, and checked like any
  type. The default for LOP is 0.
- Unpaid types cannot carry forward or be encashed (forced off in the form and
  the validator).

### 1e. "The rest as Loss of Pay"

The case: the chosen paid type is short (1 day of CL, 3 asked), and the company
has an unpaid type with no limit.

- The preview returns the offer, and the form says: **"You have 1 day of Casual
  Leave. Take 1 day as Casual Leave and 2 days as Loss of Pay?"** with an
  **"Apply like this"** button.
- For a paid type with nothing at all (Comp Off 0): **"You have no Comp Off.
  Apply as Loss of Pay?"**
- **One application, two parts.** Two `LeaveRequest` rows are created in one
  transaction and linked by a new `groupId`. The paid part takes the earliest
  whole working days; the rest is unpaid.
- **Decided together:** approve, reject, withdraw and reverse act on the whole
  group. The approver sees one item, e.g. "Priya · 1 day Casual + 2 days Loss
  of Pay". Notifications go out once.
- Payroll needs no change: it reads each part's type.
- With no unlimited unpaid type in the company, nothing changes: today's
  message, and Submit stays disabled.

### 1f. Work From Home off the leave list

- It is no longer seeded. A migration **archives** it in existing companies:
  history is kept and still shown in reports as "(archived)".
- The apply form gets a hint: "Working from home? Requests → New request →
  Work from home." The Requests flow is unchanged.

### 1g. How it looks

- **Apply dropdown:** "Loss of Pay — unpaid, no limit".
- **Leave page → Balance:** paid types as rings. LOP as a small card, "taken
  this year: N days".
- **Home Leave balance card:** paid types as today. LOP only once taken.
- **HR Team Balances:** the LOP column shows days taken. There is no "Correct"
  for an unlimited type.
- **Approval lists:** LOP has its own coloured chip, so the pay cut is seen.
- **Payslip:** "Loss of pay days", as today.

### Data, compatibility, tests (Part 1)

- **Migration:**
  - LeaveType gets "new joiner" and "usable from"; a new `EmployeeLeaveEntitlement`
    table holds overrides (employee, type, days); LeaveRequest gets `groupId`.
  - Data: LOP is added where no unpaid type exists, and WFH is archived.
  - **Neon must migrate** after merge.
- **Tests:**
  - **Domain:** the entitlement rules (new joiner / usable from / override /
    mid-year change); unpaid with no limit vs with a limit; splitting a range
    into whole days.
  - **Integration:** preview offers the split; apply creates the group in one
    transaction (and concurrently); group approve, reject, withdraw and
    reverse; payroll LOP from the LOP part; the automatic grant on create and at
    year start; the migration; permissions; the audit.
  - **E2E, a new suite:** Super Admin sets CL to 10 and "usable after 30 days";
    HR gives Priya 15; Priya with 1 day left applies for 3 → the offer → Apply
    like this → her manager sees one item → approves → balances (CL 0, LOP 2) →
    payroll cuts 2 days; Comp Off 0 → the LOP offer; WFH not in the dropdown,
    and the hint shown; on a phone too.
  - **Existing suites:** `day20` Team Balances columns become "CL, CO, EL, LOP,
    SL"; `referenceData.test` keeps 5 types (LOP in, WFH out); golden and
    every other suite.
  - An independent review.
- **Docs:** the client docs (Roles and Approvals, Go-Live Guide), the role
  document, DEMO.md, traceability, CLAUDE.md.

## Part 2: `feat/short-leave`

**Decided 9 Oct 2026: short leave is paid within the limit. Past the limit it
cannot be applied for; the person takes a half day or leave instead.**

### Settings (Settings → Leave Config → "Short leave")

| Setting | Default |
|---|---|
| On / off | on |
| Longest single short leave | 120 minutes |
| How many a month | 2 |
| Notice | 0 days (the same day is fine) |
| Who approves | Settings → Approvals (manager or HR), as for other requests |

### Applying

- A **"Short leave"** button on the Leave page. The employee enters the day,
  from–to time (e.g. 16:30–18:30) and a reason.
- The form says how many are left this month ("1 of 2 left"). At the limit, or
  past the longest length, it explains and does not submit.
- It is built on the Requests engine as a new type, `short_leave`, which
  already has approval routing, notifications, withdraw and attachments. It is
  opened from the Leave page.

### Effect on the day (the key part)

- Approved short-leave minutes **count as worked** for the full-day and
  half-day thresholds.
- Lateness or early leaving that falls inside the short leave is **not marked**.
- Example: a 9h shift, full day at 8h. Priya leaves at 16:30 on an approved
  short leave until 18:30, having worked 7h. 7h plus 2h of short leave makes
  her **Present**, with no early-leaving mark and no pay cut.
- It is wired into the one grading path. The same `effectiveRules` /
  `measureDay` is used at check-out, HR mark, correction and import. A short
  leave approved after the day was graded **re-grades that day**.
- The roster and the employee's cards show "Short leave 16:30–18:30".
- Reports: short leaves per person per month.

### Tests (Part 2)

- **Domain:** minutes counted, marks waived, the monthly limit, the length limit.
- **Integration:** apply, approve, re-grade, reject, withdraw; the limits; the
  approver routing.
- **E2E:** Super Admin sets 120 min × 2; Priya applies, the manager approves,
  she leaves early, and she is Present; a third in the month is refused; on a
  phone too.
- All suites, golden, a review, and the docs.

## How to start

- **Part 1:** built (below).
- **Part 2:** **after go-live** (Devesh, 10 Oct 2026). Then Devesh says
  "**short leave wala kaam shuru karo**", and `feat/short-leave` branches from
  `main`.

## Part 1 as built (10 Oct 2026)

Migration `20261010051204_leave_policy_loss_of_pay` — **Neon must migrate after
the merge.**

- **Settings per type:** `LeaveType.joinerGrant` (`months_left` — the rule
  before, the joining month counted; `months_after_joining` — whole months
  only: a month joined partway is not counted, one joined on its 1st is (after
  the review, 10 Oct: somebody joining on the 1st has the whole month —
  confirmed by Devesh the same day); `full_year`) and
  `usableAfterConfirmation` (from `Employee.confirmedOn`; works beside
  "usable after N days"). In the rules dialog; summarised under the type.
- **One plan for every grant** (`modules/leave/leaveEntitlement.service.ts`
  over `domain/leave/grant.ts`): the button, `npm run grant-leave`, the nightly
  job, a joiner, a corrected joining date, a changed own number of days and a
  type's new days for everybody.
- **Automatic grants:** on Add Employee and the roster import, for people with
  a joining date (no date: their share is unknown — Grant leave names them);
  nightly in `scripts/maintenance.ts` (deploy/crontab), the current year, only
  people with **nothing at all** in that year's ledger (a balance HR typed in
  by hand stays HR's — the button shows and gives the rest), plus a carry that
  waited (below) for people whose year was granted.
- **Carry forward waits** until last year has nothing of that type applied
  for or waiting to be encashed — carried once it is never topped up, so a
  request rejected after the year turned would have lost its days. Every grant
  (button, terminal, nightly). A type given case by case (comp off) carries too.
- **A joining date set or corrected** moves each granted year by what the new
  date alone changes: the grant as given, scaled to the new share of the year
  (`yearShare`) — a type's days changed "from next year" is not brought in. A
  year not given at all yet is granted.
- **A year's grant changed** (own days, a type's new days with "this year") is
  set to what the rules give now, the difference written as an `opening_grant`
  entry (so monthly accrual follows). A cut goes only as far as what is left
  after days taken, applied for or waiting to be encashed; the answer says how
  much could not be taken back. HR's own corrections (`adjustment`) are never
  touched.
- **Own days a year:** `EmployeeLeaveEntitlement`; Add Employee (optional,
  paid types, `leave:balance:manage` + `leave:type:manage`) and the profile's
  Leave tab (`GET/PUT /api/leave-balances/people/:id[/entitlement]`,
  `leave:balance:manage`, leave scope, the record rules — never one's own,
  never a senior's). Audit `leave.entitlement_changed`; the person is told.
- **A type's new days for everybody:** from the next leave year (a year granted
  in advance changes to match, and is given to whoever had none of the type);
  "Also change this year's balances now" when asked, by somebody with
  `leave:balance:manage` — everybody already given the year gets the
  difference, or their share if they had none of it. Left for next year, a
  type nobody had (0 days until now) is marked as given at 0 this year for
  everybody already given the year, so neither the nightly grant nor the
  button gives it now. People with their own days keep theirs. A new type
  added mid-year is given by the button (it shows who would get it).
- **Loss of Pay:** an unpaid type with 0 days a year has no limit (`isUnlimited`);
  never corrected; unpaid types never carry forward or encash (refused by the
  server, off in the form). Seeded for new companies; the migration adds it
  where a company has leave types but no unpaid one, and archives the unused
  WFH type (quota 0, never given, nothing waiting).
- **The rest as Loss of Pay:** the preview's `offer` (first unlimited unpaid
  type in code order whose own rules the rest passes); apply with
  `restLeaveTypeId` **and `coveredDays`** — the paid days the person was shown,
  so a balance changed since is refused (409) rather than split elsewhere. Two
  requests, one `groupId`, created under the person's leave lock; approve,
  reject, withdraw and reverse act on every part in one transaction; one
  notice; lists and counts read one application (`domain/leave/applications.ts`).
  A last working day between the parts cancels only the part after it, told
  as itself.
- **Screens:** Apply (offer + "Apply like this", unpaid last, the Work from
  home pointer), Leave page (part chips, filter by any part, Loss of Pay card),
  Team Balances (days taken, no Correct), Home (Loss of Pay once taken; both
  parts named on waiting cards), Settings (No limit / Granted as needed; a
  monthly type's month share, "12 days · 1 day a month", in the table and the
  rules dialog; the days-a-year confirmation), profile Leave tab, Add Employee.
- **Reports → Leave balances:** an unpaid type with no limit shows the days
  taken ("Loss of Pay (taken)"), not a negative balance.
- **Three independent reviews (10 Oct)** — server, screens, rules and data —
  and their findings fixed: the nightly grant only for untouched people;
  "from next year" honoured for a type that had none; a joining-date fix by
  its own change only; carry waiting for last year; joining on the 1st under
  whole months; a decision raced by another answered 409, not 500; the
  person's leave lock before the payroll locks when a joining date changes (no
  deadlock with an approval); encashment reads the joiner rule; Loss of Pay
  reversed is worded as "no longer cut from pay"; the migration compares the
  Loss of Pay name and code in any letters; screens' wording, wrapping and
  validation.
- **Tests:** domain `policy.test.ts`; integration `leavePolicy.test.ts` (30,
  incl. the migration's data steps in a rolled-back transaction, two
  applications at once, the owner, a last working day between parts, the
  nightly rules, the carry that waits, "from next year" for a type that had
  none, the report); E2E `leavepolicy`; `day20` columns now CL, CO, EL, LOP, SL.
- **Leave day to day (A–E, Devesh 10 Oct 2026, same branch).** Migrations
  `20261010104705_leave_extras_absent_and_reminder` and
  `20261010143006_leave_year_end_notice` (Neon must migrate both):
  - **A — Attendance in pay terms:** `GET /api/attendance/me/pay-days`
    (`attendance:read`, one's own): days paid and unpaid so far by the payroll
    run's own reckoning (`lossOfPayOf`, shared with `planMonth`; `proration`),
    each approved leave day by its type, each absent **working** day with
    whether leave can still be asked (not if already applied, that month's own
    payroll is closed — a later month's does not count, as applying does not —
    or over 90 days back) and the leave asked for it (waiting, or approved for a
    half day / a punched day, which stay Absent beside it). The log and calendar
    name leave days ("Loss of Pay" in amber); the month figures add Paid days /
    Unpaid days (loss of pay); the manager's own calendar too, where the reason
    there is no button is in the day's title, and on a phone a dot marks a day
    to apply for or applied for.
  - **B — Statement:** `GET /api/leave-requests/statement` (own, or a decider's)
    and `GET /api/leave-balances/people/:id/statement` (HR): every ledger line,
    oldest first, the balance after each (zero-day markers left out), and
    `taken` (consumed less reversed). Whether the type has no limit is read
    with the person's own days, as Leave Balance reads it. Leave Balance cards
    and the profile's Leave tab open it.
  - **C — Year-end reminder:** `Organization.leaveYearEndReminderDays` (30, 1–90,
    Leave Config; `leave:type:manage`, audit `leave.reminder_updated`); the
    nightly job tells each person once (`leave.year_ending`) of the days that
    would lapse — what is left less what is applied for or encashing, all of it
    for a type that does not carry, the excess over the cap for one that does;
    unpaid types never (with a limit or without); nobody leaving before the year
    ends. "Told" is kept in `LeaveYearEndNotice` (unique org, employee, leave
    year), not read from the bell — a person who clears the bell is not told
    again the next night. One run at a time (lock `leave-reminder:{org}:{year}`).
  - **D — Absent → apply leave:** an absent day is never turned into Loss of Pay
    by itself. Whenever a day becomes absent (HR mark, machine import — once a
    person a file, correction, a short check-out) the person is told
    (`attendance.absent`, a switch in Notifications) on the logins they apply
    for leave from (`leave:apply`), with a link to the leave form on that day
    (`/leave?apply=1&from=&to=`, the form prefilled and costed; a date that is
    not a real day opens it empty; a login that cannot apply is told where to).
    A short check-out and its notice are one transaction, and the day closes
    only if still open (two taps tell once). Approving a whole day of leave on
    an absent day with no punch takes it over
    (`Attendance.statusBeforeLeave/sourceBeforeLeave`), so it says leave;
    reversing, or a last working day settling it, puts it back
    (`releaseLeaveDays`); HR's mark, a correction or an import over it clears
    the memory. A punched day is never taken over. The next machine file of the
    month with that day blank is taken: the line is left as the leave (summary
    `on_leave`); with times on it, it is still refused. The person's leave lock
    is taken before the payroll locks when a joining date changes.
  - **E — Team away:** on `/leave-requests/team`, each waiting application has
    `team_away`: the asker's teammates (same reporting manager) with leave
    waiting or approved touching its days, one line an application (parts
    whole). Shown under the request on Team Requests and the Home waiting card.
    Null for somebody with nobody above them: no team was looked at, so nothing
    claims nobody is away.
  - Two independent reviews (server, screens); every finding fixed as above.
  - Tests: `leaveExtras.test.ts` (15), domain `awayDuring`; E2E `leaveextras`.
- **Before the nightly job is switched on in production:** run
  `npm run maintenance` (no `--apply`) once and read `leaveGrantedTo` — it
  should be nobody, or the people expected.
