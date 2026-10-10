import { describe, it, expect } from 'vitest'
import { accruedBy, planGrant, proRatedQuota } from './grant'
import { isUnlimited, splitAtBalance, workingDays } from './leaveDays'
import { ruleProblem, type LeaveTypeRules } from './rules'
import { applicationCount, asApplications, awayDuring } from './applications'

/**
 * Who gets how much leave and from when, Loss of Pay, and "the rest as Loss of
 * Pay" (client, 9 Oct 2026): every rule a setting, nothing hardcoded.
 */

const nobodyLeft = () => 0
const TODAY = '2026-05-15'
const person = (id: string, joined: string | null = '2020-01-01') => ({ id, dateOfJoining: joined, lastWorkingDate: null, active: true })

describe('what a joiner partway through the year gets', () => {
  // Leave year 2026 starts 1 Apr 2026; somebody joins on 14 Oct — six months
  // are left counting October, five after it.
  it('gives the months left, the joining month counted, by default — as it always has', () => {
    expect(proRatedQuota(12, '2026-10-14', 2026, 4)).toBe(6)
    expect(proRatedQuota(12, '2026-10-14', 2026, 4, 'months_left')).toBe(6)
  })

  it('gives whole months only, where the type says nothing for a month joined partway', () => {
    expect(proRatedQuota(12, '2026-10-14', 2026, 4, 'months_after_joining')).toBe(5)
    // Joined on the 1st, the month is whole and counts: no jump between 31 Mar and 1 Apr.
    expect(proRatedQuota(12, '2026-11-01', 2026, 4, 'months_after_joining')).toBe(5)
    expect(proRatedQuota(12, '2026-04-01', 2026, 4, 'months_after_joining')).toBe(12)
    expect(proRatedQuota(12, '2026-04-02', 2026, 4, 'months_after_joining')).toBe(11)
    // Joining partway through the year's last month leaves nothing; on its 1st, a month.
    expect(proRatedQuota(12, '2027-03-02', 2026, 4, 'months_after_joining')).toBe(0)
    expect(proRatedQuota(12, '2027-03-01', 2026, 4, 'months_after_joining')).toBe(1)
  })

  it('gives the full year whenever they join in it, where the type says so', () => {
    expect(proRatedQuota(12, '2027-03-02', 2026, 4, 'full_year')).toBe(12)
  })

  it('gives nothing for a year they join after, and the whole year to somebody here before it, whatever the rule', () => {
    for (const rule of ['months_left', 'months_after_joining', 'full_year'] as const) {
      expect(proRatedQuota(12, '2027-04-01', 2026, 4, rule)).toBe(0)
      expect(proRatedQuota(12, '2025-06-01', 2026, 4, rule)).toBe(12)
      expect(proRatedQuota(12, null, 2026, 4, rule)).toBe(12)
    }
  })

  it('keeps an odd quota exact for somebody joining on the first day, the joining month counted', () => {
    expect(proRatedQuota(7.5, '2026-04-01', 2026, 4)).toBe(7.5)
  })

  it('earns a monthly type from the month after joining, under that rule', () => {
    // 10 days over Nov–Mar (5 months): two a month. By December, two months reached.
    expect(accruedBy({ grant: 10, leaveYear: 2026, startMonth: 4, joined: '2026-10-14', asOf: '2026-12-10', joinerGrant: 'months_after_joining' })).toBe(4)
    // In the joining month itself, nothing yet.
    expect(accruedBy({ grant: 10, leaveYear: 2026, startMonth: 4, joined: '2026-10-14', asOf: '2026-10-20', joinerGrant: 'months_after_joining' })).toBe(0)
    // Joined on the 1st, that month is earned in: 6 days over Oct–Mar, one a month.
    expect(accruedBy({ grant: 6, leaveYear: 2026, startMonth: 4, joined: '2026-10-01', asOf: '2026-10-20', joinerGrant: 'months_after_joining' })).toBe(1)
    // The months-left rule earns from the joining month, as before.
    expect(accruedBy({ grant: 6, leaveYear: 2026, startMonth: 4, joined: '2026-10-14', asOf: '2026-10-20' })).toBe(1)
  })
})

describe('a person’s own days a year', () => {
  const CL = { id: 'cl', annualQuota: 12, carryForward: false, carryForwardCap: 0 }
  const CO = { id: 'co', annualQuota: 0, carryForward: false, carryForwardCap: 0 }

  it('grants their own days in place of the type’s, by the type’s joiner rule', () => {
    const plan = planGrant({
      leaveYear: 2026, startMonth: 4, today: TODAY,
      employees: [person('priya'), person('neha', '2026-10-14'), person('ravi')],
      leaveTypes: [{ ...CL, joinerGrant: 'months_after_joining' }],
      already: [], lastYearLeft: nobodyLeft,
      ownQuota: (e) => (e === 'priya' ? 15 : e === 'neha' ? 24 : null),
    })
    const days = Object.fromEntries(plan.map((e) => [e.employeeId, e.days]))
    expect(days).toEqual({ priya: 15, neha: 10, ravi: 12 })
    expect(plan.find((e) => e.employeeId === 'neha')!.note).toBe('Pro-rated from the month after joining on 14 Oct 2026')
    expect(plan.find((e) => e.employeeId === 'priya')!.note).toBeNull()
  })

  it('grants a type the company gives nobody to the one person given days of it — and nothing to one given none', () => {
    const plan = planGrant({
      leaveYear: 2026, startMonth: 4, today: TODAY,
      employees: [person('priya'), person('ravi')],
      leaveTypes: [CL, CO],
      already: [], lastYearLeft: nobodyLeft,
      ownQuota: (e, t) => (e === 'priya' && t === 'co' ? 3 : e === 'ravi' && t === 'cl' ? 0 : null),
    })
    expect(plan.map((e) => `${e.employeeId}:${e.leaveTypeId}:${e.days}`).sort()).toEqual(['priya:cl:12', 'priya:co:3'])
  })
})

describe('carrying last year’s days in', () => {
  const EL = { id: 'el', annualQuota: 15, carryForward: true, carryForwardCap: 10 }
  const CO = { id: 'co', annualQuota: 0, carryForward: true, carryForwardCap: 5 }
  const plan = (extra: Partial<Parameters<typeof planGrant>[0]>) => planGrant({
    leaveYear: 2026, startMonth: 4, today: TODAY, employees: [person('priya')], leaveTypes: [EL, CO],
    already: [], lastYearLeft: () => 4, ...extra,
  })

  it('waits while last year still has something of the type waiting — carried once, a carry is never topped up', () => {
    const waiting = plan({ lastYearSettled: (_e, t) => t !== 'el' })
    expect(waiting.filter((e) => e.leaveTypeId === 'el').map((e) => e.reason)).toEqual(['opening_grant'])
    const settled = plan({})
    expect(settled.filter((e) => e.leaveTypeId === 'el' && e.reason === 'carry_forward').map((e) => e.days)).toEqual([4, -4])
  })

  it('carries a type given case by case, and the leftover of somebody given none this year', () => {
    const entries = plan({ ownQuota: (_e, t) => (t === 'el' ? 0 : null) })
    // Comp off has no yearly days but carries what is left of it.
    expect(entries.filter((e) => e.leaveTypeId === 'co').map((e) => `${e.reason}:${e.days}`)).toEqual(['carry_forward:4', 'carry_forward:-4'])
    // Nothing of Earned Leave a year for her now, and last year's still comes in.
    expect(entries.filter((e) => e.leaveTypeId === 'el').map((e) => `${e.reason}:${e.days}`)).toEqual(['carry_forward:4', 'carry_forward:-4'])
  })
})

describe('Loss of Pay: unpaid with no days a year has no limit', () => {
  it('is no limit only when unpaid and given no days', () => {
    expect(isUnlimited(false, 0)).toBe(true)
    expect(isUnlimited(false, 5)).toBe(false)
    expect(isUnlimited(true, 0)).toBe(false)
    expect(isUnlimited(true, 12)).toBe(false)
  })
})

describe('the rest as Loss of Pay: splitting where the balance runs out', () => {
  // Mon 12 Oct – Fri 16 Oct 2026, Sunday off.
  const week = (halfDays: string[] = []) => workingDays({ from: '2026-10-12', to: '2026-10-16', weeklyOffDays: [0], holidays: [], halfDays }).breakdown

  it('covers the earliest whole days and leaves the rest', () => {
    expect(splitAtBalance(week(), 2)).toEqual({
      covered: { from: '2026-10-12', to: '2026-10-13', days: 2, halfDays: [] },
      rest: { from: '2026-10-14', to: '2026-10-16', days: 3, halfDays: [] },
    })
  })

  it('never splits a day: a day and a half left covers one, and keeps the half', () => {
    expect(splitAtBalance(week(), 1.5)!.covered).toEqual({ from: '2026-10-12', to: '2026-10-12', days: 1, halfDays: [] })
  })

  it('takes a half day as half, wherever it falls', () => {
    const split = splitAtBalance(week(['2026-10-12']), 1.5)!
    expect(split.covered).toEqual({ from: '2026-10-12', to: '2026-10-13', days: 1.5, halfDays: ['2026-10-12'] })
    expect(split.rest.days).toBe(3)
  })

  it('covers nothing when the balance does not reach the first day, and everything goes to the rest', () => {
    expect(splitAtBalance(week(), 0)).toEqual({ covered: null, rest: { from: '2026-10-12', to: '2026-10-16', days: 5, halfDays: [] } })
    expect(splitAtBalance(week(), 0.5)!.covered).toBeNull()
  })

  it('has nothing to split when the balance covers it all', () => {
    expect(splitAtBalance(week(), 5)).toBeNull()
    expect(splitAtBalance(week(), 9)).toBeNull()
  })

  it('starts and ends each part on a charged day — never on a weekly off', () => {
    // Fri 16 – Tue 20 Oct: Sunday off. One day covered: Friday; the rest from Saturday.
    const counted = workingDays({ from: '2026-10-16', to: '2026-10-20', weeklyOffDays: [0], holidays: [], halfDays: [] }).breakdown
    expect(splitAtBalance(counted, 1)).toEqual({
      covered: { from: '2026-10-16', to: '2026-10-16', days: 1, halfDays: [] },
      rest: { from: '2026-10-17', to: '2026-10-20', days: 3, halfDays: [] },
    })
    // With Saturday off too, the rest starts on Monday.
    const twoOff = workingDays({ from: '2026-10-16', to: '2026-10-20', weeklyOffDays: [0, 6], holidays: [], halfDays: [] }).breakdown
    expect(splitAtBalance(twoOff, 1)!.rest).toEqual({ from: '2026-10-19', to: '2026-10-20', days: 2, halfDays: [] })
  })
})

describe('usable only after confirmation', () => {
  const rules: LeaveTypeRules = { name: 'Earned Leave', minNoticeDays: 0, maxDaysPerRequest: null, eligibleAfterDays: 0, eligibleGender: null, halfDayAllowed: true, usableAfterConfirmation: true }
  const ask = (confirmedOn: string | null, fromDate = '2026-11-02') =>
    ruleProblem(rules, { days: 1, fromDate, today: '2026-10-20', ownApplication: true, joined: '2026-05-01', gender: null, halfDays: 0, confirmedOn })

  it('refuses somebody not confirmed yet, saying why', () => {
    expect(ask(null)).toEqual({ reason: 'not_eligible', message: 'Earned Leave can be used once confirmed, at the end of probation — and the confirmation is not recorded yet.' })
  })

  it('refuses a day before the confirmation, and takes one from it', () => {
    expect(ask('2026-11-05')).toEqual({ reason: 'not_eligible', message: 'Earned Leave can be used from the day of confirmation, 5 Nov 2026.' })
    expect(ask('2026-11-02')).toBeNull()
    expect(ask('2026-11-01')).toBeNull()
  })

  it('asks nothing of a type that does not need it', () => {
    expect(ruleProblem({ ...rules, usableAfterConfirmation: false }, { days: 1, fromDate: '2026-11-02', today: '2026-10-20', ownApplication: true, joined: '2026-05-01', gender: null, halfDays: 0, confirmedOn: null })).toBeNull()
  })
})

describe('an application in parts reads as one', () => {
  const row = (id: string, groupId: string | null, status: string, from: string) => ({ id, groupId, status, from })

  it('puts the parts of one application together, earliest first, at the first part’s place', () => {
    const rows = [row('a', null, 'pending', '2026-10-01'), row('lop', 'g', 'pending', '2026-10-13'), row('b', null, 'approved', '2026-09-01'), row('cl', 'g', 'pending', '2026-10-12')]
    const apps = asApplications(rows, (r) => r.from)
    expect(apps.map((a) => [a.lead.id, a.parts.map((p) => p.id)])).toEqual([['a', ['a']], ['cl', ['cl', 'lop']], ['b', ['b']]])
  })

  it('keeps apart parts that no longer stand alike', () => {
    const rows = [row('cl', 'g', 'approved', '2026-10-12'), row('lop', 'g', 'cancelled', '2026-10-13')]
    expect(asApplications(rows, (r) => r.from)).toHaveLength(2)
  })

  it('names who else of a team is away on any day of a range — one line an application, its types joined', () => {
    const team = new Map([['sunil', 'Sunil'], ['ravi', 'Ravi']])
    const leave = [
      { id: 'a', employeeId: 'sunil', groupId: 'g', status: 'approved' as const, from: '2026-10-12', to: '2026-10-12', typeName: 'Casual Leave' },
      { id: 'b', employeeId: 'sunil', groupId: 'g', status: 'approved' as const, from: '2026-10-13', to: '2026-10-14', typeName: 'Loss of Pay' },
      { id: 'c', employeeId: 'ravi', groupId: null, status: 'pending' as const, from: '2026-10-20', to: '2026-10-20', typeName: 'Casual Leave' },
      { id: 'd', employeeId: 'priya', groupId: null, status: 'approved' as const, from: '2026-10-13', to: '2026-10-13', typeName: 'Casual Leave' },
    ]
    expect(awayDuring({ from: '2026-10-14', to: '2026-10-15' }, team, leave)).toEqual([
      { employeeId: 'sunil', fullName: 'Sunil', typeName: 'Casual Leave + Loss of Pay', status: 'approved', from: '2026-10-12', to: '2026-10-14' },
    ])
    expect(awayDuring({ from: '2026-10-16', to: '2026-10-19' }, team, leave)).toEqual([])
    expect(awayDuring({ from: '2026-10-20', to: '2026-10-20' }, team, leave).map((a) => `${a.fullName}:${a.status}`)).toEqual(['Ravi:pending'])
  })

  it('counts an application once, whatever its parts', () => {
    expect(applicationCount([{ id: 'a', groupId: null }, { id: 'cl', groupId: 'g' }, { id: 'lop', groupId: 'g' }])).toBe(2)
  })
})
