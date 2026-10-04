import { describe, it, expect } from 'vitest'
import { ruleProblem, type LeaveTypeRules } from './rules'

const OPEN: LeaveTypeRules = { name: 'Casual Leave', minNoticeDays: 0, maxDaysPerRequest: null, eligibleAfterDays: 0, eligibleGender: null, halfDayAllowed: true }
const ask = { days: 2, fromDate: '2026-10-12', today: '2026-10-05', ownApplication: true, joined: '2024-01-01', gender: 'female' as const, halfDays: 0 }

describe('a leave type’s rules', () => {
  it('ask nothing of a type with none — as before they existed', () => {
    expect(ruleProblem(OPEN, ask)).toBeNull()
  })

  it('refuse half days where the type is whole days only', () => {
    expect(ruleProblem({ ...OPEN, halfDayAllowed: false }, { ...ask, halfDays: 1 })?.reason).toBe('no_half_days')
  })

  it('keep a type to the gender it is for, and say so when none is recorded', () => {
    const maternity = { ...OPEN, name: 'Maternity Leave', eligibleGender: 'female' as const }
    expect(ruleProblem(maternity, ask)).toBeNull()
    expect(ruleProblem(maternity, { ...ask, gender: 'male' })?.message).toBe('Maternity Leave is for women only.')
    expect(ruleProblem(maternity, { ...ask, gender: null })?.message).toMatch(/no gender is recorded/)
  })

  it('open a type after the days of service it asks', () => {
    const afterProbation = { ...OPEN, eligibleAfterDays: 80 }
    expect(ruleProblem(afterProbation, { ...ask, joined: '2026-09-01' })?.message).toMatch(/after 80 days of service — from 20 Nov 2026/)
    expect(ruleProblem(afterProbation, { ...ask, joined: '2026-07-01' })).toBeNull()
  })

  it('cap one application', () => {
    expect(ruleProblem({ ...OPEN, maxDaysPerRequest: 1.5 }, ask)?.message).toBe('One application for Casual Leave covers at most 1.5 days.')
  })

  it('ask for notice of leave planned, never of leave already begun or recorded for somebody', () => {
    const notice = { ...OPEN, minNoticeDays: 10 }
    expect(ruleProblem(notice, ask)?.message).toMatch(/needs 10 days’ notice\. The earliest it can start, applied for today, is 15 Oct 2026/)
    expect(ruleProblem(notice, { ...ask, fromDate: '2026-10-15' })).toBeNull()
    expect(ruleProblem(notice, { ...ask, fromDate: '2026-10-01' })).toBeNull()
    expect(ruleProblem(notice, { ...ask, ownApplication: false })).toBeNull()
  })
})
