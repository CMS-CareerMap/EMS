# No check-in means Absent, and the working week by day (client, 25 Oct 2026)

Changes asked the day before check-in started, after a look at one person's month in the demo.

What was asked:

- **"Punch nahi rhega to absent hi mana jayega."** A working day with no punch and no leave (casual leave, half day or loss of pay) is **Absent**, for everybody. A check-in and check-out short of the shift's half day stays Absent, as before (the client's 8 h / 4.5 h rule).
- **It works from whatever day it is turned on**, with every other setting.
- **Forgot to check out:** the day stays **Present**, as before. HR — and anybody the Super Admin gives the power — marks any day by hand.
- **No exceptions:** everybody punches.
- **The working week:** set from today, from the 1st of next month, or (setting it up) from the 1st of this month. Every screen must give the same answer for every day, for every role.
- **Marking the people ticked**, all at once — and only them — for a day the app was down.
- **A notice for a check-out not made**, and a **"No out"** filter for HR.
- **The person's month in plain words:** "31 of 31" paid days, and "16 h 54 m of 27 h" expected, puzzled.
- **The holiday calendar:** the next year's fixed holidays added by themselves, and a reminder for the festivals.

Left for later at the client's word: a reminder to check in; what working on a weekly off or holiday pays (overtime or comp off).

## As built

### 1. The working week, by day

- **`WorkWeek`** (settings.prisma): from `effectiveFrom`, these weekdays are off, until the next row begins. A row may begin in the future: a change saved for later. Before the first row, the first row's week applies; with none, Sunday.
  - The migration copied every policy period whose weekly offs differed from the one before.
  - `OrganizationPolicy.weeklyOffDays` is **no longer read**. It is carried forward, unread, for the version before.
- **`domain/shared/workWeek.ts`** decides every day: `offDaysOn`, `isWeeklyOff`, `withRuleFrom`, `daysThatChange`.
  - Leave counting, leave approval, the attendance calendar, the month so far, the home page, own Timings, payroll (the run, the preview, loss of pay, proration), pay days and the reports all read `workWeekOf(db)` and ask the domain.
  - Before, the calendar and payroll went by the rule in force on the 1st, and leave and the home page by today's. The same Saturday was off on one screen and a working day on another.
- **Lint rule 9** (`scripts/architecture.ts`): outside `domain/`, nothing reads `.weeklyOffDays` or works out a weekday (`getUTCDay`, `getDay`). The working week's repository and the carry-forward are the only exceptions.
- **Settings → Leave Config → Working Week:**
  - The page shows the week today and since when, and any change saved for later (with "Cancel this change").
  - **Change weekly offs** offers today, the 1st of next month, or the 1st of this month. The last is offered only while this month's payroll is open and today is not the 1st.
  - The server refuses:
    - a day before this month, or more than a year ahead;
    - a change that changes nothing;
    - a change touching a closed month.
  - A change from a day replaces any change saved after it. A change before every rule there is first writes the week the company had (from 2000-01-01), so the days before keep it — months paid included.
  - Cancelling a change saved for later is refused once the month it starts in is approved.
  - The answer says how many approved leave requests — however far ahead — cover a day whose being off changed. Leave is **not** recounted, as with holidays.
  - `GET / PUT /api/settings/work-week` and `DELETE /api/settings/work-week/:from`: `settings:read` to read, `settings:update` to change.
- Own Attendance → **Timings** shows today's week, and "From {day}: …" for a change saved for later.

### 2. No check-in means Absent

- **What each day should be is decided in one place:** `domain/attendance/noCheckIn.ts` (`verdictFor`, `isDue`, `judgedThrough`, `dayEndsAt`).
- **A day is due** when all of these hold:
  - the rule is on, and the day is on or after its start;
  - the person is employed that day — and their record was made by then (somebody added late with a joining day gone by could not have checked in before it), and, on the app, their first login too (with no login, never);
  - the day is over;
  - it is not a weekly off (by that day's week) or a holiday;
  - it is not wholly on approved leave.
- **When a day is over:**
  - On the app, once the shift ends — a night shift the next morning. With no shift, at midnight.
  - For days from the fingerprint machine's file or HR's marking, after the days of waiting (a setting, 3 to start, at least 1).
- **The rule only ever changes what it wrote:**
  - **`system`** (a new attendance source): a day with no row becomes Absent, with the note "No check-in".
  - **A half-day leave with no punch** becomes Absent, keeping `statusBeforeSystem = on_leave`. Half is paid as leave and half is loss of pay, which payroll already worked out from absent plus half paid leave.
  - **When a day is no longer due,** the rule takes it back. This happens when:
    - the rule is switched off or starts later;
    - a holiday or weekly off falls on the day;
    - leave is approved for the whole day (the row becomes leave);
    - the person's employment moves.
  - A row somebody else wrote is left alone, and any leftover `statusBeforeSystem` on it is cleared.
- **What other writes do to the rule's days:**
  - A punch, HR's mark, a correction and the machine's file replace a `system` row and clear `statusBeforeSystem`.
  - Approved leave takes over a `system` Absent (`takeOverAbsentDay`). Reversed, the leave gives it back.
  - Marking over a `system` row is **marking, not correcting** (`dayRecorded` leaves it out). A role holding only "Mark attendance" can mark it, and the machine's file replaces it without "Correct attendance".
- **One step puts the days right:** `reconcileAbsent` (`modules/attendance/absentRule.service.ts`).
  - It covers every month whose payroll is open, back a year at most.
  - It writes what is due and takes back what is not, under each month's payroll lock (`closedMonthKeysFor`). Closed months are reported and left alone.
  - It runs:
    - nightly, from `scripts/maintenance.ts` at 03:00 IST;
    - at once after a change of the rule, the working week or a holiday (`reconcileAfter`, which logs instead of failing the change).
  - Running it twice changes nothing.
- **The person is told** once for each month of days in a run (each month is its own transaction), with the days read back after writing — a day somebody wrote a moment before is not told: "no check-in, no leave", how to apply leave, and how to ask for a correction (`tellAbsent`, `noCheckIn`).
- **The audit log:**
  - `attendance.absent_rule` for each run that changed something, as a system job when nobody caused it;
  - `absent_rule.updated` for a change of the setting.
- **Settings → Attendance Security → No Check-in Means Absent:**
  - The page has an on/off switch, a "From" day (the 1st of last month at the earliest — a rule kept on keeps its older day, so its wait can still change; switched back on, it starts again) and the wait in days.
  - **Before saving** it previews how many days saving would mark absent, for how many people, how many it would give back, and which closed months it leaves alone.
  - `GET /api/settings/absent-rule`, `POST /api/settings/absent-rule/preview`, `PUT /api/settings/absent-rule`.
- **What people see:**
  - The day reads "Absent · no check-in" in the day log, and "No check-in" in the calendar.
  - On today's roster, someone on the app with nothing once their shift has ended reads "No check-in".
  - `no_check_in` and `day_over` are sent for each day.

### 3. Marking the people ticked

- On the day's roster, whoever holds "Mark attendance" ticks people.
  - Somebody whose day goes to another person (Day 22) cannot be ticked.
  - Nor can a day with a check-in: its times are its evidence.
- **"Mark the ticked…"** lists each person as they are and as they will be.
  - It needs a reason, which is kept on every day marked.
  - "On leave" is not offered.
- `POST /api/attendance/mark-many` marks each person exactly as marking them one by one would: the same reach, payroll lock, audit and notice.
  - Who could not be marked is named with the reason, and the rest are marked.
  - The server leaves out a day with a check-in too.

### 4. A check-out not made

- The day stays **Present** (the client's choice).
- **"No Out"** on the roster counts and filters days checked into and never out, once the day is over. The rule is the server's (`domain/attendance/noCheckIn` `noCheckOut`): the roster sends `no_out` for each person, and its export filters by the same. A day HR typed with a check-in only is as HR left it — on the roster, the calendar, the day log and the month's figures alike.
- The roster says when the day is **off for everybody** (`day_off`: a weekly off by that day's week, or a holiday), so nobody reads "No check-in" on it.
- **`scripts/hourly.ts`** runs every hour (`deploy/crontab`, at :10).
  - Two hours after the shift ends, it tells the person once: check out if still at work, ask for a correction if gone (`attendance.no_check_out`, `checkOutNudgedAt`).

### 5. The person's month in plain words

- **"Paid days 31 of 31" is removed** from the month (the client found it confusing even with words: it counted the whole month, days still to come included, beside figures counted to today). The month shows **Unpaid days (loss of pay)**, with "nothing cut so far" or what was cut, and the days not marked, paid until marked (`unpaidDaysWords`). The days paid are on the payslip. The same line is on Attendance → Monthly's "My attendance".
- **Expected hours** count only the days whose hours are known — on the person's month and on Attendance → Monthly's hours table alike.
  - A day checked into and never out is left out of both hours and expected, and said so ("1 day with no check-out not counted").
  - The day still open (today, or a night shift's yesterday) is not counted as missed.
- The calendar draws a past working day with nothing recorded as **"Not marked"** (dashed), with its key — on the person's month and one's own, which know the days the person was employed.
- **Reports → Attendance summary** counts its Weekly off and Holiday columns as the person's month does (`daysOffWithin`): the company's days off by the week in force on each day, and a day marked off for the person alone. They counted only days marked, so read nought.

### 6. The holiday calendar from year to year

- **From October**, the nightly job adds the next year's three fixed national holidays (`modules/holidays/holidayYear.service.ts`).
  - It adds them **once** (`Organization.fixedHolidaysThrough`), so one the company removed is not put back.
  - It never adds a day already gone, and never a day already entered under any name.
  - A missed year is caught.
- **In December**, whoever keeps the holiday calendar is told once if the next year has none of the festivals (`holidays.next_year_missing`, `Organization.holidayReminderYear`).

## Database

Migration `20261025082915_absent_rule_and_work_week`:

- the `WorkWeek` table, filled from the policy periods;
- the `system` attendance source;
- `Attendance.statusBeforeSystem` and `Attendance.checkOutNudgedAt`;
- `Organization.absentWithoutCheckIn`, `absentWithoutCheckInFrom`, `absentWaitDays`, `fixedHolidaysThrough` (filled from the fixed holidays a company has, by their days) and `holidayReminderYear`.

**Neon must migrate.**

## Tests

- **Domain:** `workWeek.test.ts`, `noCheckIn.test.ts`, `monthSoFar.test.ts`.
- **API on a real database:**
  - `workWeek.test.ts`: starts, a closed month, cancel, audit, refusing the payroll rules' field;
  - `absentRule.test.ts`: the run, half-day leave, a leave taken over and reversed, a holiday, a mark-only role, the people ticked, the setting, switched off, a closed month, a weekly-off change, the reminder, the roster, and **one answer for every role**;
  - `holidayYear.test.ts`.
- **Updated:** the leave, calendar, report and holiday tests, which now write `WorkWeek` rows.
- **Lint:** rule 9, with its own tests.
- **Browser:** `e2e/suites/absentrule.mjs`, plus `liveroster.mjs` (the tick column).

## At go-live

1. Run the migration on Neon, then deploy v1.2.
2. Check Settings → Leave Config → Working Week. If Saturday is off too, set it "from the 1st of this month" while October's payroll is open.
3. Check that this year's festivals are entered in Settings → Leave Config → Holidays. Without them, a festival day is a working day, and with the rule on, everybody is absent on it.
4. In Settings → Attendance Security, set "No check-in means absent". Choose the day it starts from (for example the day check-in began), read the preview, and save.
5. The server's `jobs` container picks up the new hourly line from `deploy/crontab` on the deploy.
