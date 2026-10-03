import { describe, it, expect } from 'vitest'
import { checkRoleInput, describeChange, keyFor, refuseDelete, refuseEdit, warningsFor } from './roles.policy'
import { DEFAULT_ROLES } from '../../platform/authz/defaultRoles'
import { GRANTABLE_PERMISSIONS, PERMISSION_MODULES, missingRequirements, scopesFor } from '../../platform/authz/catalogue'
import { PERMISSIONS, RETIRED, SUPER_ADMIN_ONLY, type Permission } from '../../platform/authz/permissions'
import type { RoleNode } from '../../platform/authz/roleOrder'

/**
 * The rules of the Roles screen, without a database: what a role may be saved
 * as, what it may never become, and how a change is put into words.
 */

const order = new Map<string, RoleNode>(DEFAULT_ROLES.map((r) => [r.key, { key: r.key, parentKey: r.parentKey }]))
const others = DEFAULT_ROLES.map((r) => ({ key: r.key, name: r.name }))
const input = (over: Partial<Parameters<typeof checkRoleInput>[0]> = {}) => ({
  name: 'Team Lead',
  description: '',
  parentKey: 'manager',
  permissions: ['leave:read', 'leave:balance:manage'],
  scopes: { leave: 'DIRECT_REPORTS' },
  ...over,
})

describe('the permission catalogue', () => {
  it('offers every permission but the Super Admin’s own, each exactly once', () => {
    const offered = PERMISSION_MODULES.flatMap((m) => m.permissions.map((p) => p.key))
    expect(new Set(offered).size).toBe(offered.length)
    expect([...offered].sort()).toEqual([...GRANTABLE_PERMISSIONS].sort())
    expect(PERMISSIONS.filter((p) => !offered.includes(p)).sort()).toEqual([...SUPER_ADMIN_ONLY, ...RETIRED].sort())
  })

  it('drops a retired permission a role still lists, instead of refusing the save', () => {
    // HR's starting role lists "attendance:delete", which nothing checks.
    const r = checkRoleInput(input({ parentKey: 'hr', permissions: ['attendance:read', 'attendance:delete'], scopes: { attendance: 'ORGANIZATION' } }), null, others, order)
    expect(r.ok).toBe(true)
    expect(r.ok && r.role.permissions).toEqual(['attendance:read'])
  })

  it('never offers a permission nothing checks — “Delete employee records” stays off the screen', () => {
    const offered = PERMISSION_MODULES.flatMap((m) => m.permissions.map((p) => p.key))
    expect(offered).not.toContain('employee:delete')
    // Nothing deletes attendance either.
    expect(offered).not.toContain('attendance:delete')
  })

  it('offers payslips only their own or the whole company, and every other module every scope', () => {
    expect(scopesFor('payslip')).toEqual(['SELF', 'ORGANIZATION'])
    // With the two that follow the company tree (Day 22).
    expect(scopesFor('leave')).toEqual(['SELF', 'DIRECT_REPORTS', 'ALL_REPORTS', 'DEPARTMENT', 'ORGANIZATION_EXCEPT_ABOVE', 'ORGANIZATION'])
  })

  it('names every permission in words, never twice the same', () => {
    const labels = PERMISSION_MODULES.flatMap((m) => m.permissions.map((p) => p.label))
    expect(new Set(labels).size).toBe(labels.length)
    for (const label of labels) expect(label).not.toMatch(/[a-z]+:[a-z]+/)
  })

  it('only ever needs permissions that exist, in a module somebody can tick', () => {
    const offered = new Set<string>(GRANTABLE_PERMISSIONS)
    for (const m of PERMISSION_MODULES) for (const p of m.permissions) for (const need of p.requires ?? []) expect(offered.has(need), `${p.key} needs ${need}`).toBe(true)
  })

  it('is satisfied by all seven roles EMS starts with', () => {
    for (const role of DEFAULT_ROLES) {
      expect(missingRequirements(new Set<Permission>(role.permissions)), role.key).toEqual([])
    }
  })
})

describe('what a role may be saved as', () => {
  it('accepts a sensible role, giving every module a scope', () => {
    const r = checkRoleInput(input(), null, others, order)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.role.scopes.leave).toBe('DIRECT_REPORTS')
      expect(r.role.scopes.payslip).toBe('SELF')
      expect(r.warnings).toEqual([])
    }
  })

  it('tidies the name and keeps the permissions in a stable order without repeats', () => {
    const r = checkRoleInput(input({ name: '  Team   Lead ', permissions: ['leave:balance:manage', 'leave:read', 'leave:read'] }), null, others, order)
    expect(r.ok && r.role.name).toBe('Team Lead')
    expect(r.ok && r.role.permissions).toEqual(['leave:balance:manage', 'leave:read'])
  })

  it.each([
    ['too short', { name: 'X' }, /2 to 40 characters/],
    ['odd characters', { name: 'Lead <script>' }, /letters, numbers/],
    ['taken, in any case', { name: 'reporting manager' }, /already a role called “Reporting Manager”/],
    ['no parent', { parentKey: 'nobody' }, /comes under/],
    ['a permission EMS does not know', { permissions: ['leave:read', 'leave:everything'] }, /not one EMS knows/],
    ['the Super Admin’s own', { permissions: ['role:manage'] }, /stays with the Super Admin/],
    ['missing what it needs', { permissions: ['leave:balance:manage'] }, /needs “See leave requests and balances” ticked too/],
    ['the leave approving that the company tree now decides', { permissions: ['leave:read', 'leave:approve'] }, /not one EMS knows/],
    ['a scope that is not one', { scopes: { leave: 'EVERYONE' } }, /Choose whose leave/],
    ['a module that is not one', { scopes: { payroll: 'ORGANIZATION' } }, /not one EMS knows/],
  ])('refuses %s', (_label, over, message) => {
    const r = checkRoleInput(input(over as Partial<Parameters<typeof checkRoleInput>[0]>), null, others, order)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(message)
  })

  it('lets a role keep its own name when edited', () => {
    expect(checkRoleInput(input({ name: 'HR', parentKey: 'super_admin' }), 'hr', others, order).ok).toBe(true)
  })

  it('refuses to put a role under itself, or under one below it', () => {
    expect(checkRoleInput(input({ name: 'HR', parentKey: 'hr' }), 'hr', others, order).ok).toBe(false)
    const r = checkRoleInput(input({ name: 'HR', parentKey: 'employee' }), 'hr', others, order)
    expect(!r.ok && r.message).toMatch(/cannot come under itself/)
  })

  it('warns, without refusing, when one role could prepare and approve the payroll', () => {
    expect(warningsFor(['payroll:run:create', 'payroll:run:approve'])).toHaveLength(1)
    expect(warningsFor(['payroll:run:create'])).toEqual([])
    expect(warningsFor(['audit:read'])).toHaveLength(1)
    expect(warningsFor(['audit:read'])[0]).toMatch(/whole company/)
    expect(warningsFor(['payroll:run:create', 'payroll:run:approve', 'audit:read'])).toHaveLength(2)
  })
})

describe('the locks', () => {
  it('refuses any change to the Super Admin role, and to a role you hold', () => {
    expect(refuseEdit({ key: 'super_admin', locked: true }, 'hr')).toBe('locked')
    expect(refuseEdit({ key: 'hr', locked: false }, 'hr')).toBe('own_role')
    expect(refuseEdit({ key: 'hr', locked: false }, 'super_admin')).toBeNull()
  })

  it('refuses to delete a built-in role, one held, or one others come under — in that order of telling', () => {
    const custom = { key: 'lead', locked: false, builtIn: false }
    expect(refuseDelete({ key: 'rm', locked: false, builtIn: true }, 'super_admin', 0, 0)).toBe('built_in')
    expect(refuseDelete(custom, 'super_admin', 2, 0)).toBe('in_use')
    expect(refuseDelete(custom, 'super_admin', 0, 1)).toBe('has_children')
    expect(refuseDelete(custom, 'super_admin', 0, 0)).toBeNull()
  })
})

describe('keys and words', () => {
  it('makes a key from the name that never clashes', () => {
    expect(keyFor('Team Lead', new Set())).toBe('team_lead')
    expect(keyFor('Team Lead', new Set(['team_lead']))).toBe('team_lead_2')
    expect(keyFor('Team Lead', new Set(['team_lead', 'team_lead_2']))).toBe('team_lead_3')
    expect(keyFor('HR', new Set(['hr']))).toBe('hr_2')
    expect(keyFor('2nd Shift', new Set())).toBe('role_2nd_shift')
    expect(keyFor('Café Lead', new Set())).toBe('cafe_lead')
  })

  it('describes a change in the screen’s own words', () => {
    const before = { permissions: ['leave:read'], scopes: { employee: 'SELF', compensation: 'SELF', attendance: 'SELF', leave: 'DIRECT_REPORTS', payslip: 'SELF', document: 'SELF' } as const }
    const after = { permissions: ['leave:read', 'leave:balance:manage'], scopes: { ...before.scopes, leave: 'ORGANIZATION' } as const }
    expect(describeChange(before, after)).toEqual({
      added: ['Give the yearly leave and correct balances'],
      removed: [],
      scopeChanges: ['Leave: Their team → Whole company'],
    })
  })
})
