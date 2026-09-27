/**
 * Arithmetic over a whole payroll run.
 *
 * The run's totals are the sum of its payslips and nothing else — never
 * recalculated from salaries, which could disagree with what the payslips say.
 */

export interface PayslipTotals {
  grossEarnings: number
  totalDeductions: number
  netPayable: number
  employerPf: number
  employerEsi: number
}

const paise = (value: number) => Math.round(value * 100) / 100

/** Added to the paisa at every step, so a hundred payslips cannot drift. */
export function runTotals(payslips: readonly PayslipTotals[]): PayslipTotals & { employeeCount: number } {
  const totals: PayslipTotals = {
    grossEarnings: 0,
    totalDeductions: 0,
    netPayable: 0,
    employerPf: 0,
    employerEsi: 0,
  }

  for (const slip of payslips) {
    totals.grossEarnings = paise(totals.grossEarnings + slip.grossEarnings)
    totals.totalDeductions = paise(totals.totalDeductions + slip.totalDeductions)
    totals.netPayable = paise(totals.netPayable + slip.netPayable)
    totals.employerPf = paise(totals.employerPf + slip.employerPf)
    totals.employerEsi = paise(totals.employerEsi + slip.employerEsi)
  }

  return { ...totals, employeeCount: payslips.length }
}
