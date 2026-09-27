import { describe, it, expect } from 'vitest'
import { transition, isClosed, reopenAllowed, type RunAction, type RunStatus } from './runStatus'

describe('the life of a payroll run', () => {
  const allowed: [RunStatus, RunAction, RunStatus | null][] = [
    ['draft', 'recalculate', 'draft'],
    ['draft', 'discard', null],
    ['draft', 'approve', 'approved'],
    ['approved', 'reopen', 'draft'],
    ['approved', 'mark_paid', 'paid'],
  ]

  for (const [from, action, to] of allowed) {
    it(`lets a ${from} run be ${action.replace('_', ' ')}`, () => {
      expect(transition(from, action)).toEqual({ ok: true, from, to })
    })
  }

  it('refuses everything else, and says why', () => {
    const refused: [RunStatus, RunAction][] = [
      ['draft', 'reopen'],
      ['draft', 'mark_paid'],
      ['approved', 'approve'],
      ['approved', 'recalculate'],
      ['approved', 'discard'],
      ['paid', 'approve'],
      ['paid', 'reopen'],
      ['paid', 'recalculate'],
      ['paid', 'discard'],
      ['paid', 'mark_paid'],
    ]
    for (const [from, action] of refused) {
      const t = transition(from, action)
      expect(t.ok, `${from} → ${action}`).toBe(false)
    }
    expect(transition('paid', 'reopen')).toEqual({
      ok: false,
      reason: 'It is paid. A paid payroll is a record and cannot be reopened.',
    })
    expect(transition('approved', 'recalculate')).toEqual({
      ok: false,
      reason: 'It is approved; only a draft can be recalculated.',
    })
  })

  it('treats approved and paid months as closed, a draft as open', () => {
    expect(isClosed('draft')).toBe(false)
    expect(isClosed('approved')).toBe(true)
    expect(isClosed('paid')).toBe(true)
  })
})

describe('reopening before the payslip lock day', () => {
  it('is always possible when the company has no lock day', () => {
    expect(reopenAllowed({ year: 2026, month: 8, payslipLockDay: null, today: '2027-01-01' })).toBe(true)
  })

  it('is possible up to and including the lock day of the following month', () => {
    const august = { year: 2026, month: 8, payslipLockDay: 5 }
    expect(reopenAllowed({ ...august, today: '2026-09-05' })).toBe(true)
    expect(reopenAllowed({ ...august, today: '2026-09-06' })).toBe(false)
  })

  it('counts December’s following month as next January', () => {
    const december = { year: 2026, month: 12, payslipLockDay: 3 }
    expect(reopenAllowed({ ...december, today: '2027-01-03' })).toBe(true)
    expect(reopenAllowed({ ...december, today: '2027-01-04' })).toBe(false)
  })
})
