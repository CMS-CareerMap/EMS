# The demo company

A local copy of the app with a company already in it, to look at every role by hand.

```
cd e2e
npm install            # once
npm run demo           # first time: builds the company; after that: just starts it
```

Open **http://localhost:5183**. Every login's password is **`Demo@12345`**.
Ctrl+C stops it. The data stays until you rebuild it.

| What you want | Command |
|---|---|
| Start it again later | `npm run demo` |
| Throw it away and build it again, with today's dates | `npm run demo -- --fresh` |
| Pick up code changes first | `npm run demo -- --build` |

It has its own database, **`ems_demo`**, on your own Postgres (from `server/.env.test`).
It never touches Neon or your `:4000` / `:5173` servers. It uses the same ports as the
browser tests (`:4100`, `:5183`), so run one or the other.

## Who is in it

CareerMap Solutions (Demo), Pune: 16 people.

```
Rahul Mehta — Super Admin, the owner
├── Arjun Nair — Admin ............ └── Sunil Yadav
├── Hema Iyer — HR
├── Anil Kapoor — Accounts
├── Manoj Sharma — Manager, Sales
│   ├── Rekha Rao — Reporting Manager
│   │   ├── Priya Deshmukh — Employee
│   │   ├── Ravi Patil
│   │   └── Sneha Kulkarni
│   ├── Vikram Singh
│   └── Amit Verma (has resigned, waiting)
└── Karan Joshi — Technology (an Employee-role login with a team)
    ├── Pooja Shah
    ├── Neha Gupta (joined this month)
    └── Kiran Kumar (left last month)
```

| Role | Sign in with | Person |
|---|---|---|
| Super Admin | `superadmin@example.com` | Rahul Mehta |
| Admin | `admin@example.com` | Arjun Nair. His own leave and payslips: `arjun@example.com` |
| HR | `hr@example.com` | Hema Iyer |
| Accounts | `accounts@example.com` | Anil Kapoor. His own leave and payslips: `anil@example.com` |
| Manager | `manager@example.com` | Manoj Sharma |
| Reporting Manager | `rm@example.com` | Rekha Rao |
| Employee | `employee@example.com`, or the code `CMS007` | Priya Deshmukh |

Everybody else signs in as `firstname@example.com` (Employee role): ravi, sneha, vikram, amit,
karan, pooja, neha, sunil.

## What is already there

- The last two months of attendance for everybody, punched on the app, with a few absences and
  short days. This morning most people have checked in; Priya has not.
- Leave balances (CL 12, SL 12, EL 15 a year).
- Leave taken last month and the month before, each approved by the person above.
- Leave waiting for a decision: Sneha (Rekha decides), Vikram (Manoj), Rekha (Manoj), Manoj (Rahul).
- One rejected leave: Ravi's, with Rekha's reason.
- Requests waiting: Priya's attendance correction (she forgot to check out), Ravi's work from
  home (both Rekha), Vikram's on duty (Manoj), Sneha's change of phone and address (HR).
- Amit's resignation, waiting for Manoj to accept.
- The Employee Handbook, published by HR to everybody.
- Payroll: the month before last calculated, approved and paid (payslips are out); last month
  calculated by Accounts and **waiting for the Super Admin to approve**. Incentives for Priya
  and Vikram, and an advance for Ravi.

## What to try, role by role

### Employee — `employee@example.com` (Priya)
1. Home: press **Check In**. (No office location is set, so no GPS is asked for.) Her month in figures sits beside it.
2. Leave: see the balances; apply for a day next week. It goes to Rekha.
3. Requests: her correction is waiting for Rekha.
4. Payslips: the paid month's payslip; download the PDF.
5. Documents → Company documents: open the Employee Handbook. (My documents is where she
   uploads her own files for HR to check.)
6. The bell: the notices she has had.
7. Try a page she should not see, such as `/employees` or `/payroll`: it is not there.

### Reporting Manager — `rm@example.com` (Rekha)
1. Requests → **To decide**: approve Priya's correction and Ravi's work from home. Then
   Attendance shows Priya's day fixed.
2. Leave → **Team Requests**: approve or reject Sneha's leave.
3. Attendance: her team only. Employees: the directory, without anybody's salary.
4. Sign in as Priya again: she has a notice that it was approved.

### Manager — `manager@example.com` (Manoj)
1. Home → Waiting for you: Amit's resignation. **Accept** it and choose the last working day.
2. Leave → **Team Requests**: Vikram's and Rekha's leave.
3. Requests → **To decide**: Vikram's on-duty day.
4. His own leave, waiting for Rahul, is under Leave → Leave Requests.

### HR — `hr@example.com` (Hema)
1. Home: the company today (who is in, who is not marked), the leave waiting for others' decisions, and who is joining, in onboarding or serving notice.
2. Requests → **To decide**: approve Sneha's change of phone and address. Her record changes.
3. Employees → Neha Gupta → Employment: **Complete onboarding**. Kiran Kumar shows as left.
4. Attendance: mark a day for somebody; export the month.
5. Leave: everybody's leave and balances (she sees them all, decides none).
6. Payroll: she can enter an incentive, and sees nobody's full pay there.
7. Settings: leave types and their rules, holidays, document types, probation and notice.

### Accounts — `accounts@example.com` (Anil)
1. Payroll → Payroll runs: the paid month, and last month waiting for approval.
2. Open a run: each payslip, and the warnings it was calculated with.
3. After Rahul approves last month: **Mark as paid**, then **Bank file**.
4. Salary structures, components, loans (Ravi's advance), bank accounts.
5. No Employees page and no attendance: Accounts reaches pay only through Payroll.

### Admin — `admin@example.com` (Arjun)
1. Employees: records, but no salary, bank or PAN.
2. Documents: employee files and company documents.
3. Sunil reports to him, so Sunil's leave would come to him.
4. Sign in as `arjun@example.com` for his own leave and payslips.

### Super Admin — `superadmin@example.com` (Rahul)
1. Payroll → Payroll runs: **approve last month**. Then Accounts marks it paid, and the payslips reach everybody.
2. Leave → **Team Requests**: Manoj's leave is waiting for him.
3. Settings → Company, Users & Roles, Roles & Permissions, Company Tree, Approvals,
   Payroll Config (overtime is off until you turn it on), Notifications, Audit Log.
4. Audit Log: every step above, by whom, with old and new values.
5. Reports: attendance, leave, payroll, PF/ESI, headcount, joiners and exits.

### On a phone
In Edge or Chrome press F12, then the phone icon (Ctrl+Shift+M), and pick a phone. The app is
made for that width too. (The demo listens on this computer only, so a real phone cannot reach it.)
