import { describe, it, expect } from 'vitest'
import { loginKind, mayChangeOwnPassword, maySetPasswordFor, passwordSetBy, passwordSetterName } from './passwords'

const COMPANY = { employeePasswords: 'company', rolePasswords: 'company' } as const
const SELF = { employeePasswords: 'self', rolePasswords: 'self' } as const

describe('which kind a login is', () => {
  it('an employee login holds the Employee role; a Super Admin’s is the locked role; every other is a role login', () => {
    expect(loginKind('employee', 'employee', false)).toBe('employee')
    expect(loginKind('hr', 'employee', false)).toBe('role')
    expect(loginKind('ops_lead', 'employee', false)).toBe('role')
    expect(loginKind('super_admin', 'employee', true)).toBe('super_admin')
  })
})

describe('whose password it is', () => {
  it('follows the company’s choice for employee and role logins', () => {
    expect(passwordSetBy('employee', COMPANY)).toBe('company')
    expect(passwordSetBy('role', COMPANY)).toBe('company')
    expect(passwordSetBy('employee', SELF)).toBe('self')
    expect(passwordSetBy('role', { employeePasswords: 'company', rolePasswords: 'self' })).toBe('self')
  })

  it('is always the Super Admin’s own, whatever the company chose', () => {
    expect(passwordSetBy('super_admin', COMPANY)).toBe('self')
    expect(mayChangeOwnPassword('super_admin', COMPANY)).toBe(true)
  })

  it('is changed by its owner only when it is theirs', () => {
    expect(mayChangeOwnPassword('employee', COMPANY)).toBe(false)
    expect(mayChangeOwnPassword('employee', SELF)).toBe(true)
    expect(mayChangeOwnPassword('role', COMPANY)).toBe(false)
  })
})

describe('who may set it for them', () => {
  it('the Super Admin anybody’s', () => {
    for (const kind of ['employee', 'role', 'super_admin'] as const) expect(maySetPasswordFor(kind, { locked: true, holds: false })).toBe(true)
  })

  it('a holder of the permission an employee login’s only', () => {
    expect(maySetPasswordFor('employee', { locked: false, holds: true })).toBe(true)
    expect(maySetPasswordFor('role', { locked: false, holds: true })).toBe(false)
    expect(maySetPasswordFor('super_admin', { locked: false, holds: true })).toBe(false)
  })

  it('nobody without it', () => {
    expect(maySetPasswordFor('employee', { locked: false, holds: false })).toBe(false)
  })

  it('names who sets it, for a message', () => {
    expect(passwordSetterName('employee')).toBe('HR')
    expect(passwordSetterName('role')).toBe('the Super Admin')
  })
})
