import type { Role } from '@prisma/client'
import { PERMISSIONS, type Permission } from './permissions'

/**
 * Which role holds which permissions.
 *
 * Transcribed from Role_Permission_Documentation.md §3.1 and §3.2, which is the
 * client's own matrix. When they want a change, it is changed here and nowhere
 * else — and authz.test.ts asserts this file still matches that document.
 *
 * super_admin is ENUMERATED rather than given a wildcard. A wildcard silently
 * grants every permission added later, including ones that did not exist when
 * anyone last thought about who should have them. Writing the list out means
 * adding a permission forces a decision.
 */

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

/** Runs the people side day to day. No payroll, no settings. */
const HR: readonly Permission[] = [
  'dashboard:read',
  'employee:read',
  'employee:create',
  'employee:update',
  'employee:identity:read',
  'attendance:read',
  'attendance:punch',
  'attendance:mark',
  'attendance:update',
  'attendance:delete',
  'leave:read',
  'leave:apply',
  'leave:approve',
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
 * Sees their own team and approves its leave. The same permission strings as
 * HR for reading — what differs is the DATA SCOPE, which limits them to direct
 * reports. See scope.ts.
 */
const MANAGER: readonly Permission[] = [
  'dashboard:read',
  'employee:read',
  'attendance:read',
  'attendance:punch',
  'leave:read',
  'leave:apply',
  'leave:approve',
  // Their own payslips. Scope SELF: a manager does not see their team's pay.
  'payslip:read',
  // No employee documents: §3.1 marks Documents ❌ for Manager and RM, and
  // §4.4 repeats it. That leaves a manager with LESS document access than an
  // ordinary employee, which is unusual enough to be worth asking about —
  // see OPEN_QUESTIONS below. The company's handbook and policies are §5's
  // "All", so those they read.
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

const REGISTRY: Record<Role, readonly Permission[]> = {
  super_admin: SUPER_ADMIN,
  admin: ADMIN,
  hr: HR,
  manager: MANAGER,
  rm: RM,
  accounts: ACCOUNTS,
  employee: EMPLOYEE,
}

/** Lookup sets, so roleCan() is a hash probe rather than a scan of the array. */
const SETS: Record<Role, ReadonlySet<Permission>> = {
  super_admin: new Set(SUPER_ADMIN),
  admin: new Set(ADMIN),
  hr: new Set(HR),
  manager: new Set(MANAGER),
  rm: new Set(RM),
  accounts: new Set(ACCOUNTS),
  employee: new Set(EMPLOYEE),
}

export function permissionsFor(role: Role): readonly Permission[] {
  return REGISTRY[role]
}

export function roleCan(role: Role, permission: Permission): boolean {
  return SETS[role].has(permission)
}

/**
 * Every role holding a permission — how a notice finds "whoever can approve
 * this" without naming a role anywhere (§A5 rule 5).
 */
export function rolesHolding(permission: Permission): Role[] {
  return (Object.keys(SETS) as Role[]).filter((role) => SETS[role].has(permission))
}

/**
 * KNOWN GAP, raised with the client rather than quietly worked around.
 *
 * §3.2 gives `admin` and `accounts` no right to apply for leave. That is
 * coherent if those roles are pure operators — an outside accountant, say. But
 * a person holds exactly one role here, so an office manager who is BOTH an
 * administrator and a member of staff would have no way to request leave.
 *
 * Following the document as written until they answer. The fix, if they want
 * one, is to add 'leave:apply' to ADMIN and ACCOUNTS — one line each.
 */
/**
 * WHO MAY CONFIGURE LEAVE — a judgement call the client delegated.
 *
 * They asked for leave types to be "flexible", editable by whoever runs leave,
 * and left the exact roles to us. `leave:type:manage` goes to super_admin,
 * admin and HR.
 *
 * NOT to manager or RM, deliberately. A manager approves their own team's
 * requests; company-wide quotas and carry-forward rules are a different kind of
 * decision, and a manager who could raise the quota for the people they also
 * approve leave for would be on both sides of it.
 *
 * It is a SEPARATE permission from settings:update on purpose. Folding it in
 * would have meant giving HR company identity, statutory rates and user
 * management in order to let them add one leave type.
 */
/**
 * WHO KEEPS THE HOLIDAY CALENDAR — not in the client's matrix, so decided here.
 *
 * `holiday:manage` goes to super_admin and HR. HR runs leave and attendance,
 * and a holiday is a decision about both: leave is not charged for it, and
 * attendance does not expect anybody that day.
 *
 * Not admin, although admin holds leave:type:manage: the matrix keeps admin out
 * of attendance and leave records entirely, and the holiday calendar reaches
 * into both. Not a manager either — one team's lead should not declare a day
 * off for the whole company.
 *
 * Reading holidays needs only `leave:read`: everybody who applies for leave
 * needs to see which days are already off.
 */
export const OPEN_QUESTIONS = [
  'Can an admin or accounts user apply for their own leave? §3.2 currently says no.',
  'Can a manager or RM see documents at all? §3.1 and §4.4 say no, which leaves them with less access than the people they manage.',
] as const
