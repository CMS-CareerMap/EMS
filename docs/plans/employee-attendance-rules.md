# Plan: attendance rules per employee

Status: **planned, not started.** It is built after the website is live, on its
own branch, `feat/employee-attendance-rules`. Asked for by the client on 9 Oct
2026, through Devesh.

## What the client wants

When HR or the Super Admin adds a new employee (or edits one), they set that
person's own attendance rules in the profile, and the person's days are marked
Present, Half day or Absent by those rules. Nothing is hardcoded. Each rule can
be changed later.

- **Work hours.** Some people work 9 hours a day, others 8.
- **Grace.** The client's word for time knocked off a full day, in hours or minutes.
  - With a 9-hour day and no grace, the person is Present only after working 9 hours.
  - With a 9-hour day and 1 hour of grace, the person is Present at 8 hours, and a Half day from 4h 30m.
- **Exception.** The shift may slide earlier or later. For example, the shift is
  10:00–19:00 and the person has 2 hours of exception. They may work 09:00–18:00,
  or 11:00–20:00, or anything in between, as long as they complete their 9 hours
  inside 09:00–20:00 (9 + 2 = 11 hours).

## How the app does it today (for context)

- Every rule lives on the **shift**, in Settings → Organisation → Shifts. That
  covers the shift's hours, "Full day from", "Half day from", the unpaid break,
  and, behind the sliders, punctuality grace, late and early thresholds, and
  overtime.
- An employee's profile only picks **which shift** they are on: the Add / Edit
  Employee form, `shiftId`.
- A day is graded in five places: punch-in (late), punch-out, HR mark/amend,
  attendance correction, and biometric import. All five go through
  `shiftRulesOf` / `gradedBy` (`server/src/domain/attendance/shiftRules.ts`). The
  display goes through `dayMinimums` / `fullDayHoursFor`: the Time today card's
  "Full day at 8h · … to go", the Timings card, and the roster's live time.

## The design: the shift is the template, the profile overrides it

### Settings on each employee (all optional; empty means "the shift's")

| Setting | Meaning | Example |
|---|---|---|
| Work hours | Hours in a full working day | 9 |
| Grace | Taken off a full day: Present from (work hours − grace) | 1h, or 30m |
| Half day from | Hours worked for a half day; under it, Absent | 4h 30m |
| Exception: start earlier | How much earlier than the shift start they may start | 1h |
| Exception: start later | How much later than the shift start they may start | 1h |

Two separate numbers ("earlier" and "later") keep it fully adjustable. The
client's "2 hours of exception" is 1h earlier plus 1h later. The form may also
offer one "Exception" box that splits evenly, with the two values editable
under it.

The **shift gets the same five settings** as defaults for everyone on it. The
seeded General shift keeps today's behaviour: 9h, grace 1h (Present at 8h),
half day 4h 30m, no exception. The Shifts table shows "9h · grace 1h", not
"Full day from 8h", so the shift and the profile use the same words. A data
migration converts the stored `minFullDayHours` into grace (hours − full day),
so no day is graded differently.

The shift's old "Grace period (minutes)", the punctuality one behind the
sliders, is renamed **"Late after (minutes)"** so it does not clash with the
new Grace.

### Effective rules: one function, used everywhere

`effectiveRules(shift, employee)` merges the two: each employee value, or the
shift's. Every grading point and every display uses it: the five grading
places, the Time today card, the Timings card, the roster and the dashboards.
So no screen can disagree with the stored status. On a half day of leave, work
hours, grace and half day are halved, as `forWorkedHalf` does today.

### Counting with an exception

Shift 10:00–19:00, work hours 9, exception 1h earlier and 1h later:

- **Window** = from (shift start − earlier) to (shift end + later): 09:00–20:00.
- **Hours counted** = the time inside the window, less any unpaid break.
- **Late** = arriving after (shift start + later), here 11:00, plus "Late after" minutes.
- **Left early** = leaving before (their own start + work hours).

| In | Out | Counted | Grace 0 | Grace 1h |
|---|---|---|---|---|
| 09:00 | 18:00 | 9h | Present | Present |
| 10:00 | 19:00 | 9h | Present | Present |
| 11:00 | 20:00 | 9h | Present | Present |
| 11:30 | 20:30 | 8h 30m (to 20:00); late 30m | Half day | Present |
| 08:00 | 17:00 | 8h (from 09:00) | Half day | Present |

With no exception (0 and 0), counting stays exactly as today: check-in to
check-out, less the break.

Night shifts work the same way: the window crosses midnight on instants, as
`stillAtWork` and the overnight rules already do.

### Where it is set and shown

- **Add Employee and Edit Employee.** An "Attendance rules" block under Shift.
  Each box shows the shift's value as a placeholder, plus a live preview line:
  *"Present from 8h · Half day from 4h 30m · may work 09:00–18:00 to 11:00–20:00"*.
- **Employee profile → Employment.** The same line, read-only for whoever cannot edit it.
- **Settings → Shifts.** The same five columns as the template.
- **The employee's own screens** use their effective rules:
  - the Timings card: "Full day 8h worked (9h less 1h grace) · Half day 4h 30m · Start 09:00–11:00";
  - the Time today card: "Full day at 8h · … to go".
- **Roster.** Optionally, a tooltip on the hours showing the person's rule.
- **Bulk employee import (CSV).** Five optional columns; blank means the shift's.

### Who may set it

Whoever may change the employee record: **HR, Admin and Super Admin**
(`employee:update`). The existing record rules still apply: never one's own
record, never a senior's; the Super Admin is exempt. Every change is audited,
before and after, like other employee edits.

### Data and compatibility

- **Employee**: five new nullable columns. Null means "the shift's".
- **Shift**: grace, start earlier and start later, replacing `minFullDayHours`
  through a converting migration. Half day stays.
- **Attendance row**: freeze the effective work hours at punch-in, as
  `expectedHours` is frozen today. The other rules are read as they stand when
  a day is graded or re-graded, as today.
- Past days keep their status. A day HR marks or corrects later is graded by
  the rules as they are then (today's behaviour).
- Payroll needs no change. It reads the statuses: half day = 0.5 loss of pay,
  absent = 1.
- Neon must run the migration when this ships.

### Tests

- **Domain**: `effectiveRules` merges each field; grace or no grace; the window
  (inside, before, after, across midnight); late and early with an exception;
  halving for half-day leave.
- **Integration**: punch-out, mark, correction and import each grade by the
  profile's rules; a profile with blanks falls back to the shift; the
  workplace and today answers carry the effective values; permissions (HR yes,
  own record no, senior no, Super Admin yes); audit rows.
- **E2E**, a new suite: HR sets 9h with no grace on one person and 9h with 1h
  grace on another; both check in; HR records their days; 8h and 9h give the
  right statuses; an exception day (11:00–20:00) is Present; 11:30–20:30 is a
  Half day with no grace; the employee's cards say their rule; on a phone too.
- **All existing suites and golden**, an independent review, and the client
  docs: Roles and Approvals, and the Go-Live Guide.

## Open points to confirm with the client when building

1. Does time after the window (after 20:00 in the example) count as overtime,
   if overtime is on? Proposed default: no, only the window counts. Overtime is
   work past the work hours inside it.
2. Arriving before the window (08:00 in the example): proposed default is that
   it is not counted (above). Confirm.

## How to start it

Devesh says **"employee attendance rules wala kaam shuru karo"** (or anything
naming per-employee attendance rules, grace and exception). Then:

1. Branch `feat/employee-attendance-rules` from an up-to-date `main`.
2. Re-read this file.
3. Confirm the two open points.
4. Build in the order above (data → effective rules → grading points → UI →
   import → docs → tests).
