import { describe, it, expect } from 'vitest'
import { buildTree } from '../org/companyTree'
import { mayDecide, mayReverse, routeOf, type ApprovalRules } from './approval'

// owner ─ head ─ lead ─ agent ;  owner ─ accounts head ─ accountant ;
// gone (left) ─ orphan ;  loose (nobody above, not the owner)
const tree = buildTree([
  { id: 'owner', managerId: null, left: false },
  { id: 'head', managerId: 'owner', left: false },
  { id: 'lead', managerId: 'head', left: false },
  { id: 'agent', managerId: 'lead', left: false },
  { id: 'achead', managerId: 'owner', left: false },
  { id: 'accountant', managerId: 'achead', left: false },
  { id: 'gone', managerId: 'head', left: true },
  { id: 'orphan', managerId: 'gone', left: false },
  { id: 'loose', managerId: null, left: false },
  { id: 'sa2', managerId: 'owner', left: false },
])

const RULES: ApprovalRules = { ownerEmployeeId: 'owner', noManagerApproverId: null, backup: 'super_admin', reversal: 'manager_or_super_admin' }
const person = (id: string) => ({ employeeId: id, isSuperAdmin: false })
const superAdmin = (id: string) => ({ employeeId: id, isSuperAdmin: true })

describe('who decides somebody’s leave', () => {
  it('is their reporting manager, whatever that person’s role', () => {
    expect(routeOf(tree, RULES, 'agent')).toEqual({ kind: 'manager', managerId: 'lead' })
    expect(mayDecide(tree, RULES, 'agent', person('lead'))).toEqual({ allowed: true, asBackup: false })
    // The Accounts head approves the accountant's leave without any leave right.
    expect(mayDecide(tree, RULES, 'accountant', person('achead')).allowed).toBe(true)
    // Not the manager's manager, not a peer, not HR.
    expect(mayDecide(tree, RULES, 'agent', person('head')).allowed).toBe(false)
    expect(mayDecide(tree, RULES, 'agent', person('accountant')).allowed).toBe(false)
  })

  it('never the requester, even a Super Admin', () => {
    expect(mayDecide(tree, RULES, 'lead', person('lead')).allowed).toBe(false)
    expect(mayDecide(tree, RULES, 'sa2', superAdmin('sa2')).allowed).toBe(false)
    expect(mayReverse(tree, RULES, 'sa2', superAdmin('sa2')).allowed).toBe(false)
  })

  it('is nobody for the owner — and the owner may settle their own', () => {
    expect(routeOf(tree, RULES, 'owner')).toEqual({ kind: 'owner' })
    expect(mayDecide(tree, RULES, 'owner', superAdmin('owner')).allowed).toBe(true)
  })

  it('is the Super Admin for somebody with nobody above, or whose manager has left', () => {
    expect(routeOf(tree, RULES, 'loose')).toEqual({ kind: 'nobody_above', approverId: null })
    expect(routeOf(tree, RULES, 'orphan')).toEqual({ kind: 'nobody_above', approverId: null })
    expect(mayDecide(tree, RULES, 'orphan', superAdmin('sa2'))).toEqual({ allowed: true, asBackup: false })
    expect(mayDecide(tree, RULES, 'orphan', person('head')).allowed).toBe(false)
  })

  it('is the person the settings name for nobody above — never for their own, never once they have left', () => {
    const named = { ...RULES, noManagerApproverId: 'head' }
    expect(mayDecide(tree, named, 'loose', person('head'))).toEqual({ allowed: true, asBackup: false })
    expect(routeOf(tree, { ...RULES, noManagerApproverId: 'loose' }, 'loose')).toEqual({ kind: 'nobody_above', approverId: null })
    expect(routeOf(tree, { ...RULES, noManagerApproverId: 'gone' }, 'loose')).toEqual({ kind: 'nobody_above', approverId: null })
  })

  it('lets a Super Admin stand in as the backup, per the setting', () => {
    expect(mayDecide(tree, RULES, 'agent', superAdmin('sa2'))).toEqual({ allowed: true, asBackup: true })
    expect(mayDecide(tree, { ...RULES, backup: 'none' }, 'agent', superAdmin('sa2')).allowed).toBe(false)
    // "The manager's own manager" instead.
    const nextUp = { ...RULES, backup: 'next_up' as const }
    expect(mayDecide(tree, nextUp, 'agent', person('head'))).toEqual({ allowed: true, asBackup: true })
    expect(mayDecide(tree, nextUp, 'agent', superAdmin('sa2')).allowed).toBe(false)
  })

  it('cancels approved leave by the manager or a Super Admin — or only a Super Admin, per the setting', () => {
    expect(mayReverse(tree, RULES, 'agent', person('lead')).allowed).toBe(true)
    expect(mayReverse(tree, RULES, 'agent', superAdmin('sa2')).allowed).toBe(true)
    expect(mayReverse(tree, RULES, 'agent', person('head')).allowed).toBe(false)
    expect(mayReverse(tree, { ...RULES, reversal: 'super_admin_only' }, 'agent', person('lead')).allowed).toBe(false)
  })

  it('follows the tree as it is now: a moved person’s request goes to the new manager', () => {
    const moved = buildTree([
      { id: 'owner', managerId: null, left: false },
      { id: 'lead', managerId: 'owner', left: false },
      { id: 'achead', managerId: 'owner', left: false },
      { id: 'agent', managerId: 'achead', left: false },
    ])
    expect(mayDecide(moved, RULES, 'agent', person('achead')).allowed).toBe(true)
    expect(mayDecide(moved, RULES, 'agent', person('lead')).allowed).toBe(false)
  })
})
