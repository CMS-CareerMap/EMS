import { PERMISSIONS, type Permission } from './permissions'
import type { DataScope, ScopedResource } from './scope'

/**
 * The seven roles every company starts with.
 *
 * Since Day 21 roles live in the database and the Super Admin edits them, so
 * this file is no longer what the server consults on a request. It is three
 * other things:
 *
 *   - the STARTING POINT. A database trigger copies these into every new
 *     company (migration …_roles_table); roles.test.ts checks the trigger's
 *     copy against this one, so the two cannot drift;
 *   - what "Reset to default" puts back;
 *   - the client's permission matrix as code, which authz.test.ts checks
 *     against Role_Permission_Documentation.md.
 *
 * super_admin is ENUMERATED rather than given a wildcard. A wildcard silently
 * grants every permission added later, including ones that did not exist when
 * anyone last thought about who should have them. Writing the list out means
 * adding a permission forces a decision — and since Day 21 that decision is a
 * migration, because a permission added to the code reaches no company's roles
 * until one gives it.
 */

export interface RoleDefinition {
  key: string
  name: string
  description: string
  /** The role this one comes under; null only for the Super Admin. */
  parentKey: string | null
  /** Nobody edits it: the Super Admin role. */
  locked: boolean
  permissions: readonly Permission[]
  scopes: Readonly<Record<ScopedResource, DataScope>>
}

/** The role that holds everything and can never be edited. */
export const SUPER_ADMIN_ROLE = 'super_admin'
/** The role a new login gets unless somebody chooses another. */
export const EMPLOYEE_ROLE = 'employee'

const ORG: DataScope = 'ORGANIZATION'
const EXCEPT_SENIORS: DataScope = 'ORGANIZATION_EXCEPT_ABOVE'
const TEAM: DataScope = 'DIRECT_REPORTS'
const SELF: DataScope = 'SELF'

/** Everything. Listed, not inferred. */
const SUPER_ADMIN: readonly Permission[] = PERMISSIONS

/**
 * An operator, not a member of staff. Manages people and documents; has no
 * business seeing attendance, leave or payroll.
 */
const ADMIN: readonly Permission[] = [
  'dashboard:read',
  'employee:read',
  'employee:create',
  'employee:update',
  'leave:type:manage',
  'document:read',
  'document:upload',
  'document:verify',
  'document:company:read',
  'document:company:manage',
  'document:type:manage',
  // Their own payslips — the data scope keeps it to themselves.
  'payslip:read',
  'notification:read',
]

/**
 * Runs the people side day to day. No payroll, no settings.
 *
 * Since Day 22 (the client's model): HR sees every leave request but approves
 * none — the person each employee reports to does. And HR sees salaries,
 * because HR agrees them with the employee, on the employee's record only and
 * never a senior's (compensation scope "Whole company, except seniors"). HR
 * still has no Payroll: Payroll shows every salary to whoever opens it.
 */
const HR: readonly Permission[] = [
  'dashboard:read',
  'employee:read',
  'employee:create',
  'employee:update',
  'employee:identity:read',
  'employee:compensation:read',
  'attendance:read',
  'attendance:punch',
  'attendance:mark',
  'attendance:update',
  'attendance:delete',
  'leave:read',
  'leave:apply',
  // Grants the leave year and corrects balances — HR runs leave day to day.
  'leave:balance:manage',
  'leave:type:manage',
  'holiday:manage',
  // Incentive, entered per employee per month (§A1.5). The amount they enter,
  // and nothing else of anybody's pay.
  'payroll:entry:manage',
  'document:read',
  'document:upload',
  'document:verify',
  'document:company:read',
  'document:company:manage',
  'document:type:manage',
  // Their own payslips, and nobody else's: payslip scope is SELF for HR.
  'payslip:read',
  'notification:read',
]

/**
 * Sees their own team. The same permission strings as HR for reading — what
 * differs is the DATA SCOPE, which limits them to direct reports. Approving
 * the team's leave needs no permission since Day 22: it comes from the team
 * reporting to them.
 */
const MANAGER: readonly Permission[] = [
  'dashboard:read',
  'employee:read',
  'attendance:read',
  'attendance:punch',
  'leave:read',
  'leave:apply',
  // Their own payslips. Scope SELF: a manager does not see their team's pay.
  'payslip:read',
  // No employee documents: §3.1 marks Documents ❌ for Manager and RM, and
  // §4.4 repeats it. The company's handbook and policies are §5's "All", so
  // those they read.
  'document:company:read',
  'notification:read',
]

/** The client's matrix gives RM and Manager identical rights. */
const RM: readonly Permission[] = MANAGER

/**
 * Payroll only. Holds compensation and bank reads because a payroll run cannot
 * be produced without them — and holds neither attendance nor leave, so the
 * person who moves the money cannot also alter the record it is based on.
 */
const ACCOUNTS: readonly Permission[] = [
  'dashboard:read',
  // Deliberately NOT employee:read. §3.1 marks the Employees module ❌ for this
  // role and §4.5 says "No access to: Employees page", while still allowing
  // "Employee financial data ... within payslip context". So the compensation
  // and bank reads below are reached through payroll endpoints, never through
  // the staff directory — which is what keeps finance isolated from people ops.
  'employee:compensation:read',
  'employee:bank:read',
  'employee:bank:manage',
  'payroll:structure:read',
  'payroll:structure:manage',
  'payroll:run:create',
  'payroll:entry:manage',
  'payslip:read',
  'document:company:read',
  'notification:read',
]

/**
 * Themselves, and nothing else. Every read here is narrowed to SELF by the data
 * scope, so `leave:read` means their own leave and `payslip:read` means their
 * own payslips.
 */
const EMPLOYEE: readonly Permission[] = [
  'dashboard:read',
  'attendance:read',
  'attendance:punch',
  'leave:read',
  'leave:apply',
  'document:read',
  'document:upload',
  'payslip:read',
  'document:company:read',
  'notification:read',
]

/*
 * WHO MAY CONFIGURE LEAVE — a judgement call the client delegated.
 *
 * `leave:type:manage` goes to super_admin, admin and HR. NOT to manager or RM,
 * deliberately: a manager who could raise the quota for the people they also
 * approve leave for would be on both sides of it. It is a separate permission
 * from settings:update so HR can add a leave type without being handed company
 * identity, statutory rates and user management.
 *
 * WHO KEEPS THE HOLIDAY CALENDAR — not in the client's matrix, so decided here.
 *
 * `holiday:manage` goes to super_admin and HR: a holiday is a decision about
 * both leave and attendance. Not admin, whom the matrix keeps out of both, and
 * not a manager — one team's lead should not declare a day off for the whole
 * company.
 */

/**
 * Whose rows each role reaches, from Role_Permission_Documentation.md §3.1.
 *
 * Manager and RM get ORGANIZATION on `employee` because the matrix says
 * "👁 View" there without qualifying it to their team, while it explicitly says
 * "🟡 Team" for attendance and leave. They still cannot see salary, bank or tax
 * identity — those are separate permissions they do not hold — so this is the
 * staff directory, not the personnel file.
 */
const scopes = (s: Record<ScopedResource, DataScope>) => s

/**
 * The order roles come in: whoever holds a role may give only the roles below
 * it (and never one with a power they lack themselves — user.policy). HR sits
 * above the team roles because HR adds people and gives them their logins;
 * Admin and Accounts, who do neither, sit beside HR under the Super Admin.
 */
export const DEFAULT_ROLES: readonly RoleDefinition[] = [
  {
    key: SUPER_ADMIN_ROLE,
    name: 'Super Admin',
    description: 'The owner of the system. Everything, including approving the payroll, reports, the audit log, settings, users and roles.',
    parentKey: null,
    locked: true,
    permissions: SUPER_ADMIN,
    scopes: scopes({ employee: ORG, compensation: ORG, attendance: ORG, leave: ORG, payslip: ORG, document: ORG }),
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Looks after employee records and documents.',
    parentKey: SUPER_ADMIN_ROLE,
    locked: false,
    permissions: ADMIN,
    scopes: scopes({ employee: ORG, compensation: SELF, attendance: SELF, leave: SELF, payslip: SELF, document: ORG }),
  },
  {
    key: 'hr',
    name: 'HR',
    description: 'Runs people operations day to day: employees, attendance, documents, holidays and monthly incentives. Sees all leave, gives the yearly leave and corrects balances. Sees salaries, except those of the people above them.',
    parentKey: SUPER_ADMIN_ROLE,
    locked: false,
    permissions: HR,
    scopes: scopes({ employee: ORG, compensation: EXCEPT_SENIORS, attendance: ORG, leave: ORG, payslip: SELF, document: ORG }),
  },
  {
    key: 'accounts',
    name: 'Accounts',
    description: 'Salaries and payroll: salary structures, the monthly payroll, bank accounts and the bank transfer file.',
    parentKey: SUPER_ADMIN_ROLE,
    locked: false,
    permissions: ACCOUNTS,
    scopes: scopes({ employee: ORG, compensation: ORG, attendance: SELF, leave: SELF, payslip: ORG, document: SELF }),
  },
  {
    key: 'manager',
    name: 'Manager',
    description: "Leads a team: sees the team's attendance and leave.",
    parentKey: 'hr',
    locked: false,
    permissions: MANAGER,
    scopes: scopes({ employee: ORG, compensation: SELF, attendance: TEAM, leave: TEAM, payslip: SELF, document: SELF }),
  },
  {
    key: 'rm',
    name: 'Reporting Manager',
    description: 'The same as Manager, under a different title.',
    parentKey: 'manager',
    locked: false,
    permissions: RM,
    scopes: scopes({ employee: ORG, compensation: SELF, attendance: TEAM, leave: TEAM, payslip: SELF, document: SELF }),
  },
  {
    key: EMPLOYEE_ROLE,
    name: 'Employee',
    description: 'Their own attendance, leave, payslips, documents and bank account.',
    parentKey: 'rm',
    locked: false,
    permissions: EMPLOYEE,
    scopes: scopes({ employee: SELF, compensation: SELF, attendance: SELF, leave: SELF, payslip: SELF, document: SELF }),
  },
]

const BY_KEY = new Map(DEFAULT_ROLES.map((r) => [r.key, r]))
const SETS = new Map(DEFAULT_ROLES.map((r) => [r.key, new Set<Permission>(r.permissions)]))

export const BUILT_IN_ROLE_KEYS: readonly string[] = DEFAULT_ROLES.map((r) => r.key)

export function defaultRole(key: string): RoleDefinition | undefined {
  return BY_KEY.get(key)
}

/** A built-in role's starting permissions. Throws for a key that is not built in. */
export function defaultPermissionsFor(key: string): readonly Permission[] {
  const role = BY_KEY.get(key)
  if (!role) throw new Error(`No built-in role "${key}"`)
  return role.permissions
}

export function defaultRoleCan(key: string, permission: Permission): boolean {
  return SETS.get(key)?.has(permission) ?? false
}

export function defaultScopeFor(key: string, resource: ScopedResource): DataScope {
  const role = BY_KEY.get(key)
  if (!role) throw new Error(`No built-in role "${key}"`)
  return role.scopes[resource]
}
