/**
 * Every permission in the system, named once.
 *
 * Code asks `can('payroll:run:create')`, never `role === 'accounts'`. The
 * difference matters the first time the client says "let HR run payroll too":
 * with permissions that is one line in roles.ts, and with role checks it is a
 * hunt through every file for the ones somebody forgot.
 *
 * Because this is a union type rather than a list of strings, a typo like
 * 'payroll:run:crate' fails to compile instead of silently denying access
 * forever — which is the kind of bug nobody reports, because from the outside
 * it just looks like the feature does not work for them.
 *
 * WHAT versus WHOSE. A permission says what an action is; it does NOT say which
 * rows it covers. A manager and an employee both hold `leave:read`; what
 * differs is the data scope (see scope.ts), which decides whether that means
 * their team's leave or only their own. Splitting the two is what keeps this
 * list short — the alternative is a separate permission for every combination.
 */
export const PERMISSIONS = [
  'dashboard:read',

  // Employees. The three data-class reads are deliberately separate: salary,
  // banking and tax identity are held by different roles, and a single
  // 'employee:read' would hand all three to anyone who could see a name.
  'employee:read',
  'employee:create',
  'employee:update',
  'employee:delete',
  'employee:compensation:read',
  'employee:bank:read',
  // Entering a bank account and checking it against the cheque. Held by those
  // who pay; nobody may verify their own (bankAccount.service).
  'employee:bank:manage',
  'employee:identity:read',

  // Attendance. `punch` is what an employee does for themselves; `mark` is what
  // HR does on someone else's behalf, and they are not the same right.
  'attendance:read',
  'attendance:punch',
  'attendance:mark',
  'attendance:update',
  'attendance:delete',

  'leave:read',
  'leave:apply',
  'leave:approve',
  // Configuring leave TYPES — quotas, carry-forward, adding a new kind of
  // leave. Separate from settings:update because the client wants the people
  // who run leave to manage it, without also handing them company identity,
  // statutory rates and user management.
  'leave:type:manage',
  // Keeping the holiday calendar. Holidays decide which days leave does not
  // charge and attendance does not expect, so this sits with the people who
  // run leave and attendance day to day — not with company settings.
  'holiday:manage',

  'payroll:structure:read',
  'payroll:structure:manage',
  'payroll:run:create',
  'payroll:run:approve',
  // This month's amount of a monthly component — Incentive. Separate because
  // the client gives it to HR as well as Accounts (§A1.5), and HR holds
  // nothing else in payroll: no salaries, no runs, no payslips.
  'payroll:entry:manage',
  'payslip:read',

  'document:read',
  'document:upload',
  'document:verify',
  // The company's own documents — the handbook, the policies. §5 of the
  // client's document gives them to every role, which is wider than the
  // Documents module (employee files), so they are a permission of their own.
  'document:company:read',
  'document:company:manage',
  // What the compliance checklist asks every employee for.
  'document:type:manage',

  // One's own notices in the bell. Everybody; nobody can read anyone else's.
  'notification:read',

  'report:read',

  'settings:read',
  'settings:update',

  // User management. These four are what the original backend's edge
  // functions did, and nothing else replaces them.
  'user:invite',
  'user:status:update',
  'user:delete',
  'membership:role:assign',

  // Reading the audit log: who did what, including every salary change and
  // every document opened. Super Admin only.
  'audit:read',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS)
