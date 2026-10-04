import { describe, it, expect } from 'vitest'
import { accruedBy, leaveYearBounds, leaveYearLabel, planGrant, proRatedQuota } from './grant'

/**
 * Granting a leave year. The rules a new company lives by from its first
 * week: new joiners get the months that are left, people who left get
 * nothing, last year's days carry in up to a cap, and nothing is granted twice.
 */

const CL = { id: 'cl', annualQuota: 12, carryForward: false, carryForwardCap: 0 }
const EL = { id: 'el', annualQuota: 18, carryForward: true, carryForwardCap: 10 }
const WFH = { id: 'wfh', annualQuota: 0, carryForward: false, carryForwardCap: 0 }
const nobodyLeft = () => 0
const person = (id: string, joined: string | null = '2020-01-01', left: string | null = null, active = true) => ({ id, dateOfJoining: joined, lastWorkingDate: left, active })
const TODAY = '2026-05-15'

describe('the leave year', () => {
  it('runs from its start month to the day before the next year’s', () => {
    expect(leaveYearBounds(2026, 4)).toEqual({ from: '2026-04-01', nextFrom: '2027-04-01' })
    expect(leaveYearLabel(2026, 4)).toBe('2026–27')
    expect(leaveYearLabel(2026, 1)).toBe('2026')
  })
})

describe('pro-rating', () => {
  it('gives a full year to somebody here from the start', () => {
    expect(proRatedQuota(12, '2025-06-01', 2026, 4)).toBe(12)
    expect(proRatedQuota(12, '2026-04-01', 2026, 4)).toBe(12)
    expect(proRatedQuota(12, null, 2026, 4)).toBe(12)
  })

  it('gives a joiner the months that are left, to the nearest half day', () => {
    // Joined in October: Oct–Mar is six months of twelve.
    expect(proRatedQuota(12, '2026-10-14', 2026, 4)).toBe(6)
    // Seven months of 18 is 10.5.
    expect(proRatedQuota(18, '2026-09-20', 2026, 4)).toBe(10.5)
    // 5 × 1/12 = 0.4167 → 0.5.
    expect(proRatedQuota(5, '2027-03-02', 2026, 4)).toBe(0.5)
  })

  it('gives nothing for a year that ended before they joined', () => {
    expect(proRatedQuota(12, '2027-04-01', 2026, 4)).toBe(0)
  })
})

describe('the plan', () => {
  it('grants each accrued type, and never a type with no quota', () => {
    const plan = planGrant({ leaveYear: 2026, startMonth: 4, today: TODAY, employees: [person('ravi')], leaveTypes: [CL, EL, WFH], already: [], lastYearLeft: nobodyLeft })
    expect(plan).toEqual([
      { employeeId: 'ravi', leaveTypeId: 'cl', leaveYear: 2026, days: 12, reason: 'opening_grant', note: null },
      { employeeId: 'ravi', leaveTypeId: 'el', leaveYear: 2026, days: 18, reason: 'opening_grant', note: null },
    ])
  })

  it('says why a joiner got less', () => {
    const [entry] = planGrant({ leaveYear: 2026, startMonth: 4, today: TODAY, employees: [person('neha', '2026-10-14')], leaveTypes: [CL], already: [], lastYearLeft: nobodyLeft })
    expect(entry).toMatchObject({ leaveYear: 2026, days: 6, note: 'Pro-rated from joining on 14 Oct 2026' })
  })

  it('leaves out anybody who has already left, and keeps somebody leaving later in the year', () => {
    const plan = planGrant({
      leaveYear: 2026, startMonth: 4, today: TODAY,
      employees: [
        person('kiran', '2020-01-01', '2026-03-31'), // left before the year began
        person('mohan', '2020-01-01', '2026-05-10'), // left this year, before today
        person('lata', '2020-01-01', null, false), // marked inactive, no last day
        person('asha', '2020-01-01', '2026-06-30'), // leaving next month: still here
      ],
      leaveTypes: [CL], already: [], lastYearLeft: nobodyLeft,
    })
    expect(plan.map((e) => e.employeeId)).toEqual(['asha'])
  })

  it('granting next year ahead of time, leaves out somebody who leaves before it starts', () => {
    const plan = planGrant({
      leaveYear: 2027, startMonth: 4, today: '2027-03-20',
      employees: [person('asha', '2020-01-01', '2027-03-31'), person('ravi')],
      leaveTypes: [CL], already: [], lastYearLeft: nobodyLeft,
    })
    expect(plan.map((e) => e.employeeId)).toEqual(['ravi'])
  })

  it('carries last year’s unused days in, up to the cap, only for types that allow it', () => {
    const left = (employeeId: string, typeId: string) => (typeId === 'el' ? (employeeId === 'ravi' ? 14 : 3.5) : 7)
    const plan = planGrant({ leaveYear: 2026, startMonth: 4, today: TODAY, employees: [person('ravi'), person('priya')], leaveTypes: [CL, EL], already: [], lastYearLeft: left })
    const carried = plan.filter((e) => e.reason === 'carry_forward')
    expect(carried).toEqual([
      { employeeId: 'ravi', leaveTypeId: 'el', leaveYear: 2026, days: 10, reason: 'carry_forward', note: 'Carried from 2025–26, up to 10 days' },
      // The same days leave last year, so a late application there cannot spend them again.
      { employeeId: 'ravi', leaveTypeId: 'el', leaveYear: 2025, days: -10, reason: 'carry_forward', note: 'Carried to 2026–27' },
      { employeeId: 'priya', leaveTypeId: 'el', leaveYear: 2026, days: 3.5, reason: 'carry_forward', note: 'Carried from 2025–26, up to 10 days' },
      { employeeId: 'priya', leaveTypeId: 'el', leaveYear: 2025, days: -3.5, reason: 'carry_forward', note: 'Carried to 2026–27' },
    ])
  })

  it('carries nothing into a year granted in advance — last year is still being spent', () => {
    const plan = planGrant({ leaveYear: 2027, startMonth: 4, today: '2026-09-30', employees: [person('priya')], leaveTypes: [EL], already: [], lastYearLeft: () => 15 })
    expect(plan).toEqual([{ employeeId: 'priya', leaveTypeId: 'el', leaveYear: 2027, days: 18, reason: 'opening_grant', note: null }])
    // Once the year has begun, pressing Grant again adds the carry.
    const later = planGrant({
      leaveYear: 2027, startMonth: 4, today: '2027-04-02', employees: [person('priya')], leaveTypes: [EL],
      already: [{ employeeId: 'priya', leaveTypeId: 'el', reason: 'opening_grant' }], lastYearLeft: () => 4,
    })
    expect(later.map((e) => [e.leaveYear, e.days])).toEqual([[2027, 4], [2026, -4]])
  })

  it('never carries a negative year in', () => {
    const plan = planGrant({ leaveYear: 2026, startMonth: 4, today: TODAY, employees: [person('ravi')], leaveTypes: [EL], already: [], lastYearLeft: () => -2 })
    expect(plan.filter((e) => e.reason === 'carry_forward')).toEqual([])
  })

  it('grants nothing twice: a second run reaches only people and types added since', () => {
    const already = [
      { employeeId: 'ravi', leaveTypeId: 'cl', reason: 'opening_grant' as const },
      { employeeId: 'ravi', leaveTypeId: 'el', reason: 'opening_grant' as const },
    ]
    const plan = planGrant({ leaveYear: 2026, startMonth: 4, today: TODAY, employees: [person('ravi'), person('neha', '2026-10-14')], leaveTypes: [CL, EL], already, lastYearLeft: nobodyLeft })
    expect(plan.map((e) => `${e.employeeId}:${e.leaveTypeId}`)).toEqual(['neha:cl', 'neha:el'])
  })
})

describe('monthly accrual', () => {
  it('earns a twelfth a month, the month reached counting, to the half day', () => {
    expect(accruedBy({ grant: 12, leaveYear: 2026, startMonth: 4, joined: null, asOf: '2026-04-01' })).toBe(1)
    expect(accruedBy({ grant: 12, leaveYear: 2026, startMonth: 4, joined: null, asOf: '2026-09-30' })).toBe(6)
    expect(accruedBy({ grant: 18, leaveYear: 2026, startMonth: 4, joined: null, asOf: '2026-05-15' })).toBe(3)
    expect(accruedBy({ grant: 12, leaveYear: 2026, startMonth: 4, joined: null, asOf: '2027-03-31' })).toBe(12)
    // Before the year, nothing; after it, all.
    expect(accruedBy({ grant: 12, leaveYear: 2026, startMonth: 4, joined: null, asOf: '2026-03-31' })).toBe(0)
    expect(accruedBy({ grant: 12, leaveYear: 2026, startMonth: 4, joined: null, asOf: '2027-06-01' })).toBe(12)
  })

  it('counts a joiner’s pro-rated grant from the month they joined', () => {
    // Joined 15 June: 10 months left, 10 days granted — one a month from June.
    expect(accruedBy({ grant: 10, leaveYear: 2026, startMonth: 4, joined: '2026-06-15', asOf: '2026-06-20' })).toBe(1)
    expect(accruedBy({ grant: 10, leaveYear: 2026, startMonth: 4, joined: '2026-06-15', asOf: '2026-12-01' })).toBe(7)
  })
})
