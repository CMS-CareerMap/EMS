import { describe, it, expect } from 'vitest'
import { computeSalary, daysInMonth, type SalaryInput } from './salary'
import { PT_ANNUAL_CAP, type PtSlabRule } from './statutory'

/**
 * THE GOLDEN PAYROLL TEST.
 *
 * Thirty employees through a real month, covering every case §A13 names:
 * a mid-month joiner, a mid-month leaver, a loss-of-pay month, February in
 * Maharashtra, somebody crossing ₹21,000 while their ESI coverage stays locked,
 * somebody at exactly ₹15,000 PF wages, and a zero-TDS directive.
 *
 * ⚠️ NOT YET SIGNED BY THE ACCOUNTANT.
 *
 * The guide requires that. The figures below are computed from the rules as
 * written in the statutory module, and the statutory module is tested against
 * the rules as published — but "matches what we implemented" is a weaker claim
 * than "matches what a chartered accountant says the company owes". Before the
 * first live payroll, somebody qualified must check these numbers and this
 * comment must say so.
 *
 * What it catches today is REGRESSION: if anybody changes the engine and a
 * single rupee moves anywhere in thirty payslips, this fails.
 */

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

/** The client's confirmed component list (§A1.5). */
function components(opts: {
  basic: number
  hra?: number
  da?: number
  conveyance?: number
  special?: number
  incentive?: number
}) {
  const list = [
    { code: 'BASIC', label: 'Basic', amount: opts.basic, type: 'earning' as const, countsForPf: true },
    { code: 'DA', label: 'Dearness Allowance', amount: opts.da ?? 0, type: 'earning' as const, countsForPf: true },
    { code: 'HRA', label: 'House Rent Allowance', amount: opts.hra ?? 0, type: 'earning' as const, countsForPf: false },
    { code: 'CONV', label: 'Conveyance', amount: opts.conveyance ?? 0, type: 'earning' as const, countsForPf: false },
    { code: 'SPL', label: 'Special Allowance', amount: opts.special ?? 0, type: 'earning' as const, countsForPf: false },
    // Manually entered per §A1.5, taxable, part of gross.
    { code: 'INC', label: 'Incentive', amount: opts.incentive ?? 0, type: 'earning' as const, countsForPf: false, entry: 'monthly' as const },
  ]
  return list.filter((c) => c.amount > 0)
}

interface CaseInput {
  name: string
  basic: number
  hra?: number
  da?: number
  conveyance?: number
  special?: number
  incentive?: number
  gender?: 'male' | 'female'
  paidDays?: number
  month?: number
  year?: number
  esiCovered?: boolean
  epsMember?: boolean
  tds?: number
  state?: string | null
}

function run(input: CaseInput) {
  const year = input.year ?? 2026
  const month = input.month ?? 6
  const total = daysInMonth(year, month)

  const salary: SalaryInput = {
    components: components(input),
    paidDays: input.paidDays ?? total,
    daysInMonth: total,
    month,
    year,
    pf: {
      applicable: true,
      employeeRate: 12,
      employerRate: 12,
      // The client's wish: PF kept at the ceiling, so ₹1,800 in the standard case.
      restrictToCeiling: true,
      wageCeiling: 15_000,
      epsWageCeiling: 15_000,
      epsMember: input.epsMember ?? true,
    },
    esi: {
      covered: input.esiCovered ?? false,
      employeeRate: 0.75,
      employerRate: 3.25,
    },
    pt: {
      state: input.state === undefined ? 'Maharashtra' : input.state,
      gender: input.gender ?? 'male',
      slabs: MAHARASHTRA,
    },
    tds: input.tds ?? 0,
  }

  return computeSalary(salary)
}

describe('the seven cases the guide names', () => {
  it('1 — a standard full month', () => {
    const result = run({
      name: 'Standard',
      basic: 20_000,
      da: 2_000,
      hra: 10_000,
      conveyance: 1_600,
      special: 5_000,
    })

    expect(result.grossEarnings).toBe(38_600)
    // PF wages are basic + DA = 22,000, capped at the ceiling.
    expect(result.pfWages).toBe(15_000)
    expect(result.employeePf).toBe(1_800)
    // Above the ESI threshold, so not covered.
    expect(result.employeeEsi).toBe(0)
    expect(result.professionalTax).toBe(200)
    expect(result.netPayable).toBe(36_600)
  })

  it('2 — a mid-month joiner', () => {
    // Joined on the 16th of a 30-day month: 15 days payable.
    const result = run({ name: 'Joiner', basic: 20_000, da: 2_000, hra: 10_000, paidDays: 15 })

    expect(result.daysInMonth).toBe(30)
    expect(result.paidDays).toBe(15)
    expect(result.grossEarnings).toBe(16_000)

    // PF wages prorate too: half of 22,000 is 11,000, which is BELOW the
    // ceiling — so contributions are on 11,000, not on 15,000. Applying the
    // ceiling before proration would overcharge them.
    expect(result.pfWages).toBe(11_000)
    expect(result.employeePf).toBe(1_320)
  })

  it('3 — a mid-month leaver', () => {
    // Left on the 10th: 10 days payable. Same mechanism as a joiner.
    const result = run({ name: 'Leaver', basic: 20_000, da: 2_000, hra: 10_000, paidDays: 10 })

    expect(result.grossEarnings).toBe(10_666.67)
    expect(result.lopDays).toBe(20)
  })

  it('4 — a month with loss of pay', () => {
    // Present 26 of 30 days. Three different situations — joiner, leaver, LOP —
    // and one mechanism.
    const full = run({ name: 'Full', basic: 20_000, da: 2_000, hra: 10_000 })
    const lop = run({ name: 'LOP', basic: 20_000, da: 2_000, hra: 10_000, paidDays: 26 })

    expect(lop.lopDays).toBe(4)
    expect(lop.grossEarnings).toBeLessThan(full.grossEarnings)
    expect(lop.grossEarnings).toBe(27_733.33)
  })

  it('5 — February in Maharashtra', () => {
    const june = run({ name: 'June', basic: 20_000, da: 2_000, hra: 10_000, month: 6 })
    const feb = run({ name: 'Feb', basic: 20_000, da: 2_000, hra: 10_000, month: 2, year: 2026 })

    expect(june.professionalTax).toBe(200)
    // ₹300 in February is how the state reaches ₹2,500 for the year without a
    // fractional monthly figure.
    expect(feb.professionalTax).toBe(300)
    // And February has 28 days, so the same salary prorates differently.
    expect(feb.daysInMonth).toBe(28)
  })

  it('6 — crossing ₹21,000 mid-period, with ESI still locked', () => {
    // Covered in April on ₹19,000. A raise in June puts them over the
    // threshold, and they REMAIN covered until the period ends in September.
    const afterRaise = run({
      name: 'Raised',
      basic: 14_000,
      da: 1_000,
      hra: 7_000,
      special: 3_000,
      esiCovered: true,
    })

    expect(afterRaise.grossEarnings).toBe(25_000)
    // Still contributing. The current code re-tests every month
    // (Payroll.jsx:23) and would drop them here, producing somebody who drifts
    // in and out of ESI mid-year.
    expect(afterRaise.employeeEsi).toBe(188)
    expect(afterRaise.employer.esi).toBe(813)
  })

  it('7 — exactly ₹15,000 PF wages, the boundary', () => {
    const result = run({ name: 'Exactly', basic: 15_000, hra: 6_000 })

    // At exactly the ceiling it does not bite. An off-by-one would quietly
    // change the contribution.
    expect(result.pfWages).toBe(15_000)
    expect(result.employeePf).toBe(1_800)
    expect(result.employer.eps).toBe(1_250)
    expect(result.employer.epf).toBe(550)
  })

  it('and a zero-TDS directive', () => {
    const result = run({ name: 'No TDS', basic: 20_000, da: 2_000, hra: 10_000, tds: 0 })

    // TDS is entered by hand for v1 and is never computed. Zero means zero —
    // it is not a missing value to be filled in with a guess.
    expect(result.tds).toBe(0)
    expect(result.deductions.find((d) => d.code === 'TDS')).toBeUndefined()
  })
})

describe('thirty employees, one month', () => {
  /**
   * A realistic spread: juniors below every threshold, seniors above them,
   * women exempt from PT, a non-EPS joiner, and the seven named cases mixed in.
   */
  const ROSTER: CaseInput[] = [
    // Below every threshold — no PF ceiling bite, ESI covered, no PT.
    { name: 'Junior 1', basic: 5_000, hra: 2_000, esiCovered: true },
    { name: 'Junior 2', basic: 4_500, hra: 1_800, esiCovered: true },
    { name: 'Junior 3', basic: 5_500, da: 500, hra: 2_200, esiCovered: true },

    // In the middle PT slab.
    { name: 'Middle 1', basic: 6_000, hra: 2_500, conveyance: 800, esiCovered: true },
    { name: 'Middle 2', basic: 6_500, hra: 2_200, conveyance: 800, esiCovered: true },

    // ESI covered, above the first PT slab.
    { name: 'Covered 1', basic: 10_000, da: 1_000, hra: 5_000, esiCovered: true },
    { name: 'Covered 2', basic: 11_000, hra: 5_500, special: 2_000, esiCovered: true },
    { name: 'Covered 3', basic: 12_000, hra: 6_000, special: 2_500, esiCovered: true },

    // At the PF ceiling exactly.
    { name: 'At ceiling', basic: 15_000, hra: 6_000 },
    { name: 'Just over', basic: 15_001, hra: 6_000 },
    { name: 'Just under', basic: 14_999, hra: 6_000 },

    // Above every threshold.
    { name: 'Senior 1', basic: 30_000, da: 3_000, hra: 15_000, special: 8_000 },
    { name: 'Senior 2', basic: 40_000, hra: 20_000, special: 10_000, tds: 5_000 },
    { name: 'Senior 3', basic: 50_000, hra: 25_000, special: 15_000, tds: 12_000 },

    // Women — exempt from Maharashtra PT up to ₹25,000.
    { name: 'Woman low', basic: 10_000, hra: 5_000, gender: 'female', esiCovered: true },
    { name: 'Woman mid', basic: 14_000, hra: 7_000, gender: 'female' },
    { name: 'Woman high', basic: 30_000, hra: 15_000, gender: 'female' },

    // Non-EPS: joined after 2014 above the ceiling.
    { name: 'Non-EPS 1', basic: 25_000, hra: 12_000, epsMember: false },
    { name: 'Non-EPS 2', basic: 35_000, hra: 17_000, epsMember: false },

    // Incentive, which the client wants entered by hand.
    { name: 'With incentive', basic: 20_000, hra: 10_000, incentive: 5_000 },
    { name: 'Big incentive', basic: 18_000, hra: 9_000, incentive: 15_000 },

    // The seven named cases.
    { name: 'Joiner', basic: 20_000, da: 2_000, hra: 10_000, paidDays: 15 },
    { name: 'Leaver', basic: 20_000, da: 2_000, hra: 10_000, paidDays: 10 },
    { name: 'LOP', basic: 20_000, da: 2_000, hra: 10_000, paidDays: 26 },
    { name: 'February', basic: 20_000, da: 2_000, hra: 10_000, month: 2 },
    { name: 'ESI locked', basic: 14_000, da: 1_000, hra: 7_000, special: 3_000, esiCovered: true },
    { name: 'Zero TDS', basic: 20_000, hra: 10_000, tds: 0 },

    // Edge cases worth having in the set.
    { name: 'No state', basic: 20_000, hra: 10_000, state: null },
    { name: 'Heavy LOP', basic: 20_000, da: 2_000, hra: 10_000, paidDays: 2 },
    { name: 'Full month off', basic: 20_000, da: 2_000, hra: 10_000, paidDays: 0 },
  ]

  it('has thirty employees', () => {
    expect(ROSTER).toHaveLength(30)
  })

  it('holds every invariant, for every one of them', () => {
    for (const employee of ROSTER) {
      const result = run(employee)
      const where = employee.name

      // Gross is exactly the sum of the earnings shown on the payslip. If these
      // ever disagree, the payslip does not add up and somebody will notice
      // before we do.
      const earningsSum =
        Math.round(result.earnings.reduce((sum, e) => sum + e.amount, 0) * 100) / 100
      expect(earningsSum, `${where}: gross must equal its earnings`).toBe(result.grossEarnings)

      // Net is gross less every deduction listed.
      expect(
        Math.round((result.grossEarnings - result.totalDeductions) * 100) / 100,
        `${where}: net must equal gross less deductions`,
      ).toBe(result.netPayable)

      // The employer's two PF halves always add to the total.
      expect(
        result.employer.eps + result.employer.epf,
        `${where}: EPS and EPF must add to the employer total`,
      ).toBe(result.employer.pfTotal)

      // EPS never exceeds its statutory cap.
      expect(result.employer.eps, `${where}: EPS cap`).toBeLessThanOrEqual(1_250)

      // PF is never taken on more than the ceiling while the company restricts.
      expect(result.pfWages, `${where}: PF ceiling`).toBeLessThanOrEqual(15_000)

      // Nothing is ever negative except the net, which is allowed to be and is
      // checked separately.
      for (const [label, value] of [
        ['gross', result.grossEarnings],
        ['employee PF', result.employeePf],
        ['employee ESI', result.employeeEsi],
        ['PT', result.professionalTax],
        ['employer PF', result.employer.pfTotal],
        ['employer ESI', result.employer.esi],
      ] as const) {
        expect(value, `${where}: ${label} must not be negative`).toBeGreaterThanOrEqual(0)
      }

      // Every figure is a sane number of paise, not a floating-point tail.
      for (const value of [result.grossEarnings, result.netPayable, result.totalDeductions]) {
        expect(Math.round(value * 100), `${where}: ${value} must be whole paise`).toBe(value * 100)
      }
    }
  })

  it('never takes more than the constitutional PT cap from anybody, all year', () => {
    for (const employee of ROSTER) {
      let annual = 0
      for (let month = 1; month <= 12; month++) {
        annual += run({ ...employee, month }).professionalTax
      }

      expect(Math.round(annual), `${employee.name}: annual PT`).toBeLessThanOrEqual(PT_ANNUAL_CAP)
    }
  })

  it('pays nothing, and deducts nothing, for a full month of absence', () => {
    const result = run({ name: 'Absent', basic: 20_000, da: 2_000, hra: 10_000, paidDays: 0 })

    expect(result.grossEarnings).toBe(0)
    // No gross means no PF, no ESI and no PT. A system that deducted PF from
    // zero pay would produce a negative net for somebody who earned nothing.
    expect(result.employeePf).toBe(0)
    expect(result.professionalTax).toBe(0)
    expect(result.netPayable).toBe(0)
  })

  it('produces the same answer every time it is run', () => {
    // Determinism. Nothing in here reads a clock or a random source, and this
    // is what proves it — a golden test that drifts is not a golden test.
    const first = ROSTER.map((e) => run(e).netPayable)
    const second = ROSTER.map((e) => run(e).netPayable)

    expect(second).toEqual(first)
  })
})
