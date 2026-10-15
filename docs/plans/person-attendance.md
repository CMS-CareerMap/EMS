# One person's attendance (client, 15 Oct 2026)

The client's second change after go-live.

What the client asked for:

- On Attendance, clicking an employee's name opens **that person's attendance**, the way a name on Employees opens the profile.
- The page shows a **month calendar** — the same one the employee sees for themselves.
- It shows **totals counted up to the day it is opened**. On the 15th, it counts the 1st to the 15th: working days, days present, absent, on leave, and hours worked. Today's time at work is added live while the person is still checked in.
- It is for **every role, by the company tree**: whoever has people under them sees those people's attendance.

Agreed with the client: managers also see **paid days and unpaid days (loss of pay)** on the page.

## As built

### One count, three places

- `domain/attendance/monthSoFar.ts` is the **one** count of a month so far. It is a pure function with tests.
  - The window runs from the later of the 1st and the joining day, to the earliest of the month's end, today and the last working day.
  - It returns working days, weekly offs, holidays, present, half days, absent, on leave, and not marked.
    - "Not marked" is a past working day with no row and no check-in.
    - A working day marked a holiday or weekly off for this person alone is a day off, as payroll pays it.
  - It also returns hours worked, expected hours, the average, arrivals and late days. Expected hours are the shift's hours for the days present, half days as half. Today counts once it is closed, as its hours do.
- Someone removed with no last working day is counted to the day they were removed, as payroll and the reports count them (`employed_until`).
- Three places use it, so they can never disagree:
  - the person page;
  - one's own Attendance page ("Attendance stats");
  - the home page's "My month".
- Paid days and unpaid days come from `payDaysFor`. This is the payroll run's own loss-of-pay reckoning, which `/me/pay-days` uses as well. Only the person themselves is offered "Apply leave" for an absent day.

### The endpoint

- `GET /api/attendance/people/:employeeId/month?year=&month=` needs `attendance:read`.
- The person must be inside the caller's **attendance reach** (`scopeFor('attendance')`). Anyone outside it gets a 404 ("That person's attendance is not one you see."). This works out to:
  - HR and the Super Admin: anybody;
  - a manager: their team;
  - an employee: themselves.
- People who have left are included, as history.
- The response carries:
  - the person (code, department, designation, joining day, last working day, `employed_until`, left, shift);
  - their days;
  - the company's days off;
  - the month in pay terms;
  - the totals, with `open_since` and `open_day`. The open day is the day they are still at work on, by the roster's own rule (`stillAtWork`): today's, or a night shift's day past midnight.
- **Which leave a day was is the person's leave.** Leave types by day, and leave asked for an absent day, are sent only to someone whose **leave** reach also takes the person in, or to the person themselves. Anyone else gets the days and the paid/unpaid counts only.
- `meta.server_now` lets the page run today's time by the server's clock. The month's figures and Day by day both count from `open_since` by that clock.

### The web

- `/attendance/people/:id?month=YYYY-MM` (`pages/PersonAttendance.jsx`):
  - a header with the person's name, a "Left" or "Last working day" chip, and a Profile link for those who may open profiles;
  - the month in figures (`MonthFigures`);
  - the calendar and a day-by-day log (`DayLog`): a table on a computer, a list on a phone.
  - Evidence of a day's punches is shown, but never for one's own days, unless the viewer is the Super Admin.
- Names link to the page from:
  - the day's roster (table and phone list);
  - the month's hours table;
  - Suspicious;
  - a new **Attendance** tab on the profile, for holders of `attendance:read`. Outside their reach, the tab says so in words.
- A month with nothing to count says why: they were not employed yet, or had left, or the month has not begun.
- The calendar fades the days after the last day, and Day by day stops at it.
- Evidence is offered only on days punched on the app, the roster's rule.
- "← Attendance" goes back to where the name was clicked: that day's roster, that month's hours, or Suspicious. Attendance reads `?date=` and `?month=` for this.
- Fixed along the way: the roster's Evidence button compared the wrong id for one's own row.

## Tests

- **Server:** `monthSoFar.test.ts` (8 tests).
- **Server:** `attendanceAdmin.test.ts`, "one person's month" (8 tests):
  - scope 404s;
  - a whole past month equal to the monthly hours;
  - the open day;
  - Apply leave for one's own days only;
  - leave types only within the leave reach;
  - someone removed with no last day;
  - someone who has left;
  - validation.
- **E2E:** `e2e/suites/personmonth.mjs`:
  - roster, monthly table, Suspicious and profile links, and back to where the name was clicked;
  - HR, manager, employee, Admin (no access) and Super Admin;
  - live time checked against the real clock, also from a computer 10 minutes fast;
  - the seeded September;
  - a person who has left (Day by day stops at the last day) and one who joined mid-month;
  - the self page and home page agreeing with the person page;
  - 390 px.
