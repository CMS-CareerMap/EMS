import { describe, it, expect } from 'vitest'
import { employmentDaysInMonth, daysInMonth, computeSalary, withWagesShare, type SalaryInput } from './salary'
import { isEpsMember } from './statutory'

/**
 * The employment window: which days of a month somebody was employed for.
 *
 * Every mistake here is paid out in cash — to a leaver for days after they left,
 * or withheld from a joiner for days they worked.
 */

const window = (dateOfJoining: string | null, lastWorkingDate: string | null, month = 9) =>
  employmentDaysInMonth({ year: 2026, month, dateOfJoining, lastWorkingDate })

describe('the employment window', () => {
  it('is the whole month for somebody who was here throughout', () => {
    expect(window('2024-01-15', null)).toBe(30)
  })

  it('is the whole month when nobody recorded a joining date', () => {
    // Missing data is not a reason to dock pay. Whoever fills it in later can
    // correct it; a silently short payslip is much harder to notice.
    expect(window(null, null)).toBe(30)
  })

  it('counts the joining day itself', () => {
    // Joined on the 16th of a 30-day month: 16th to 30th inclusive is 15 days.
    expect(window('2026-09-16', null)).toBe(15)
  })

  it('counts the last working day itself', () => {
    // Left on the 10th: 1st to 10th inclusive.
    expect(window('2024-01-01', '2026-09-10')).toBe(10)
  })

  it('handles somebody who joined and left in the same month', () => {
    expect(window('2026-09-05', '2026-09-20')).toBe(16)
  })

  it('is one day for somebody who joined on the last day', () => {
    expect(window('2026-09-30', null)).toBe(1)
  })

  it('is zero for somebody who joins next month', () => {
    // An offer accepted in September for an October start is not a September
    // salary. Paying it would be a whole month's overpayment.
    expect(window('2026-10-01', null)).toBe(0)
  })

  it('is zero for somebody who left last month', () => {
    expect(window('2024-01-01', '2026-08-31')).toBe(0)
  })

  it('knows February', () => {
    expect(window('2020-01-01', null, 2)).toBe(daysInMonth(2026, 2))
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2028, 2)).toBe(29)
  })

  it('counts weekends inside the window', () => {
    // 26 Sep 2026 is a Saturday. Joining then and being paid only from Monday
    // would make a joiner's pay depend on which weekday they started.
    expect(window('2026-09-26', null)).toBe(5)
  })
})

describe('monthly entries', () => {
  /** A half month, so anything prorated visibly halves. */
  const halfMonth = (incentive: number): SalaryInput => ({
    components: [
      { code: 'BASIC', label: 'Basic', amount: 20_000, type: 'earning', countsForPf: true },
      { code: 'INCENTIVE', label: 'Incentive', amount: incentive, type: 'earning', countsForPf: false, entry: 'monthly' },
    ],
    paidDays: 15,
    daysInMonth: 30,
    month: 9,
    year: 2026,
    pf: {
      applicable: true,
      employeeRate: 12,
      employerRate: 12,
      restrictToCeiling: true,
      wageCeiling: 15_000,
      epsWageCeiling: 15_000,
      epsMember: true,
    },
    esi: { covered: true, employeeRate: 0.75, employerRate: 3.25 },
    pt: { state: null, gender: 'any', slabs: [] },
    tds: 0,
  })

  it('pays an incentive as entered, not prorated by the days worked', () => {
    const result = computeSalary(halfMonth(5_000))

    // Basic is a rate, so half a month pays half of it. The incentive is a sum
    // somebody decided on; halving it would pay the joiner ₹2,500 they were
    // never offered.
    expect(result.earnings.find((e) => e.code === 'BASIC')?.amount).toBe(10_000)
    expect(result.earnings.find((e) => e.code === 'INCENTIVE')?.amount).toBe(5_000)
    expect(result.grossEarnings).toBe(15_000)
  })

  it('counts an incentive in gross for ESI, but not in PF wages', () => {
    const result = computeSalary(halfMonth(5_000))

    // PF on basic alone: 12% of the prorated 10,000.
    expect(result.pfWages).toBe(10_000)
    expect(result.employeePf).toBe(1_200)
    // ESI on everything paid: 0.75% of 15,000.
    expect(result.employeeEsi).toBe(113)
  })

  it('leaves no line at all when nothing was entered', () => {
    const result = computeSalary({
      ...halfMonth(0),
      components: halfMonth(0).components.filter((c) => c.code !== 'INCENTIVE'),
    })
    expect(result.earnings.map((e) => e.code)).toEqual(['BASIC'])
  })
})

describe('the Labour Codes wages rule', () => {
  /** ₹30,000 a month, of which Basic is ₹10,000 — a third, under the half the Codes ask for. */
  const month = (over: Partial<SalaryInput['pf']> = {}, paidDays = 30, basic = 10_000): SalaryInput => ({
    components: [
      { code: 'BASIC', label: 'Basic', amount: basic, type: 'earning', countsForPf: true },
      { code: 'HRA', label: 'House Rent Allowance', amount: 12_000, type: 'earning', countsForPf: false },
      { code: 'SPECIAL', label: 'Special Allowance', amount: 30_000 - 12_000 - basic, type: 'earning', countsForPf: false },
    ],
    paidDays,
    daysInMonth: 30,
    month: 9,
    year: 2026,
    pf: {
      applicable: true,
      employeeRate: 12,
      employerRate: 12,
      restrictToCeiling: true,
      wageCeiling: 25_000,
      epsWageCeiling: 15_000,
      epsMember: true,
      ...over,
    },
    esi: { covered: false, employeeRate: 0.75, employerRate: 3.25 },
    pt: { state: null, gender: 'any', slabs: [] },
    tds: 0,
  })

  it('changes nothing while the company has it off', () => {
    const result = computeSalary(month())
    expect(result.pfWages).toBe(10_000)
    expect(result.employeePf).toBe(1_200)
    expect(result.wagesShare).toBeNull()
  })

  it('raises PF wages to half of what was earned, and says so', () => {
    const result = computeSalary(month({ wagesShare: 50 }))
    expect(result.pfWages).toBe(15_000)
    expect(result.employeePf).toBe(1_800)
    expect(result.wagesShare).toEqual({ percent: 50, wages: 10_000, raisedTo: 15_000 })
    // Only PF moves: gross, and so ESI and PT, are what they were.
    expect(result.grossEarnings).toBe(30_000)
  })

  it('takes another share when one is notified', () => {
    const result = computeSalary(month({ wagesShare: 40 }))
    expect(result.pfWages).toBe(12_000)
    expect(result.wagesShare).toEqual({ percent: 40, wages: 10_000, raisedTo: 12_000 })
  })

  it('leaves wages that are already enough as they are', () => {
    const result = computeSalary(month({ wagesShare: 50 }, 30, 16_000))
    expect(result.pfWages).toBe(16_000)
    expect(result.wagesShare).toBeNull()
  })

  it('works on what was earned in a part month', () => {
    const result = computeSalary(month({ wagesShare: 50 }, 15))
    // Gross ₹15,000 for half a month; Basic ₹5,000; half of the gross is ₹7,500.
    expect(result.grossEarnings).toBe(15_000)
    expect(result.pfWages).toBe(7_500)
    expect(result.wagesShare).toEqual({ percent: 50, wages: 5_000, raisedTo: 7_500 })
  })

  it('still stops at the wage ceiling when contributions are restricted to it', () => {
    const big = month({ wagesShare: 50, wageCeiling: 12_000 })
    const result = computeSalary(big)
    expect(result.wagesShare?.raisedTo).toBe(15_000)
    expect(result.pfWages).toBe(12_000)
    expect(result.employeePf).toBe(1_440)
  })

  it('does nothing for somebody PF does not apply to', () => {
    const result = computeSalary(month({ wagesShare: 50, applicable: false }))
    expect(result.pfWages).toBe(0)
    expect(result.wagesShare).toBeNull()
  })
})

describe('the wages rule against the ceiling, rounding and EPS', () => {
  const pf = (over: Partial<SalaryInput['pf']> = {}): SalaryInput['pf'] => ({
    applicable: true, employeeRate: 12, employerRate: 12, restrictToCeiling: true,
    wageCeiling: 25_000, epsWageCeiling: 15_000, epsMember: true, wagesShare: 50, ...over,
  })
  const pay = (components: SalaryInput['components'], over: Partial<SalaryInput['pf']> = {}, paidDays = 30, days = 30): SalaryInput => ({
    components, paidDays, daysInMonth: days, month: 9, year: 2026, pf: pf(over),
    esi: { covered: false, employeeRate: 0.75, employerRate: 3.25 }, pt: { state: null, gender: 'any', slabs: [] }, tds: 0,
  })
  const earning = (code: string, amount: number, countsForPf = false) => ({ code, label: code, amount, type: 'earning' as const, countsForPf })

  it('records nothing when the ceiling already takes all the raise would add', () => {
    // Basic ₹30,000 of ₹1,00,000: half is ₹50,000, but PF stops at ₹25,000 either way.
    const result = computeSalary(pay([earning('BASIC', 30_000, true), earning('HRA', 70_000)]))
    expect(result.pfWages).toBe(25_000)
    expect(result.wagesShare).toBeNull()
  })

  it('records the raise the ceiling cut short, with what it would have been', () => {
    // Basic ₹20,000 of ₹60,000: half is ₹30,000; PF on ₹25,000.
    const result = computeSalary(pay([earning('BASIC', 20_000, true), earning('HRA', 40_000)]))
    expect(result.pfWages).toBe(25_000)
    expect(result.wagesShare).toEqual({ percent: 50, wages: 20_000, raisedTo: 30_000 })
  })

  it('is not triggered by a paisa of proration', () => {
    // 17 of 31 days: Basic 5,483.87, gross 10,967.75 — half is 5,483.88.
    const result = computeSalary(pay([earning('BASIC', 10_000, true), earning('HRA', 5_000), earning('SPECIAL', 5_000)], {}, 17, 31))
    expect(result.pfWages).toBe(5_483.87)
    expect(result.wagesShare).toBeNull()
  })

  it('splits the employer share into EPS and EPF on the raised wages', () => {
    // Basic ₹10,000 of ₹30,000: PF wages ₹15,000; EPS 8.33% of ₹15,000 = ₹1,250, the rest to EPF.
    const result = computeSalary(pay([earning('BASIC', 10_000, true), earning('HRA', 20_000)]))
    expect(result.employer.pfTotal).toBe(1_800)
    expect(result.employer.eps).toBe(1_250)
    expect(result.employer.epf).toBe(550)
    // And all of it to EPF for somebody outside the pension scheme.
    const outside = computeSalary(pay([earning('BASIC', 10_000, true), earning('HRA', 20_000)], { epsMember: false }))
    expect(outside.employer).toMatchObject({ pfTotal: 1_800, eps: 0, epf: 1_800 })
  })

  it('counts the share in the wages somebody joined on, when the rule was on that day', () => {
    // Basic ₹10,000 of ₹40,000: Code wages ₹20,000 — above the ₹15,000 pension ceiling.
    expect(withWagesShare(10_000, 40_000, 50)).toBe(20_000)
    expect(withWagesShare(10_000, 40_000, null)).toBe(10_000)
    const joinedAfterCutOff = { dateOfJoining: '2026-10-12', hasPriorMembership: false, epsWageCeiling: 15_000 }
    expect(isEpsMember({ ...joinedAfterCutOff, pfWagesAtJoining: withWagesShare(10_000, 40_000, 50) })).toBe(false)
    expect(isEpsMember({ ...joinedAfterCutOff, pfWagesAtJoining: withWagesShare(10_000, 40_000, null) })).toBe(true)
  })
})
