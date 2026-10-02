import { describe, it, expect } from 'vitest'
import { canSignIn, decidingLogins, holdsSuperAdmin, isSelfServiceLogin, liveLogins, permissionsOf, type LoginFacts, type LoginKind } from './logins'

/** A person's logins taken together (Day 23). */

const login = (status: LoginFacts['status'], locked = false, permissions: string[] = []): LoginFacts => ({
  status,
  roleDef: { locked, permissions },
})

describe('a person’s logins, together', () => {
  it('can sign in when any one login can', () => {
    expect(canSignIn([login('inactive'), login('active')])).toBe(true)
    expect(canSignIn([login('invited'), login('inactive')])).toBe(false)
    expect(canSignIn([])).toBe(false)
  })

  it('holds the Super Admin panel by any live login — never by one switched off or only invited', () => {
    expect(holdsSuperAdmin([login('active'), login('active', true)])).toBe(true)
    expect(holdsSuperAdmin([login('active'), login('inactive', true)])).toBe(false)
    expect(holdsSuperAdmin([login('invited', true)])).toBe(false)
  })

  it('does what all their live logins do, and nothing a dead one did', () => {
    const all = permissionsOf([
      login('active', false, ['leave:apply']),
      login('active', false, ['employee:bank:manage', 'leave:apply']),
      login('inactive', false, ['payroll:approve']),
    ])
    expect([...all].sort()).toEqual(['employee:bank:manage', 'leave:apply'])
    expect(liveLogins([login('active'), login('invited')])).toHaveLength(1)
  })
})

describe('the employee login of somebody with a role login', () => {
  const kind = (id: string, role: string, status: LoginKind['status'] = 'active'): LoginKind => ({ id, role, status })
  const employee = kind('e', 'employee')

  it('is for their own things only while the role login can sign in', () => {
    expect(isSelfServiceLogin(employee, [employee, kind('h', 'hr')], 'employee')).toBe(true)
    // The role login itself decides.
    expect(isSelfServiceLogin(kind('h', 'hr'), [employee, kind('h', 'hr')], 'employee')).toBe(false)
  })

  it('decides again when the role login is only invited or switched off — nothing waits', () => {
    expect(isSelfServiceLogin(employee, [employee, kind('h', 'hr', 'invited')], 'employee')).toBe(false)
    expect(isSelfServiceLogin(employee, [employee, kind('h', 'hr', 'inactive')], 'employee')).toBe(false)
    expect(isSelfServiceLogin(employee, [employee], 'employee')).toBe(false)
  })

  it('leaves the employee login out of whom a waiting request is told, and switched-off logins too', () => {
    const logins = [employee, kind('h', 'hr'), kind('a', 'accounts', 'inactive')]
    expect(decidingLogins(logins, 'employee').map((l) => l.id)).toEqual(['h'])
    expect(decidingLogins([employee], 'employee').map((l) => l.id)).toEqual(['e'])
  })
})
