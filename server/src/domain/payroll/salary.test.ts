import { describe, it, expect } from 'vitest'
import { employmentDaysInMonth, daysInMonth, computeSalary, type SalaryInput } from './salary'

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
