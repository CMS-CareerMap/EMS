/**
 * Income tax deducted at source — manual mode, for v1.
 *
 * Nothing here computes tax. The accountant decides each employee's monthly
 * deduction and records it as a directive; this finds the one that applies to
 * a month. A computed engine with declarations and Form 16 is out of scope
 * (guide, Day 16), and naming that here is how nobody assumes it exists.
 */

/**
 * The income-tax year runs April to March, whatever the company's own
 * reporting year is — it is the Income Tax Act's year, not a setting.
 */
const FIRST_MONTH_OF_TAX_YEAR = 4

/** The financial year a payroll month belongs to, by the year it starts in. */
export function financialYearOf(year: number, month: number): number {
  return month >= FIRST_MONTH_OF_TAX_YEAR ? year : year - 1
}

/** 2026 → "2026-27". */
export function financialYearLabel(financialYear: number): string {
  return `${financialYear}-${String((financialYear + 1) % 100).padStart(2, '0')}`
}

/** The first payroll month of a financial year: 2026 → April 2026. */
export function firstMonthOf(financialYear: number): { year: number; month: number } {
  return { year: financialYear, month: FIRST_MONTH_OF_TAX_YEAR }
}

/**
 * The directive in force for a month: the latest one of that month's financial
 * year that had started by then.
 *
 * Never one from an earlier year. Tax is an annual calculation, and carrying
 * March's figure into April would deduct last year's answer from this year's
 * salary until somebody noticed.
 */
export function directiveFor<T extends { financialYear: number; effectiveFrom: string }>(
  directives: readonly T[],
  year: number,
  month: number,
): T | null {
  const financialYear = financialYearOf(year, month)
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`

  let found: T | null = null
  for (const directive of directives) {
    if (directive.financialYear !== financialYear) continue
    if (directive.effectiveFrom > monthStart) continue
    if (!found || directive.effectiveFrom > found.effectiveFrom) found = directive
  }
  return found
}
