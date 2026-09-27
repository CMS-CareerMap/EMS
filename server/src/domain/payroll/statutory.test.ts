import { describe, it, expect } from 'vitest'
import {
  computePf,
  isEpsMember,
  computeEsi,
  isEsiEligible,
  esiPeriodFor,
  computePt,
  annualPt,
  ptTableProblems,
  ptTableRows,
  PT_ANNUAL_CAP,
  EPS_MONTHLY_CAP,
  PF_WAGE_CEILING,
  epsMonthlyCap,
  type PtSlabRule,
} from './statutory'

/**
 * The statutory rules, tested without a database.
 *
 * Every case here is one where being wrong costs somebody money or puts a wrong
 * figure in a government return — and most of them are invisible on the
 * payslip's bottom line, which is why they need testing rather than eyeballing.
 */

const POLICY = {
  employeeRate: 12,
  employerRate: 12,
  restrictToCeiling: true,
  wageCeiling: 15_000,
}

describe('provident fund', () => {
  it('caps at the ceiling when the company restricts to it', () => {
    // The client's stated wish: PF kept low, so ₹1,800 a month.
    const result = computePf({ ...POLICY, pfWages: 50_000, epsMember: true })

    expect(result.pfWages).toBe(15_000)
    expect(result.employee).toBe(1_800)
    expect(result.employerTotal).toBe(1_800)
  })

  it('contributes on full wages when the company does not restrict', () => {
    const result = computePf({
      ...POLICY,
      restrictToCeiling: false,
      pfWages: 50_000,
      epsMember: true,
    })

    expect(result.pfWages).toBe(50_000)
    expect(result.employee).toBe(6_000)
  })

  it('splits the employer share into EPS and EPF', () => {
    const result = computePf({ ...POLICY, pfWages: 15_000, epsMember: true })

    // 8.33% of 15,000 is 1,249.50, which rounds to 1,250 — exactly the cap.
    expect(result.employerEps).toBe(1_250)
    expect(result.employerEpf).toBe(550)
    // The two halves must add to the total. Computing EPF independently would
    // let rounding put them a rupee apart, and the difference would appear in
    // a statutory return rather than on a screen.
    expect(result.employerEps + result.employerEpf).toBe(result.employerTotal)
  })

  it('never lets EPS exceed the monthly cap', () => {
    const result = computePf({
      ...POLICY,
      restrictToCeiling: false,
      pfWages: 80_000,
      epsMember: true,
    })

    // The employer contributes on 80,000, but the pension scheme is capped on
    // the ceiling regardless.
    expect(result.employerTotal).toBe(9_600)
    expect(result.employerEps).toBe(EPS_MONTHLY_CAP)
    expect(result.employerEpf).toBe(9_600 - EPS_MONTHLY_CAP)
  })

  it('sends the whole employer share to EPF for a non-member', () => {
    const result = computePf({ ...POLICY, pfWages: 15_000, epsMember: false })

    // Same total, different split. Getting this wrong is invisible on the
    // payslip and wrong on every return.
    expect(result.employerTotal).toBe(1_800)
    expect(result.employerEps).toBe(0)
    expect(result.employerEpf).toBe(1_800)
  })

  it('handles exactly the ceiling, which is the boundary everybody gets wrong', () => {
    const result = computePf({ ...POLICY, pfWages: 15_000, epsMember: true })

    // At exactly 15,000 the ceiling does not bite: contributions are on the
    // full amount. An off-by-one here would silently drop somebody a rupee.
    expect(result.pfWages).toBe(15_000)
    expect(result.employee).toBe(1_800)
  })

  it('honours an edited rate, because the client asked for that', () => {
    const result = computePf({ ...POLICY, employeeRate: 10, pfWages: 15_000, epsMember: true })
    expect(result.employee).toBe(1_500)
  })

  it('never puts more into the pension than the employer paid in', () => {
    // An employer rate edited below 8.33% would otherwise leave EPF negative.
    const result = computePf({ ...POLICY, employerRate: 8, pfWages: 15_000, epsMember: true })
    expect(result.employerTotal).toBe(1_200)
    expect(result.employerEps).toBe(1_200)
    expect(result.employerEpf).toBe(0)
  })
})

describe('the September 2026 ceilings', () => {
  const TODAY = { employeeRate: 12, employerRate: 12, restrictToCeiling: true, wageCeiling: 25_000 }

  it('caps PF at ₹3,000 on the ₹25,000 ceiling', () => {
    const result = computePf({ ...TODAY, epsWageCeiling: 15_000, pfWages: 50_000, epsMember: true })
    expect(result.pfWages).toBe(25_000)
    expect(result.employee).toBe(3_000)
    // The pension share still stops at 8.33% of ₹15,000; EPF takes the rest.
    expect(result.employerEps).toBe(1_250)
    expect(result.employerEpf).toBe(1_750)
  })

  it('moves the pension cap to ₹2,083 when its ceiling moves to ₹25,000', () => {
    const result = computePf({ ...TODAY, epsWageCeiling: 25_000, pfWages: 50_000, epsMember: true })
    // 25,000 × 8.33% = 2,082.50, to the nearest rupee.
    expect(result.employerEps).toBe(2_083)
    expect(result.employerEpf).toBe(917)
  })

  it('derives the monthly pension cap from the ceiling rather than remembering it', () => {
    expect(epsMonthlyCap(15_000)).toBe(1_250)
    expect(epsMonthlyCap(25_000)).toBe(2_083)
    expect(EPS_MONTHLY_CAP).toBe(1_250)
  })

  it('falls back to today’s EPF ceiling when a caller passes none', () => {
    const result = computePf({ employeeRate: 12, employerRate: 12, restrictToCeiling: true, pfWages: 50_000, epsMember: true })
    expect(result.pfWages).toBe(PF_WAGE_CEILING)
    expect(result.employee).toBe(3_000)
  })

  it('opens the pension to a new joiner within the pension ceiling in force', () => {
    const joiner = { dateOfJoining: '2026-10-01', pfWagesAtJoining: 20_000, hasPriorMembership: false }
    // At ₹15,000 they are a high earner, and excluded; at ₹25,000 they are not.
    expect(isEpsMember({ ...joiner, epsWageCeiling: 15_000 })).toBe(false)
    expect(isEpsMember({ ...joiner, epsWageCeiling: 25_000 })).toBe(true)
    expect(isEpsMember({ ...joiner, pfWagesAtJoining: 30_000, epsWageCeiling: 25_000 })).toBe(false)
  })
})

describe('who is a member of the pension scheme', () => {
  it('includes anybody who joined before September 2014', () => {
    expect(
      isEpsMember({
        dateOfJoining: '2010-06-01',
        pfWagesAtJoining: 50_000,
        hasPriorMembership: false,
      }),
    ).toBe(true)
  })

  it('excludes a high earner who first joined after the cut-off', () => {
    // The rule the 2014 amendment introduced, and the one most payroll systems
    // never implement.
    expect(
      isEpsMember({
        dateOfJoining: '2020-01-01',
        pfWagesAtJoining: 25_000,
        hasPriorMembership: false,
      }),
    ).toBe(false)
  })

  it('includes a low earner who joined after the cut-off', () => {
    expect(
      isEpsMember({
        dateOfJoining: '2020-01-01',
        pfWagesAtJoining: 14_000,
        hasPriorMembership: false,
      }),
    ).toBe(true)
  })

  it('includes a high earner who was already a member elsewhere', () => {
    // Prior membership carries over. Only a genuine new entrant is excluded.
    expect(
      isEpsMember({
        dateOfJoining: '2020-01-01',
        pfWagesAtJoining: 25_000,
        hasPriorMembership: true,
      }),
    ).toBe(true)
  })

  it('treats exactly the ceiling as still a member', () => {
    expect(
      isEpsMember({
        dateOfJoining: '2020-01-01',
        pfWagesAtJoining: 15_000,
        hasPriorMembership: false,
      }),
    ).toBe(true)
  })
})

describe('ESI contribution periods', () => {
  it('runs April to September', () => {
    expect(esiPeriodFor(2026, 4)).toEqual({ start: '2026-04-01', end: '2026-09-30', label: 'Apr–Sep' })
    expect(esiPeriodFor(2026, 9).end).toBe('2026-09-30')
  })

  it('runs October to March, across the year boundary', () => {
    expect(esiPeriodFor(2026, 10)).toEqual({
      start: '2026-10-01',
      end: '2027-03-31',
      label: 'Oct–Mar',
    })

    // January belongs to the period that began the PREVIOUS October. Reading
    // the calendar year here is how somebody's coverage silently resets on
    // 1 January.
    expect(esiPeriodFor(2027, 1)).toEqual({
      start: '2026-10-01',
      end: '2027-03-31',
      label: 'Oct–Mar',
    })
    expect(esiPeriodFor(2027, 3).start).toBe('2026-10-01')
  })
})

describe('ESI', () => {
  const RATES = { employeeRate: 0.75, employerRate: 3.25 }

  it('tests eligibility on the wage RATE, not what was paid', () => {
    // Somebody on ₹22,000 who took unpaid leave and received ₹12,000 is still
    // above the threshold. Testing the paid amount would pull people into ESI
    // in exactly the months they were ill.
    expect(isEsiEligible({ wageRate: 22_000, threshold: 21_000 })).toBe(false)
    expect(isEsiEligible({ wageRate: 20_000, threshold: 21_000 })).toBe(true)
  })

  it('treats exactly the threshold as covered', () => {
    expect(isEsiEligible({ wageRate: 21_000, threshold: 21_000 })).toBe(true)
  })

  it('rounds each contribution UP, independently', () => {
    const result = computeEsi({ ...RATES, grossPaid: 20_000, covered: true })

    // 0.75% of 20,000 is 150 exactly; 3.25% is 650 exactly.
    expect(result.employee).toBe(150)
    expect(result.employer).toBe(650)
  })

  it('rounds up rather than to nearest', () => {
    // 0.75% of 13,333 is 99.9975. ESIC takes 100, not 99.
    const result = computeEsi({ ...RATES, grossPaid: 13_333, covered: true })
    expect(result.employee).toBe(100)

    // 3.25% of 13,333 is 433.32. Up to 434.
    expect(result.employer).toBe(434)
  })

  it('contributes nothing when not covered', () => {
    const result = computeEsi({ ...RATES, grossPaid: 20_000, covered: false })
    expect(result).toEqual({ employee: 0, employer: 0 })
  })

  it('keeps contributing to somebody whose wages rose mid-period', () => {
    // The locked-coverage rule. Their gross is now above the threshold and
    // they are STILL covered, because the period decided it in April.
    const result = computeEsi({ ...RATES, grossPaid: 25_000, covered: true })

    expect(result.employee).toBeGreaterThan(0)
    // The current code re-tests every month (Payroll.jsx:23) and would drop
    // them here — producing an employee who drifts in and out of ESI.
    expect(result.employee).toBe(188)
  })
})

describe('professional tax', () => {
  /** Maharashtra, as the guide sets out. */
  const MAHARASHTRA: PtSlabRule[] = [
    { state: 'Maharashtra', gender: 'male', wageFrom: 0, wageTo: 7_500, amount: 0 },
    { state: 'Maharashtra', gender: 'male', wageFrom: 7_500.01, wageTo: 10_000, amount: 175 },
    {
      state: 'Maharashtra',
      gender: 'male',
      wageFrom: 10_000.01,
      wageTo: null,
      amount: 200,
      februaryAmount: 300,
    },
    { state: 'Maharashtra', gender: 'female', wageFrom: 0, wageTo: 25_000, amount: 0 },
    {
      state: 'Maharashtra',
      gender: 'female',
      wageFrom: 25_000.01,
      wageTo: null,
      amount: 200,
      februaryAmount: 300,
    },
  ]

  const forMan = (gross: number, month = 6) =>
    computePt({ state: 'Maharashtra', gender: 'male', gross, month, slabs: MAHARASHTRA })

  const forWoman = (gross: number, month = 6) =>
    computePt({ state: 'Maharashtra', gender: 'female', gross, month, slabs: MAHARASHTRA })

  it('charges nothing below the first slab', () => {
    expect(forMan(7_000)).toBe(0)
  })

  it('charges the middle slab', () => {
    expect(forMan(9_000)).toBe(175)
  })

  it('charges the top slab', () => {
    expect(forMan(30_000)).toBe(200)
  })

  it('charges ₹300 in February', () => {
    // Eleven months at 200 plus one at 300 is exactly 2,500 — which is how the
    // state reaches the annual cap without a fractional monthly figure.
    expect(forMan(30_000, 2)).toBe(300)
  })

  it('exempts women up to ₹25,000', () => {
    // Applying the men's slab to them over-deducts ₹200 every month. Nobody
    // notices for a year, and then somebody does.
    expect(forWoman(20_000)).toBe(0)
    expect(forMan(20_000)).toBe(200)
  })

  it('charges women above their threshold', () => {
    expect(forWoman(30_000)).toBe(200)
    expect(forWoman(30_000, 2)).toBe(300)
  })

  it('NEVER exceeds the constitutional annual cap', () => {
    // Article 276 caps professional tax at ₹2,500 a year per person in every
    // state. A slab table that can produce more is a data entry error, not a
    // novel tax — and this is the invariant that catches it.
    for (const gross of [0, 7_500, 9_000, 15_000, 30_000, 100_000]) {
      for (const gender of ['male', 'female'] as const) {
        const total = annualPt({ state: 'Maharashtra', gender, gross, slabs: MAHARASHTRA })
        expect(total, `${gender} on ${gross}`).toBeLessThanOrEqual(PT_ANNUAL_CAP)
      }
    }
  })

  it('reaches exactly the cap for the top slab', () => {
    expect(annualPt({ state: 'Maharashtra', gender: 'male', gross: 30_000, slabs: MAHARASHTRA }))
      .toBe(PT_ANNUAL_CAP)
  })

  it('charges nothing for a state nobody has configured', () => {
    // Zero, and the caller is expected to notice. Inventing a figure for an
    // unconfigured state would be worse than a visible nothing.
    expect(
      computePt({ state: 'Karnataka', gender: 'male', gross: 30_000, month: 6, slabs: MAHARASHTRA }),
    ).toBe(0)
  })

  it('charges nothing when the employee has no state recorded', () => {
    expect(
      computePt({ state: null, gender: 'male', gross: 30_000, month: 6, slabs: MAHARASHTRA }),
    ).toBe(0)
  })
})

describe('keeping a PT table', () => {
  it('accepts Maharashtra as the state writes it', () => {
    expect(ptTableProblems([
      { gender: 'male', from: 0, amount: 0 },
      { gender: 'male', from: 7500.01, amount: 175 },
      { gender: 'male', from: 10000.01, amount: 200, februaryAmount: 300 },
      { gender: 'female', from: 0, amount: 0 },
      { gender: 'female', from: 25000.01, amount: 200, februaryAmount: 300 },
    ])).toEqual([])
  })

  it('refuses a table that would take more than ₹2,500 a year', () => {
    // ₹250 a month is ₹3,000 a year. A data-entry slip, not a new tax.
    const problems = ptTableProblems([{ gender: 'any', from: 0, amount: 250 }])
    expect(problems.join(' ')).toMatch(/capped at ₹2500/)
    // And February counts: 11 × 200 + 400 is 2,600.
    expect(ptTableProblems([{ gender: 'any', from: 0, amount: 200, februaryAmount: 400 }])).not.toEqual([])
  })

  it('insists every table starts at zero', () => {
    expect(ptTableProblems([{ gender: 'any', from: 10000, amount: 200 }]).join(' ')).toMatch(/start at ₹0/)
  })

  it('refuses men without women, which would charge women nothing', () => {
    expect(ptTableProblems([{ gender: 'male', from: 0, amount: 200 }]).join(' ')).toMatch(/go together/)
  })

  it('refuses two slabs starting at the same amount', () => {
    expect(ptTableProblems([
      { gender: 'any', from: 0, amount: 0 },
      { gender: 'any', from: 0, amount: 200 },
    ]).join(' ')).toMatch(/same amount/)
  })

  it('stores upper bounds one paisa below the next slab, so there is no gap', () => {
    const rows = ptTableRows([
      { gender: 'any', from: 25000, amount: 200 },
      { gender: 'any', from: 0, amount: 0 },
    ])
    expect(rows).toEqual([
      { gender: 'any', wageFrom: 0, wageTo: 24999.99, amount: 0, februaryAmount: null },
      { gender: 'any', wageFrom: 25000, wageTo: null, amount: 200, februaryAmount: null },
    ])
  })
})
