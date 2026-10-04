import { PERMISSIONS, RETIRED, SUPER_ADMIN_ONLY, type Permission } from './permissions'
import { DATA_SCOPES, type DataScope, type ScopedResource } from './scope'

/**
 * Every permission in plain words, grouped the way the Roles & Permissions
 * screen shows them (Day 21).
 *
 * The Super Admin ticks these; nobody reading "Approve, reject or cancel leave"
 * should need to know it is `leave:approve`. The same words appear in the audit
 * log when a role changes, so what the screen offered and what the log records
 * are one text.
 *
 * `resource` ties a module to its data scope: the choice of whose information
 * the role reaches (only their own, their team, their department, the whole
 * company) applies to every permission in it. Modules without one — payroll,
 * reports, settings — act on the company as a whole.
 */

export interface PermissionInfo {
  key: Permission
  label: string
  /** Permissions this one does not work without, ticked with it on the screen. */
  requires?: readonly Permission[]
  /**
   * True for a permission in a scoped module that reaches nobody else's rows —
   * one's own punch, the company's leave types, the holiday calendar, the
   * company's documents. Holding only these does not make the module's scope
   * mean anything, and they are left out when two roles' reach is compared.
   */
  unscoped?: boolean
  /**
   * The scoped module whose reach this permission works within, when it is
   * listed under another. Managing logins is under Settings, but whose logins
   * is the Employees scope — "Whose records".
   */
  reaches?: ScopedResource
}

export interface PermissionModule {
  key: string
  label: string
  resource: ScopedResource | null
  /** The question the scope answers in this module: "Whose leave". */
  scopeQuestion?: string
  /**
   * The scopes this module can honour, when not all of them. Payslips have no
   * list of a team's or a department's — only one's own, or the whole
   * company's through Payroll — so those are the only two offered.
   */
  scopes?: readonly DataScope[]
  /** Said on the screen under the module's name: what its scope does NOT cover. */
  note?: string
  permissions: readonly PermissionInfo[]
}

export const PERMISSION_MODULES: readonly PermissionModule[] = [
  {
    key: 'general',
    label: 'General',
    resource: null,
    permissions: [
      { key: 'dashboard:read', label: 'Open the dashboard' },
      { key: 'notification:read', label: 'See their own notifications' },
    ],
  },
  {
    key: 'employees',
    label: 'Employees',
    resource: 'employee',
    scopeQuestion: 'Whose records',
    note: 'Accepting a resignation needs no tick: like leave, it is decided by the person somebody reports to.',
    permissions: [
      { key: 'employee:read', label: 'See employee records' },
      { key: 'employee:create', label: 'Add employees', requires: ['employee:read'] },
      { key: 'employee:update', label: 'Edit employee records', requires: ['employee:read'] },
      { key: 'employee:identity:read', label: 'See PAN, UAN, PF and ESIC numbers, and personal details (date of birth, address, emergency contact)', requires: ['employee:read'] },
      {
        key: 'employee:lifecycle:manage',
        label: 'Run onboarding, probation, transfers, promotions and exits',
        requires: ['employee:update'],
      },
    ],
  },
  {
    key: 'salaries',
    label: 'Salaries',
    resource: 'compensation',
    scopeQuestion: 'Whose salaries',
    note: 'On employee records. Payroll and Reports show every salary to whoever can open them.',
    permissions: [{ key: 'employee:compensation:read', label: 'See salaries' }],
  },
  {
    key: 'attendance',
    label: 'Attendance',
    resource: 'attendance',
    scopeQuestion: 'Whose attendance',
    permissions: [
      { key: 'attendance:read', label: 'See attendance' },
      { key: 'attendance:punch', label: 'Punch in and out (their own)', unscoped: true },
      { key: 'attendance:mark', label: 'Mark attendance for other people', requires: ['attendance:read'] },
      { key: 'attendance:update', label: 'Correct attendance', requires: ['attendance:read'] },
    ],
  },
  {
    key: 'leave',
    label: 'Leave',
    resource: 'leave',
    scopeQuestion: 'Whose leave',
    note: 'Approving leave needs no tick: it follows the company tree. Whoever people report to decides their leave, whatever their role.',
    permissions: [
      { key: 'leave:read', label: 'See leave requests and balances' },
      { key: 'leave:apply', label: 'Apply for their own leave', requires: ['leave:read'] },
      { key: 'leave:balance:manage', label: 'Give the yearly leave and correct balances', requires: ['leave:read'] },
      { key: 'leave:type:manage', label: 'Set up leave types', unscoped: true },
      { key: 'holiday:manage', label: 'Keep the holiday calendar', unscoped: true },
    ],
  },
  {
    key: 'payroll',
    label: 'Payroll',
    resource: null,
    note: 'Payroll covers the whole company: whoever can open it sees every salary, payslip and bank account in it.',
    permissions: [
      { key: 'payroll:structure:read', label: 'Open Payroll and see salary structures' },
      { key: 'payroll:structure:manage', label: 'Enter and change salaries', requires: ['payroll:structure:read'] },
      // An incentive is pay: without seeing salaries, a role would reach only its
      // own row — which goes up the tree — and the tick would do nothing.
      { key: 'payroll:entry:manage', label: 'Enter monthly incentives', requires: ['employee:compensation:read'] },
      { key: 'payroll:run:create', label: 'Prepare the monthly payroll', requires: ['payroll:structure:read'] },
      { key: 'payroll:run:approve', label: 'Approve or reopen the payroll', requires: ['payroll:structure:read'] },
      { key: 'employee:bank:read', label: 'See bank accounts' },
      { key: 'employee:bank:manage', label: 'Record and check bank accounts', requires: ['employee:bank:read'] },
    ],
  },
  {
    key: 'payslips',
    label: 'Payslips',
    resource: 'payslip',
    scopeQuestion: 'Whose payslips',
    scopes: ['SELF', 'ORGANIZATION'],
    permissions: [{ key: 'payslip:read', label: 'See payslips' }],
  },
  {
    key: 'documents',
    label: 'Documents',
    resource: 'document',
    scopeQuestion: 'Whose documents',
    // An offer letter states the salary: a role that reaches somebody's
    // documents can read their pay there, whatever its "Whose salaries" says.
    note: 'Some documents show pay — an offer letter states the salary. A role that sees somebody’s documents can read what they say, whatever it may see of salaries.',
    permissions: [
      { key: 'document:read', label: 'See employee documents' },
      { key: 'document:upload', label: 'Upload employee documents', requires: ['document:read'] },
      { key: 'document:verify', label: 'Check and approve documents', requires: ['document:read'] },
      { key: 'document:company:read', label: 'Read company documents (policies, handbook)', unscoped: true },
      { key: 'document:company:manage', label: 'Publish or withdraw company documents', requires: ['document:company:read'], unscoped: true },
      { key: 'document:type:manage', label: 'Decide which documents everybody must provide', unscoped: true },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    resource: null,
    note: 'Reports cover the whole company, salaries included.',
    permissions: [{ key: 'report:read', label: 'See and download reports' }],
  },
  {
    key: 'settings',
    label: 'Settings and users',
    resource: null,
    note: 'Logins are managed for the people “Whose records” (under Employees) reaches. The audit log shows the whole company.',
    permissions: [
      { key: 'settings:read', label: 'Open company settings' },
      { key: 'settings:update', label: 'Change company settings', requires: ['settings:read'] },
      { key: 'user:invite', label: 'Invite people to EMS', reaches: 'employee' },
      { key: 'user:status:update', label: 'Turn a login on or off', reaches: 'employee' },
      { key: 'user:delete', label: 'Remove a person from EMS (their login is closed and their record archived; history is kept)', reaches: 'employee' },
      { key: 'membership:role:assign', label: "Change a person's role", reaches: 'employee' },
      { key: 'audit:read', label: 'Read the audit log' },
    ],
  },
]

/** How each scope reads on the screen and in the audit log. */
export const SCOPE_LABELS: Readonly<Record<DataScope, string>> = {
  SELF: 'Only their own',
  DIRECT_REPORTS: 'Their team',
  ALL_REPORTS: 'Everybody under them',
  DEPARTMENT: 'Their department',
  ORGANIZATION_EXCEPT_ABOVE: 'Whole company, except seniors',
  ORGANIZATION: 'Whole company',
}

/** What each scope means, said under the choice on the Roles screen. */
export const SCOPE_HINTS: Readonly<Record<DataScope, string>> = {
  SELF: 'Only their own information',
  DIRECT_REPORTS: 'The people directly under them, and themselves',
  ALL_REPORTS: 'Everybody below them in the company tree, at every level, and themselves',
  DEPARTMENT: 'Everybody in their department',
  ORGANIZATION_EXCEPT_ABOVE: 'Everybody, except the people above them in the company tree',
  ORGANIZATION: 'Everybody',
}

export const RESOURCE_LABELS: Readonly<Record<ScopedResource, string>> = {
  employee: 'Employees',
  compensation: 'Salaries',
  attendance: 'Attendance',
  leave: 'Leave',
  payslip: 'Payslips',
  document: 'Documents',
}

const INFO = new Map<Permission, PermissionInfo & { resource: ScopedResource | null }>(
  PERMISSION_MODULES.flatMap((m) => m.permissions.map((p) => [p.key, { ...p, resource: p.reaches ?? m.resource }] as const)),
)

/** Every permission a role can be given from the screen: all of them but the Super Admin's own. */
export const GRANTABLE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((p) => !SUPER_ADMIN_ONLY.has(p) && !RETIRED.has(p))

export function permissionLabel(permission: string): string {
  if (permission === 'role:manage') return 'Manage roles and permissions'
  if (permission === 'employee:delete') return 'Delete employee records'
  return INFO.get(permission as Permission)?.label ?? permission
}

/** The scopes a module's resource can honour — all of them unless the module says otherwise. */
export function scopesFor(resource: ScopedResource): readonly DataScope[] {
  return PERMISSION_MODULES.find((m) => m.resource === resource)?.scopes ?? DATA_SCOPES
}

/**
 * The scoped module whose rows a permission reaches, or null when it reaches
 * nobody else's — it acts on the company as a whole, or only on one's own.
 */
export function resourceOf(permission: Permission): ScopedResource | null {
  const info = INFO.get(permission)
  return info && !info.unscoped ? info.resource : null
}

/** Ticked permissions whose prerequisites are not ticked: [{ permission, needs }]. */
export function missingRequirements(permissions: ReadonlySet<Permission>): { permission: Permission; needs: Permission }[] {
  const missing: { permission: Permission; needs: Permission }[] = []
  for (const permission of permissions) {
    for (const needs of INFO.get(permission)?.requires ?? []) {
      if (!permissions.has(needs)) missing.push({ permission, needs })
    }
  }
  return missing
}
