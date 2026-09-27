import { describe, it, expect } from 'vitest'
import { financialYearOf, financialYearLabel, firstMonthOf, directiveFor } from './tds'
import { runTotals } from './run'

describe('the financial year a payroll month belongs to', () => {
  it('runs April to March', () => {
    expect(financialYearOf(2026, 4)).toBe(2026)
    expect(financialYearOf(2026, 12)).toBe(2026)
    expect(financialYearOf(2027, 1)).toBe(2026)
    expect(financialYearOf(2027, 3)).toBe(2026)
    expect(financialYearOf(2026, 3)).toBe(2025)
  })

  it('is named the way people write it', () => {
    expect(financialYearLabel(2026)).toBe('2026-27')
    expect(financialYearLabel(2099)).toBe('2099-00')
    expect(firstMonthOf(2026)).toEqual({ year: 2026, month: 4 })
  })
})

describe('which TDS directive applies to a month', () => {
  const d = (financialYear: number, effectiveFrom: string, monthlyAmount: number) => ({
    financialYear,
    effectiveFrom,
    monthlyAmount,
  })

  it('is the latest one that had started by then', () => {
    const directives = [d(2026, '2026-04-01', 1_000), d(2026, '2026-09-01', 2_500)]
    expect(directiveFor(directives, 2026, 8)?.monthlyAmount).toBe(1_000)
    expect(directiveFor(directives, 2026, 9)?.monthlyAmount).toBe(2_500)
    expect(directiveFor(directives, 2027, 3)?.monthlyAmount).toBe(2_500)
  })

  it('is none before the first one starts', () => {
    expect(directiveFor([d(2026, '2026-09-01', 2_500)], 2026, 8)).toBeNull()
  })

  it('never carries into the next financial year', () => {
    // March's figure is last year's answer. April needs a decision of its own.
    expect(directiveFor([d(2026, '2026-04-01', 1_000)], 2027, 4)).toBeNull()
  })

  it('counts an explicit zero as a directive', () => {
    expect(directiveFor([d(2026, '2026-04-01', 0)], 2026, 6)).toEqual(d(2026, '2026-04-01', 0))
  })
})

describe('run totals', () => {
  it('adds payslips to the paisa, without floating-point drift', () => {
    const slip = { grossEarnings: 0.1, totalDeductions: 0.2, netPayable: -0.1, employerPf: 0.3, employerEsi: 0.7 }
    const totals = runTotals(Array.from({ length: 10 }, () => slip))
    expect(totals).toEqual({
      grossEarnings: 1,
      totalDeductions: 2,
      netPayable: -1,
      employerPf: 3,
      employerEsi: 7,
      employeeCount: 10,
    })
  })

  it('is zero for no payslips', () => {
    expect(runTotals([]).employeeCount).toBe(0)
  })
})
