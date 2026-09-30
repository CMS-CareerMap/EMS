import { describe, it, expect } from 'vitest'
import type { Role } from '@prisma/client'
import { PERMISSIONS, type Permission } from './permissions'
import { permissionsFor, roleCan } from './roles'
import { scopeFor } from './scope'

/**
 * The client's permission matrix, as a test.
 *
 * Role_Permission_Documentation.md §3.2 is a table in a Word-style document
 * that nobody will re-read in three months. Transcribing it here means that
 * when somebody widens a role — for a good reason, in a hurry, on a Friday —
 * the build says which line of the client's document they just contradicted.
 *
 * Read this as the specification and roles.ts as the implementation. If the two
 * disagree, the client decides which one is wrong, not us.
 */

const ROLES: Role[] = ['super_admin', 'admin', 'hr', 'manager', 'rm', 'accounts', 'employee']

/**
 * §3.2 Action Permissions, transcribed verbatim.
 * ✅ becomes true, ❌ becomes false. 🟡 (Team) is still true here — the
 * narrowing to a team is the data scope's job, tested separately below.
 */
const MATRIX: Record<string, { permission: Permission; allowed: Role[] }> = {
  'Create employee': {
    permission: 'employee:create',
    allowed: ['super_admin', 'admin', 'hr'],
  },
  'Edit employee': {
    permission: 'employee:update',
    allowed: ['super_admin', 'admin', 'hr'],
  },
  'Delete employee': {
    permission: 'employee:delete',
    allowed: ['super_admin'],
  },
  'Mark attendance': {
    permission: 'attendance:mark',
    allowed: ['super_admin', 'hr'],
  },
  'Edit/delete attendance': {
    permission: 'attendance:update',
    allowed: ['super_admin', 'hr'],
  },
  'Apply for leave': {
    permission: 'leave:apply',
    allowed: ['super_admin', 'hr', 'manager', 'rm', 'employee'],
  },
  'Approve/reject leave': {
    permission: 'leave:approve',
    allowed: ['super_admin', 'hr', 'manager', 'rm'],
  },
  'Manage salary structures': {
    permission: 'payroll:structure:manage',
    allowed: ['super_admin', 'accounts'],
  },
  'Run payroll': {
    permission: 'payroll:run:create',
    allowed: ['super_admin', 'accounts'],
  },
  // Through their own payslip page and profile; every role has one.
  'Send in own bank account (with cheque/passbook proof)': {
    permission: 'payslip:read',
    allowed: ['super_admin', 'admin', 'hr', 'manager', 'rm', 'accounts', 'employee'],
  },
  'Upload documents': {
    permission: 'document:upload',
    allowed: ['super_admin', 'admin', 'hr', 'employee'],
  },
  // "(not own)" is the service's refusal, tested in documents.test.ts.
  'Verify/reject documents': {
    permission: 'document:verify',
    allowed: ['super_admin', 'admin', 'hr'],
  },
  'Read company documents': {
    permission: 'document:company:read',
    allowed: ['super_admin', 'admin', 'hr', 'manager', 'rm', 'accounts', 'employee'],
  },
  'Publish/withdraw company documents': {
    permission: 'document:company:manage',
    allowed: ['super_admin', 'admin', 'hr'],
  },
  'Edit the document checklist': {
    permission: 'document:type:manage',
    allowed: ['super_admin', 'admin', 'hr'],
  },
  'View reports': {
    permission: 'report:read',
    allowed: ['super_admin'],
  },
  'Read own notifications': {
    permission: 'notification:read',
    allowed: ['super_admin', 'admin', 'hr', 'manager', 'rm', 'accounts', 'employee'],
  },
  'Turn notification events on/off': {
    permission: 'settings:update',
    allowed: ['super_admin'],
  },
  'Invite users': {
    permission: 'user:invite',
    allowed: ['super_admin'],
  },
  'Manage roles/status': {
    permission: 'membership:role:assign',
    allowed: ['super_admin'],
  },
  'Delete users': {
    permission: 'user:delete',
    allowed: ['super_admin'],
  },
  'Change settings': {
    permission: 'settings:update',
    allowed: ['super_admin'],
  },
}

describe('the client permission matrix (Role_Permission_Documentation §3.2)', () => {
  for (const [action, { permission, allowed }] of Object.entries(MATRIX)) {
    it(`"${action}" is held by exactly ${allowed.join(', ')}`, () => {
      const actual = ROLES.filter((role) => roleCan(role, permission))
      expect(actual.sort()).toEqual([...allowed].sort())
    })
  }
})

describe('registry integrity', () => {
  it('super_admin holds every permission, enumerated rather than wildcarded', () => {
    expect([...permissionsFor('super_admin')].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('every role grants only permissions that exist', () => {
    const known = new Set<string>(PERMISSIONS)
    for (const role of ROLES) {
      const unknown = permissionsFor(role).filter((p) => !known.has(p))
      expect(unknown, `${role} grants unknown permissions`).toEqual([])
    }
  })

  it('no role lists the same permission twice', () => {
    for (const role of ROLES) {
      const list = permissionsFor(role)
      expect(new Set(list).size, `${role} has duplicates`).toBe(list.length)
    }
  })

  it('every permission is held by at least one role', () => {
    // An unreachable permission is dead code pretending to be a security
    // control, and it reads as if somebody is allowed to do the thing.
    const orphans = PERMISSIONS.filter((p) => !ROLES.some((r) => roleCan(r, p)))
    expect(orphans).toEqual([])
  })

  it('keeps the three compensation reads apart from plain employee reads', () => {
    // A manager may see the staff directory. A manager may NOT see salaries.
    // If these ever collapse into one permission, this is what notices.
    expect(roleCan('manager', 'employee:read')).toBe(true)
    expect(roleCan('manager', 'employee:compensation:read')).toBe(false)
    expect(roleCan('manager', 'employee:bank:read')).toBe(false)
    expect(roleCan('hr', 'employee:compensation:read')).toBe(false)
  })

  it('does not let the payroll role touch the records payroll is computed from', () => {
    // Separation of duties: whoever moves the money must not also be able to
    // adjust the attendance and leave the amount is derived from.
    expect(roleCan('accounts', 'attendance:mark')).toBe(false)
    expect(roleCan('accounts', 'attendance:update')).toBe(false)
    expect(roleCan('accounts', 'leave:approve')).toBe(false)
  })

  it('gives an ordinary employee nothing that reaches another person', () => {
    const employeeOnly = permissionsFor('employee')
    for (const forbidden of [
      'employee:create',
      'employee:update',
      'employee:delete',
      'attendance:mark',
      'leave:approve',
      'payroll:run:create',
      'report:read',
      'settings:update',
      'user:invite',
    ] as const) {
      expect(employeeOnly, `employee must not hold ${forbidden}`).not.toContain(forbidden)
    }
  })
})

describe('data scope (§3.1)', () => {
  it('confines an employee to their own rows everywhere', () => {
    for (const resource of ['employee', 'attendance', 'leave', 'payslip', 'document'] as const) {
      expect(scopeFor('employee', resource)).toBe('SELF')
    }
  })

  it('gives a manager their team for attendance and leave', () => {
    expect(scopeFor('manager', 'attendance')).toBe('DIRECT_REPORTS')
    expect(scopeFor('manager', 'leave')).toBe('DIRECT_REPORTS')
    expect(scopeFor('rm', 'attendance')).toBe('DIRECT_REPORTS')
    expect(scopeFor('rm', 'leave')).toBe('DIRECT_REPORTS')
  })

  it('does not let a manager read the whole company payroll', () => {
    expect(scopeFor('manager', 'payslip')).toBe('SELF')
  })

  it('gives super_admin the organization everywhere', () => {
    for (const resource of ['employee', 'attendance', 'leave', 'payslip', 'document'] as const) {
      expect(scopeFor('super_admin', resource)).toBe('ORGANIZATION')
    }
  })
})

/**
 * §3.1 Module Access, transcribed.
 *
 * This table was NOT covered when the registry was first written, and two
 * mistakes got through as a result: Accounts was given the Employees page, and
 * Manager was given Documents — both marked ❌ in the client's own matrix. It is
 * here now so the same class of mistake fails the build instead.
 *
 * Each module is represented by the permission that opens it. A ✅, a 👁 and a
 * 🟡 all mean "can open it"; how much they then see is the data scope, tested
 * separately.
 */
const MODULE_ACCESS: Record<string, { permission: Permission; allowed: Role[] }> = {
  Dashboard: {
    permission: 'dashboard:read',
    allowed: ['super_admin', 'admin', 'hr', 'manager', 'rm', 'accounts', 'employee'],
  },
  Employees: {
    permission: 'employee:read',
    allowed: ['super_admin', 'admin', 'hr', 'manager', 'rm'],
  },
  Attendance: {
    permission: 'attendance:read',
    allowed: ['super_admin', 'hr', 'manager', 'rm', 'employee'],
  },
  Leave: {
    permission: 'leave:read',
    allowed: ['super_admin', 'hr', 'manager', 'rm', 'employee'],
  },
  Payroll: {
    permission: 'payroll:structure:read',
    allowed: ['super_admin', 'accounts'],
  },
  'Documents — employee files': {
    permission: 'document:read',
    allowed: ['super_admin', 'admin', 'hr', 'employee'],
  },
  'Documents — company documents': {
    permission: 'document:company:read',
    allowed: ['super_admin', 'admin', 'hr', 'manager', 'rm', 'accounts', 'employee'],
  },
  Reports: {
    permission: 'report:read',
    allowed: ['super_admin'],
  },
  Settings: {
    permission: 'settings:read',
    allowed: ['super_admin'],
  },
  'Notifications (the bell)': {
    permission: 'notification:read',
    allowed: ['super_admin', 'admin', 'hr', 'manager', 'rm', 'accounts', 'employee'],
  },
}

describe('the client module matrix (Role_Permission_Documentation §3.1)', () => {
  for (const [module, { permission, allowed }] of Object.entries(MODULE_ACCESS)) {
    it(`"${module}" opens for exactly ${allowed.join(', ')}`, () => {
      const actual = ROLES.filter((role) => roleCan(role, permission))
      expect(actual.sort()).toEqual([...allowed].sort())
    })
  }

  it('keeps Accounts out of the staff directory while still paying people', () => {
    // §4.5: "No access to: Employees page" AND "Can view: Employee financial
    // data ... within payslip context". Both, simultaneously.
    expect(roleCan('accounts', 'employee:read')).toBe(false)
    expect(roleCan('accounts', 'employee:compensation:read')).toBe(true)
    expect(roleCan('accounts', 'employee:bank:read')).toBe(true)
  })
})

describe('leave configuration, delegated by the client', () => {
  it('is held by super_admin, admin and HR — the people who run leave', () => {
    const actual = ROLES.filter((role) => roleCan(role, 'leave:type:manage'))
    expect(actual.sort()).toEqual(['admin', 'hr', 'super_admin'])
  })

  it('is NOT held by a manager who approves the requests', () => {
    // A manager raising the quota for the same people whose requests they
    // approve would be on both sides of the decision.
    expect(roleCan('manager', 'leave:type:manage')).toBe(false)
    expect(roleCan('rm', 'leave:type:manage')).toBe(false)
    // They can still approve; only the configuration is out of reach.
    expect(roleCan('manager', 'leave:approve')).toBe(true)
  })

  it('does not drag company settings along with it', () => {
    // The point of a separate permission: HR configures leave without being
    // handed statutory rates, company identity and user management.
    expect(roleCan('hr', 'leave:type:manage')).toBe(true)
    expect(roleCan('hr', 'settings:update')).toBe(false)
    expect(roleCan('hr', 'user:invite')).toBe(false)
  })
})

describe('the holiday calendar', () => {
  it('is kept by super_admin and HR, the people who run leave and attendance', () => {
    const actual = ROLES.filter((role) => roleCan(role, 'holiday:manage'))
    expect(actual.sort()).toEqual(['hr', 'super_admin'])
  })

  it('is not kept by a manager or an admin', () => {
    // A team lead must not declare a day off for the whole company, and the
    // matrix keeps admin out of leave and attendance records.
    expect(roleCan('manager', 'holiday:manage')).toBe(false)
    expect(roleCan('admin', 'holiday:manage')).toBe(false)
  })
})

describe('monthly entries — Incentive', () => {
  it('are entered by super_admin, HR and Accounts, as the client asked (§A1.5)', () => {
    const actual = ROLES.filter((role) => roleCan(role, 'payroll:entry:manage'))
    expect(actual.sort()).toEqual(['accounts', 'hr', 'super_admin'])
  })

  it('give HR nothing else of payroll', () => {
    // Entering an incentive is not reading a salary, running a payroll or
    // opening the Payroll module.
    expect(roleCan('hr', 'payroll:structure:read')).toBe(false)
    expect(roleCan('hr', 'payroll:run:create')).toBe(false)
    expect(roleCan('hr', 'employee:compensation:read')).toBe(false)
  })
})

describe('payslips', () => {
  it('are readable by every role — each person their own', () => {
    for (const role of ROLES) expect(roleCan(role, 'payslip:read'), role).toBe(true)
  })

  it('reach the whole company only for payroll staff; everybody else sees their own', () => {
    const wide = ROLES.filter((role) => scopeFor(role, 'payslip') === 'ORGANIZATION')
    expect(wide.sort()).toEqual(['accounts', 'super_admin'])
    for (const role of ['admin', 'hr', 'manager', 'rm', 'employee'] as const) {
      expect(scopeFor(role, 'payslip'), role).toBe('SELF')
    }
  })

  it('are signed off by the approver, not by whoever prepared them', () => {
    // Accounts prepares the run and records the payment; approving it is a
    // separate right, so one person does not both prepare and sign.
    expect(ROLES.filter((role) => roleCan(role, 'payroll:run:approve'))).toEqual(['super_admin'])
    expect(roleCan('accounts', 'payroll:run:create')).toBe(true)
  })
})

describe('bank accounts for salary', () => {
  it('are entered and checked only by those who pay — Accounts and Super Admin', () => {
    expect(ROLES.filter((role) => roleCan(role, 'employee:bank:manage')).sort()).toEqual(['accounts', 'super_admin'])
  })

  it('are never managed by somebody who cannot read them', () => {
    for (const role of ROLES) {
      if (roleCan(role, 'employee:bank:manage')) expect(roleCan(role, 'employee:bank:read'), role).toBe(true)
    }
  })
})

describe('documents (Day 19)', () => {
  it('keep employee files to the client’s matrix — no manager, RM or Accounts', () => {
    expect(ROLES.filter((role) => roleCan(role, 'document:read')).sort()).toEqual(['admin', 'employee', 'hr', 'super_admin'])
    expect(ROLES.filter((role) => roleCan(role, 'document:upload')).sort()).toEqual(['admin', 'employee', 'hr', 'super_admin'])
  })

  it('reach the whole company only for those who verify; everybody else their own', () => {
    for (const role of ROLES) {
      const expected = roleCan(role, 'document:verify') ? 'ORGANIZATION' : 'SELF'
      expect(scopeFor(role, 'document'), role).toBe(expected)
    }
  })

  it('give the company’s handbook and policies to every role (§5: "All")', () => {
    for (const role of ROLES) expect(roleCan(role, 'document:company:read'), role).toBe(true)
  })

  it('let only Super Admin, Admin and HR publish them, or change the checklist', () => {
    expect(ROLES.filter((role) => roleCan(role, 'document:company:manage')).sort()).toEqual(['admin', 'hr', 'super_admin'])
    expect(ROLES.filter((role) => roleCan(role, 'document:type:manage')).sort()).toEqual(['admin', 'hr', 'super_admin'])
  })
})

describe('notifications (Day 19)', () => {
  it('are read by everybody — their own', () => {
    for (const role of ROLES) expect(roleCan(role, 'notification:read'), role).toBe(true)
  })

  it('are configured only by whoever changes settings', () => {
    expect(ROLES.filter((role) => roleCan(role, 'settings:update'))).toEqual(['super_admin'])
  })
})
