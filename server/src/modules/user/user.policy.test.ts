import { describe, it, expect } from 'vitest'
import { refuseRoleChange, refuseAccountChange, mayGive, type PolicyRole } from './user.policy'
import { DEFAULT_ROLES, type RoleDefinition } from '../../platform/authz/defaultRoles'
import { toGrant } from '../../platform/authz/grant'
import type { RoleNode } from '../../platform/authz/roleOrder'
import type { Permission } from '../../platform/authz/permissions'
import type { DataScope, ScopedResource } from '../../platform/authz/scope'

/**
 * The invariants, checked across every pair of roles.
 *
 * Pure functions with no database, so exhaustive is cheap. The alternative —
 * testing the two or three cases somebody thought of — is how "accounts cannot
 * promote to hr, but can promote to super_admin" survives review.
 *
 * Since Day 21 the roles are the company's own: what each may do, and the
 * order they come in. These tests build them from the seven defaults, and add
 * custom ones where the order and the powers disagree.
 */

function policyRole(def: Pick<RoleDefinition, 'key' | 'name' | 'parentKey' | 'locked' | 'permissions' | 'scopes'>): PolicyRole {
  return {
    key: def.key,
    parentKey: def.parentKey,
    locked: def.locked,
    grant: toGrant({ key: def.key, name: def.name, permissions: def.permissions, scopes: def.scopes }),
  }
}

function companyOf(extra: Parameters<typeof policyRole>[0][] = []) {
  const roles = new Map<string, PolicyRole>()
  for (const def of [...DEFAULT_ROLES, ...extra]) roles.set(def.key, policyRole(def))
  const order = new Map<string, RoleNode>([...roles.values()].map((r) => [r.key, { key: r.key, parentKey: r.parentKey }]))
  return { roles, order }
}

const SELF_EVERYWHERE: Record<ScopedResource, DataScope> = {
  employee: 'SELF', compensation: 'SELF', attendance: 'SELF', leave: 'SELF', payslip: 'SELF', document: 'SELF',
}

const custom = (key: string, parentKey: string, permissions: Permission[], scopes: Partial<Record<ScopedResource, DataScope>> = {}) => ({
  key,
  name: key,
  parentKey,
  locked: false,
  permissions,
  scopes: { ...SELF_EVERYWHERE, ...scopes },
})

const { roles, order } = companyOf()
const R = (key: string) => {
  const role = roles.get(key)
  if (!role) throw new Error(key)
  return role
}
const KEYS = [...roles.keys()]

const ACTOR = 'membership-actor'
const TARGET = 'membership-target'

function change(overrides: { actor?: string; current?: string; next?: string; target?: string; superAdmins?: number } = {}) {
  return refuseRoleChange({
    actorMembershipId: ACTOR,
    actor: R(overrides.actor ?? 'super_admin'),
    targetMembershipId: overrides.target ?? TARGET,
    targetCurrent: R(overrides.current ?? 'employee'),
    next: R(overrides.next ?? 'hr'),
    order,
    activeSuperAdminCount: overrides.superAdmins ?? 2,
  })
}

describe('invariant 1 — you cannot change your own role', () => {
  it('refuses when actor and target are the same membership', () => {
    expect(change({ target: ACTOR })).toBe('own_role')
  })

  it('refuses even a super_admin demoting themselves', () => {
    // Allowing this means the only administrator can lock the company out of
    // its own settings, and bootstrap refuses to run a second time.
    expect(change({ target: ACTOR, current: 'super_admin', next: 'employee', superAdmins: 5 })).toBe('own_role')
  })

  it('refuses a no-op self change too', () => {
    expect(change({ target: ACTOR, actor: 'hr', current: 'hr', next: 'hr' })).toBe('own_role')
  })
})

describe('invariant 2 — you manage only people whose role is below yours', () => {
  it('stops anybody but the Super Admin changing a Super Admin', () => {
    for (const actor of KEYS.filter((k) => k !== 'super_admin')) {
      expect(change({ actor, current: 'super_admin', next: 'employee' }), actor).toBe('target_not_below')
    }
  })

  it('stops HR changing the role of somebody in Accounts, who is beside HR rather than below', () => {
    expect(change({ actor: 'hr', current: 'accounts', next: 'employee' })).toBe('target_not_below')
  })
})

describe('invariant 3 — you give only a role below your own, with nothing you cannot do', () => {
  // Who can hand out which of the seven, by the order the Super Admin starts
  // with (Super Admin → HR → Manager → RM → Employee; Admin and Accounts beside
  // HR) AND by what the roles really do.
  const MAY_GIVE: Record<string, string[]> = {
    super_admin: KEYS,
    hr: ['manager', 'rm', 'employee'],
    // Below the manager, but the Employee role uploads documents, which a
    // manager cannot: so not the Employee role.
    manager: ['rm'],
    rm: [],
    admin: [],
    accounts: [],
    employee: [],
  }

  it('matches the table for every pair of the seven roles', () => {
    for (const actor of KEYS) {
      for (const next of KEYS) {
        expect(mayGive(R(actor), R(next), order), `${actor} giving ${next}`).toBe(MAY_GIVE[actor]!.includes(next))
      }
    }
  })

  it('lets nobody but super_admin grant super_admin — and lets super_admin appoint a successor', () => {
    for (const actor of KEYS) {
      const refusal = change({ actor, current: 'employee', next: 'super_admin' })
      if (actor === 'super_admin') expect(refusal).toBeNull()
      else expect(refusal, actor).not.toBeNull()
    }
  })

  it('refuses a role placed below yours that holds a power you lack', () => {
    // The order is what somebody chose; the powers are what the role does. A
    // role put under Manager by mistake, but able to prepare the payroll,
    // must not be handed out by a manager.
    const company = companyOf([custom('payroll_helper', 'manager', ['dashboard:read', 'payroll:structure:read', 'payroll:run:create'])])
    const manager = company.roles.get('manager')!
    const helper = company.roles.get('payroll_helper')!
    expect(mayGive(manager, helper, company.order)).toBe(false)
  })

  it('refuses a role below yours that reaches more people than you do', () => {
    // A manager sees their team's leave; a role under them that sees the whole
    // company's would be a promotion through the back door.
    const company = companyOf([
      custom('wide_lead', 'manager', ['leave:read'], { leave: 'ORGANIZATION' }),
      custom('team_lead', 'manager', ['leave:read'], { leave: 'DIRECT_REPORTS' }),
    ])
    const manager = company.roles.get('manager')!
    expect(mayGive(manager, company.roles.get('wide_lead')!, company.order)).toBe(false)
    expect(mayGive(manager, company.roles.get('team_lead')!, company.order)).toBe(true)
  })

  it('refuses a role beside yours even when it does less', () => {
    // Accounts does less than the Super Admin but is not below HR, so HR may
    // not give it — the order is the Super Admin's decision, not a formality.
    const company = companyOf([custom('viewer', 'super_admin', ['dashboard:read'])])
    expect(mayGive(company.roles.get('hr')!, company.roles.get('viewer')!, company.order)).toBe(false)
  })
})

describe('invariant 4 — the last super_admin cannot be demoted', () => {
  it('refuses when they are the only active one', () => {
    expect(change({ current: 'super_admin', next: 'hr', superAdmins: 1 })).toBe('last_super_admin')
  })

  it('allows it once a second exists', () => {
    expect(change({ current: 'super_admin', next: 'hr', superAdmins: 2 })).toBeNull()
  })

  it('does not block a super_admin being re-set to super_admin', () => {
    expect(change({ current: 'super_admin', next: 'super_admin', superAdmins: 1 })).toBeNull()
  })
})

describe('deactivation and termination', () => {
  const account = (actor: string, target: string, targetMembershipId = TARGET, superAdmins = 3) =>
    refuseAccountChange({
      actorMembershipId: ACTOR,
      actor: R(actor),
      targetMembershipId,
      target: R(target),
      order,
      activeSuperAdminCount: superAdmins,
    })

  it('refuses to act on your own account', () => {
    expect(account('hr', 'hr', ACTOR)).toBe('own_account')
  })

  it('refuses to remove the last super_admin', () => {
    expect(account('super_admin', 'super_admin', TARGET, 1)).toBe('last_super_admin')
  })

  it('refuses to switch off somebody whose role is not below yours', () => {
    expect(account('hr', 'super_admin')).toBe('target_not_below')
    expect(account('hr', 'accounts')).toBe('target_not_below')
  })

  it('allows removing an ordinary user', () => {
    expect(account('super_admin', 'employee', TARGET, 1)).toBeNull()
    expect(account('hr', 'employee')).toBeNull()
  })
})
